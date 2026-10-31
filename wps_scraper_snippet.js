/**
 * WPS便签全自动分类导出助手 v5.3 (正文去重题、数字零与符号防转义纯净版)
 * 
 * 核心升级与修复：
 * 1. 【彻底解决重复标题】正文首行不再拼接与文件名重复的一级标题，原生纯净排版，完美兼容 Obsidian/Notion。
 * 2. 【彻底修复数字0及特殊转义】修复 WPS 导出富文本将数字 0 误转义为 \0（身份证、学号、金额、日期），并清理多余的 \[、\]、\*、\~、\# 等反斜杠乱码。
 * 3. 【彻底解决图片丢失】解除浏览器 CORS 限制：前端提取 S3 原图签名链接后直通本地 Python 接收器，本地后端零阻碍高速下载并落地到「分类/附件/」目录！
 * 4. 【彻底解决正文缺失】增加接口防抖重试机制 (Retry with Backoff)，并建立三级正文智能兜底。
 * 5. 【S3超长文章解密】全面兼容 bodyType: 1 的超长便签二进制流转码解密。
 * 6. 【规范相对路径】正文中图片语法严格改写为 ![](附件/xxx.jpg)，任意目录迁移均可完美渲染。
 * 7. 【智能精炼标题】自动提取合适短标题，自动规避标点截断，彻底移除创建/更新时间等杂乱元数据。
 *
 * 使用方法：
 * 1. 确保本地接收服务正在运行 (python local_receiver.py)
 * 2. 在 WPS 便签网页版 (https://note.wps.cn) 页面按 F12 打开控制台 (Console)
 * 3. 粘贴本脚本全部代码，回车运行即可！
 */
(async function runWpsScraperV5_3() {
  console.log("%c[WPS便签导出助手 v5.3] 启动中...", "color: #1890ff; font-weight: bold; font-size: 14px;");

  // 1. 创建页面浮动状态提示面板
  let statusPanel = document.getElementById('wps-exporter-panel');
  if (!statusPanel) {
    statusPanel = document.createElement('div');
    statusPanel.id = 'wps-exporter-panel';
    statusPanel.style.cssText = `
      position: fixed; top: 20px; right: 20px; width: 450px; max-height: 620px;
      background: rgba(255, 255, 255, 0.98); border-radius: 12px;
      box-shadow: 0 8px 32px rgba(0,0,0,0.28); z-index: 999999;
      font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, "PingFang SC", "Microsoft YaHei", sans-serif;
      padding: 18px; box-sizing: border-box; border: 1px solid #d0d7de;
    `;
    document.body.appendChild(statusPanel);
  }

  function updateStatus(title, message, progress = -1) {
    statusPanel.innerHTML = `
      <div style="font-size: 16px; font-weight: bold; color: #1f2328; margin-bottom: 8px; display: flex; align-items: center; justify-content: space-between;">
        <span>📝 WPS便签导出助手</span>
        <span style="font-size: 12px; font-weight: 600; color: #0969da; background: #ddf4ff; padding: 2px 8px; border-radius: 12px;">v5.2 增强版</span>
      </div>
      <div style="font-size: 14px; font-weight: 600; color: #0969da; margin-bottom: 6px;">${title}</div>
      <div style="font-size: 12px; color: #656d76; line-height: 1.5; margin-bottom: 10px; max-height: 80px; overflow-y: auto;">${message}</div>
      ${progress >= 0 ? `
        <div style="width: 100%; background: #eaeef2; border-radius: 6px; height: 8px; overflow: hidden; margin-bottom: 6px;">
          <div style="width: ${Math.min(100, Math.max(0, progress))}%; background: #2da44e; height: 100%; transition: width 0.2s;"></div>
        </div>
        <div style="text-align: right; font-size: 11px; color: #8c959f;">总进度: ${progress.toFixed(0)}%</div>
      ` : ''}
      <div id="wps-log-box" style="margin-top: 10px; background: #f6f8fa; border-radius: 6px; padding: 8px; font-size: 11px; color: #24292f; max-height: 200px; overflow-y: auto; line-height: 1.6; font-family: monospace;"></div>
    `;
  }

  function addLog(msg, isWarn = false) {
    const logBox = document.getElementById('wps-log-box');
    if (logBox) {
      const line = document.createElement('div');
      line.style.color = isWarn ? '#cf222e' : '#24292f';
      line.textContent = `[${new Date().toLocaleTimeString()}] ${msg}`;
      logBox.appendChild(line);
      logBox.scrollTop = logBox.scrollHeight;
    }
    console.log(`[WPS导出] ${msg}`);
  }

  updateStatus('初始化中...', '正在分析便签模块、解密器及图片下载接口...', 0);

  const routeEl = document.querySelector('#route') || document.querySelector('#app');
  const rootVue = routeEl ? routeEl.__vue__ : null;
  const store = rootVue ? rootVue.$store : null;

  if (!store) {
    alert('未能找到便签数据模块，请确认在 note.wps.cn 网页内运行。');
    return;
  }

  const delay = ms => new Promise(res => setTimeout(res, ms));

  function sanitizeName(name) {
    return (name || '未命名')
      .replace(/[\\/*?:"<>|]/g, '_')
      .replace(/\s+/g, ' ')
      .trim() || '未命名';
  }

  // 深度文本清洗器：解决数字 0 转义、Markdown 符号误转义及首行重复一级标题问题
  function cleanMarkdownText(content, title) {
    if (!content) return '';
    let s = content;
    // 1. 彻底修复数字 0 被误转义为 \0 的问题（身份证、学号、金额、日期等）
    s = s.replace(/\\0/g, '0');
    // 2. 清理常见被 WPS 误加反斜杠转义的 Markdown 标点符号
    s = s.replace(/\\\[/g, '[').replace(/\\\]/g, ']');
    s = s.replace(/\\\*/g, '*').replace(/\\~/g, '~');
    s = s.replace(/\\#/g, '#');
    // 3. 彻底移除首行与文件名重复的一级标题（如 # 标题）及紧随其后的空白行
    const lines = s.split('\n');
    if (lines.length > 0) {
      const firstLine = lines[0].trim();
      if (firstLine.startsWith('# ')) {
        lines.shift();
        while (lines.length > 0 && lines[0].trim() === '') {
          lines.shift();
        }
        s = lines.join('\n');
      }
    }
    return s.trim();
  }

  // 2. 挂载 Webpack 核心模块 (原生 AES 解密器 4eb3 与 图片签名下载模块 99ba)
  let decryptor = null;
  let imgModule = null;
  let userId = null;

  try {
    let req;
    window["webpackJsonp"].push([
      ['__wps_export_probe__'],
      { '__wps_export_probe__': (m, e, r) => { req = r; } },
      [['__wps_export_probe__']]
    ]);
    if (req) {
      const mod = req('4eb3') || req('15e0');
      decryptor = mod && (mod.a || mod);
      imgModule = req('99ba');
    }
  } catch (e) {
    addLog(`Webpack 模块探测提示: ${e.message}`);
  }

  // 获取当前用户 ID
  try {
    userId = (store.state.user && (store.state.user.userid || store.state.user.userId || store.state.user.id)) ||
             (rootVue && (rootVue.userId || rootVue.userid));
    if (!userId) {
      const cookieMatch = document.cookie.match(/(?:wps_sid|userid|uid)=(\d+)/);
      if (cookieMatch) userId = cookieMatch[1];
    }
  } catch (e) {}

  if (decryptor) {
    addLog('🔐 成功挂载 WPS 原生解密组件');
  } else {
    addLog('⚠️ 警告：未能挂载到 AES 解密器，可能影响部分加密正文', true);
  }

  if (imgModule && typeof imgModule.e === 'function') {
    addLog('🖼️ 成功挂载 WPS 原生图片签名模块 (99ba)');
  }

  // 3. 智能标题生成器：提取凝练、合适的主题，过滤图片语法，避免整句当标题
  function getSmartTitle(rawTitle, bodyText) {
    rawTitle = (rawTitle || '').replace(/\\0/g, '0').replace(/\\\[/g, '[').replace(/\\\]/g, ']').trim();
    bodyText = (bodyText || '').replace(/\\0/g, '0').trim();

    // 如果标题是 [图片] 且正文含图片
    if (rawTitle === '[图片]' || rawTitle === '图片') {
      return '图片便签';
    }

    // 如果本身有简短、像标题的命名（<= 18字且不含逗号句号等整句标点，且不是图片语法）
    if (rawTitle && rawTitle.length <= 18 && !/[，。！？；\n]/.test(rawTitle) && !rawTitle.startsWith('![') && !rawTitle.startsWith('<img') && rawTitle !== '未命名') {
      const clean = sanitizeName(rawTitle);
      if (clean && clean !== '未命名') return clean;
    }

    // 从正文提取第一行有效文本（跳过图片标签、空行、特殊符号）
    let firstLine = '';
    const lines = (bodyText || rawTitle).split('\n');
    for (const line of lines) {
      let cleaned = line.replace(/^[#\s\-*]+/g, '').trim();
      // 跳过纯图片行如 ![](notes-...) 或 <img ...>
      if (!cleaned || cleaned.startsWith('![') || cleaned.startsWith('<img') || cleaned.startsWith('http://') || cleaned.startsWith('https://')) {
        continue;
      }
      firstLine = cleaned;
      break;
    }

    // 如果正文没有任何纯文字（纯图片便签）
    if (!firstLine) {
      if (bodyText.includes('![') || bodyText.includes('<img')) {
        return '图片便签';
      }
      return '便签随笔';
    }

    // 匹配日期开头（如 26.7.5、2025.12.26、2026-03-24 等）
    const dateMatch = firstLine.match(/^(\d{2,4}[\.\-\/]\d{1,2}[\.\-\/]\d{1,2})/);
    let datePrefix = dateMatch ? (dateMatch[1] + ' ') : '';
    let contentNoDate = dateMatch ? firstLine.slice(dateMatch[0].length).trim() : firstLine;
    contentNoDate = contentNoDate.replace(/^[，,：:\s~]+/, '').trim();

    // 语义关键词识别
    let topic = '';
    if (firstLine.includes('生日快乐')) {
      topic = '生日祝福';
    } else if (firstLine.includes('毕业旅行') || firstLine.includes('看日出') || firstLine.includes('看海')) {
      topic = '毕业旅行随笔';
    } else if (firstLine.includes('亲爱') || firstLine.includes('致云') || firstLine.includes('给云')) {
      topic = '致亲爱的云';
    } else if (firstLine.includes('煲汤') || firstLine.includes('熬汤') || firstLine.includes('食谱')) {
      topic = '煲汤食单';
    } else if (firstLine.includes('洗发水')) {
      topic = '洗发水备忘';
    } else if (firstLine.includes('香水')) {
      topic = '香水价格备忘';
    } else if (firstLine.includes('校园卡') || firstLine.includes('学号')) {
      topic = '校园卡学号';
    } else if (firstLine.includes('密码') || firstLine.includes('账号')) {
      topic = '账号密码备忘';
    } else {
      // 截取第一句标点前的短语
      const parts = contentNoDate.split(/[，,。！？；;~…\n\[\]\(\)]/);
      topic = parts[0].trim();
      if (topic.length > 12) {
        topic = topic.slice(0, 12).trim();
      }
    }

    const finalTitle = sanitizeName(datePrefix + (topic || '便签随笔')) || '便签随笔';
    return finalTitle;
  }

  // 4. 多策略图片原图解析器 (提取签名链接 + 尝试本地下载)
  async function resolveImageInfo(rawKey, noteId, suggestedTitle, index) {
    let cleanKey = rawKey.trim().replace(/^\((.*)\)$/, '$1');
    if (!cleanKey) return null;

    if (!userId) {
      const m = cleanKey.match(/notes-(\d+)-/) || cleanKey.match(/notes\/(\d+)\//);
      if (m) userId = m[1];
    }

    const keyCandidates = [
      cleanKey,
      cleanKey.replace(/-/g, '/'),
      cleanKey.replace(/^notes-/, 'notes/').replace(/-([^-]+)$/, '/$1'),
      cleanKey.replace(/\//g, '-')
    ];

    let downloadUrl = null;

    // 策略 1: 使用 WPS 原生 99ba 签名模块 (优先)
    if (imgModule && typeof imgModule.e === 'function') {
      for (const k of keyCandidates) {
        try {
          const res = await imgModule.e(k, noteId, 'pic');
          if (res && res.data && typeof res.data === 'string' && res.data.startsWith('http')) {
            downloadUrl = res.data;
            break;
          }
        } catch (e) {}
      }
    }

    // 策略 2: 直接请求 WPS 下载链接接口
    if (!downloadUrl && userId) {
      for (const k of keyCandidates) {
        try {
          const apiRes = await fetch(`/notesvr/v2/user/${userId}/download/url`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            credentials: 'include',
            body: JSON.stringify({ keys: [k], type: 'pic' })
          });
          const respData = await apiRes.json();
          if (respData && respData.data) {
            const u = typeof respData.data === 'string' ? respData.data : (respData.data[k] || respData.data[0]);
            if (u && typeof u === 'string' && u.startsWith('http')) {
              downloadUrl = u;
              break;
            }
          }
        } catch (e) {}
      }
    }

    // 策略 3: DOM 渲染缓存嗅探
    if (!downloadUrl) {
      const hash = cleanKey.replace(/[^a-zA-Z0-9]/g, '');
      const imgs = document.querySelectorAll('img');
      for (const img of imgs) {
        const src = img.getAttribute('src') || '';
        const nKey = img.getAttribute('noteImgKey') || '';
        if ((nKey && (nKey.includes(cleanKey) || keyCandidates.some(k => nKey.includes(k)))) || 
            (src && hash.length > 10 && src.includes(hash.slice(-16)))) {
          if (src.startsWith('http')) {
            downloadUrl = src;
            break;
          }
        }
      }
    }

    // 策略 4: 本身就是网络链接
    if (!downloadUrl && (cleanKey.startsWith('http://') || cleanKey.startsWith('https://'))) {
      downloadUrl = cleanKey;
    }

    if (!downloadUrl) return null;

    // 确定建议的文件扩展名
    let ext = 'jpg';
    if (cleanKey.toLowerCase().endsWith('.png') || downloadUrl.toLowerCase().includes('.png')) ext = 'png';
    else if (cleanKey.toLowerCase().endsWith('.gif') || downloadUrl.toLowerCase().includes('.gif')) ext = 'gif';
    else if (cleanKey.toLowerCase().endsWith('.webp') || downloadUrl.toLowerCase().includes('.webp')) ext = 'webp';

    const filename = `${suggestedTitle}_${index}.${ext}`;

    // 尝试在浏览器端 fetch blob (用于 ZIP 兜底打包)，若受 CORS 限制失败则保持 blob 为 null
    let blob = null;
    try {
      const blobRes = await fetch(downloadUrl, { mode: 'cors' });
      if (blobRes.ok) {
        blob = await blobRes.blob();
      }
    } catch (corsErr) {
      // 正常的浏览器跨域限制，无需报错，Python 服务端会在本地直接无障碍下载
    }

    return {
      filename,
      url: downloadUrl,
      blob: blob,
      key: cleanKey
    };
  }

  function blobToBase64(blob) {
    return new Promise((resolve, reject) => {
      const reader = new FileReader();
      reader.onloadend = () => resolve(reader.result);
      reader.onerror = reject;
      reader.readAsDataURL(blob);
    });
  }

  async function blobToUint8Array(blob) {
    const buf = await blob.arrayBuffer();
    return new Uint8Array(buf);
  }

  // 5. 正文图片嗅探、批量转发本地下载与相对路径改写
  async function processAndReplaceImages(content, noteId, catSafeName, finalTitle) {
    const imagesForReceiver = [];
    const imagesForZip = [];
    let updatedContent = content;

    // 匹配 WPS Markdown 图片格式：!\[(.*?)\]\(([^)]+)\)(?:\{[^}]*\})?
    const imgRegex = /!\[(.*?)\]\(([^)]+)\)(?:\{[^}]*\})?/g;
    const matches = [];
    let m;
    while ((m = imgRegex.exec(content)) !== null) {
      matches.push({ full: m[0], alt: m[1], rawKey: m[2] });
    }

    if (matches.length === 0) {
      return { updatedContent, imagesForReceiver, imagesForZip };
    }

    addLog(`[${finalTitle}] 发现 ${matches.length} 张图片，正在获取原图链接...`);

    const imageKeyMap = new Map();
    let imgCounter = 0;

    for (const match of matches) {
      const rawKey = match.rawKey.trim();
      if (!imageKeyMap.has(rawKey)) {
        imgCounter++;
        const imgInfo = await resolveImageInfo(rawKey, noteId, finalTitle, imgCounter);
        if (imgInfo && imgInfo.url) {
          imageKeyMap.set(rawKey, imgInfo);
          addLog(`  🖼️ 附件链接就绪: ${imgInfo.filename} (直通本地下载)`);
        } else {
          imageKeyMap.set(rawKey, null);
          addLog(`  ⚠️ 附件获取跳过: ${rawKey.slice(0, 30)}...`, true);
        }
        await delay(40);
      }

      const imgInfo = imageKeyMap.get(rawKey);
      if (imgInfo) {
        // 关键改写：相对路径严格指向分类目录下的「附件」文件夹
        const relMarkdown = `![](附件/${imgInfo.filename})`;
        updatedContent = updatedContent.replace(match.full, relMarkdown);
      }
    }

    for (const [key, info] of imageKeyMap.entries()) {
      if (!info) continue;
      
      const receiverPayload = {
        filename: info.filename,
        url: info.url,
        key: info.key
      };

      if (info.blob) {
        try {
          const b64 = await blobToBase64(info.blob);
          const uint8 = await blobToUint8Array(info.blob);
          receiverPayload.data = b64;
          imagesForZip.push({ name: `${catSafeName}/附件/${info.filename}`, content: uint8, isBinary: true });
        } catch (e) {}
      }

      imagesForReceiver.push(receiverPayload);
    }

    return { updatedContent, imagesForReceiver, imagesForZip };
  }

  // 6. 扫描所有便签分类
  addLog('正在查找全部便签分类...');
  const seenGroupIds = new Set();
  const allCategories = [];

  try { await store.dispatch('getGroups'); } catch (e) {}

  const storeGroups = (store.state.group && store.state.group.groups) ||
                      (store.getters && store.getters.availableGroups) || [];
  for (const g of storeGroups) {
    const gid = g.groupId || g.id;
    const gname = g.groupName || g.name;
    if (gid && !seenGroupIds.has(gid)) {
      seenGroupIds.add(gid);
      allCategories.push({ groupId: gid, groupName: gname });
    }
  }

  document.querySelectorAll('a[href*="/group/"]').forEach(a => {
    const m = a.href.match(/\/group\/([a-zA-Z0-9_-]+)/);
    if (m && m[1] && !seenGroupIds.has(m[1])) {
      const gname = a.innerText.trim() || '未命名分类';
      seenGroupIds.add(m[1]);
      allCategories.push({ groupId: m[1], groupName: gname });
    }
  });

  addLog(`✅ 成功识别到 ${allCategories.length} 个分类：` + allCategories.map(c => c.groupName).join('、'));

  // 7. 探测本地接收服务并初始化
  let localServiceOnline = false;
  try {
    const pingRes = await fetch('http://127.0.0.1:8765/save', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ clean: true, notes: [] })
    });
    const pingData = await pingRes.json();
    if (pingData && pingData.status === 'success') {
      localServiceOnline = true;
      addLog('✅ 本地磁盘直写服务已就绪 (http://127.0.0.1:8765)');
    }
  } catch (err) {}

  const allExtractedNotes = [];
  const processedNoteIds = new Set();
  const zipFiles = [];
  const categoryTitleCounts = {};

  for (let catIdx = 0; catIdx < allCategories.length; catIdx++) {
    const cat = allCategories[catIdx];
    const catPercent = (catIdx / allCategories.length) * 100;
    const catSafeName = sanitizeName(cat.groupName);
    categoryTitleCounts[catSafeName] = categoryTitleCounts[catSafeName] || {};

    updateStatus(`正在处理分类 [${cat.groupName}]`, `进度: ${catIdx + 1} / ${allCategories.length} 个分类`, catPercent);
    addLog(`----------------------------------------`);
    addLog(`>>> 开始处理分类: [${cat.groupName}]`);

    let notesInCat = [];
    let startIndex = 0, rows = 100, hasMore = true;

    while (hasMore) {
      try {
        let webNotes = [];
        try {
          const res = await store.dispatch('getNotesByGroupId', { groupId: cat.groupId, rows, startIndex });
          if (res && res.data && res.data.webNotes) webNotes = res.data.webNotes;
        } catch (dispatchErr) {
          const res = await fetch('/notesvr/web/getnotes/group', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            credentials: 'include',
            body: JSON.stringify({ groupId: cat.groupId, rows, startIndex })
          });
          const respData = await res.json();
          webNotes = (respData && respData.data && respData.data.webNotes) || [];
        }

        if (webNotes.length > 0) {
          notesInCat.push(...webNotes);
          startIndex += rows;
          if (webNotes.length < rows) {
            hasMore = false;
          }
        } else {
          hasMore = false;
        }
      } catch (err) {
        hasMore = false;
      }
      await delay(60);
    }

    addLog(`分类 [${cat.groupName}] 共有 ${notesInCat.length} 篇便签，开始获取正文与附件图片...`);

    const currentCatNotesForSync = [];

    for (let noteIdx = 0; noteIdx < notesInCat.length; noteIdx++) {
      const note = notesInCat[noteIdx];
      const noteId = note.noteId;
      if (processedNoteIds.has(noteId)) continue;
      processedNoteIds.add(noteId);

      let fullContent = '';
      let rawTitle = note.title || '';
      let rawSummary = note.summary || '';

      // 先对列表元数据进行解密
      if (decryptor && rawTitle) {
        const dt = decryptor.decrypt(rawTitle);
        if (dt && dt !== 'decrypt failed') rawTitle = dt;
      }
      if (decryptor && rawSummary) {
        const ds = decryptor.decrypt(rawSummary);
        if (ds && ds !== 'decrypt failed') rawSummary = ds;
      }

      // 获取未截断的完整正文内容（带 3 次防抖重试）
      let rawBody = null;
      let bodyType = 0;

      for (let attempt = 0; attempt < 3; attempt++) {
        try {
          const res = await store.dispatch('getNoteContent', { noteIds: [noteId], shouldUpdateNoteInfo: false });
          if (res && res.data && res.data.noteBodies && res.data.noteBodies.length > 0) {
            const nb = res.data.noteBodies.find(b => b.noteId === noteId) || res.data.noteBodies[0];
            if (nb && (nb.body !== undefined && nb.body !== null)) {
              rawBody = nb.body;
              bodyType = nb.bodyType;
              break;
            }
          }
        } catch (dispatchErr) {}
        await delay(80 * (attempt + 1));
      }

      if (decryptor && rawBody) {
        let dec = decryptor.decrypt(rawBody);
        if (bodyType === 1) { // 存放在 S3 的大便签
          try {
            const s3Res = await store.dispatch('getNoteContentFromS3Server', { key: dec, noteId });
            if (s3Res && s3Res.data) {
              let s3B64 = '';
              if (typeof decryptor.toBase64 === 'function') {
                s3B64 = decryptor.toBase64(s3Res.data);
              } else {
                const bytes = new Uint8Array(s3Res.data);
                let binary = '';
                for (let b = 0; b < bytes.byteLength; b++) binary += String.fromCharCode(bytes[b]);
                s3B64 = btoa(binary);
              }
              const s3Dec = decryptor.decrypt(s3B64);
              if (s3Dec && s3Dec !== 'decrypt failed') {
                dec = s3Dec;
              }
            }
          } catch (s3Err) {
            console.warn('S3 获取失败:', s3Err);
          }
        }
        if (dec && dec !== 'decrypt failed') {
          fullContent = dec;
        }
      }

      // 降级兜底 1: 从 Store 缓存读取
      if (!fullContent && store.state.notes && store.state.notes.all && store.state.notes.all[noteId]) {
        const sn = store.state.notes.all[noteId];
        rawTitle = sn.title || rawTitle;
        fullContent = sn.body || sn.summary || '';
      }
      // 降级兜底 2: 从列表 summary 取
      if (!fullContent && rawSummary) {
        fullContent = rawSummary;
      }
      // 降级兜底 3: 针对手机端随手记、整句存入 title 的便签，全量保留为正文
      if (!fullContent && rawTitle && rawTitle !== '未命名' && rawTitle !== '[图片]') {
        fullContent = rawTitle;
      }

      // 深度清洗：彻底修复 \0、特殊转义符号，并移除首行重复一级标题
      fullContent = cleanMarkdownText(fullContent, rawTitle);
      rawTitle = cleanMarkdownText(rawTitle);

      // 提取凝练、合适的标题
      const smartTitle = getSmartTitle(rawTitle, fullContent);

      let finalTitle = smartTitle;
      if (categoryTitleCounts[catSafeName][smartTitle]) {
        categoryTitleCounts[catSafeName][smartTitle]++;
        finalTitle = `${smartTitle}_${categoryTitleCounts[catSafeName][smartTitle]}`;
      } else {
        categoryTitleCounts[catSafeName][smartTitle] = 1;
      }

      // 下载图片并替换为相对路径
      const { updatedContent, imagesForReceiver, imagesForZip } = await processAndReplaceImages(
        fullContent.trim(),
        noteId,
        catSafeName,
        finalTitle
      );

      // 保持纯净正文，确保无首行重复一级标题与转义乱码
      const finalCleanContent = cleanMarkdownText(updatedContent, finalTitle);
      let mdText = finalCleanContent + '\n';

      const noteItem = {
        group: cat.groupName,
        title: finalTitle,
        content: updatedContent,
        noteId: noteId,
        images: imagesForReceiver
      };

      allExtractedNotes.push(noteItem);
      currentCatNotesForSync.push(noteItem);

      zipFiles.push({ name: `${catSafeName}/${finalTitle}.md`, content: mdText });
      zipFiles.push(...imagesForZip);

      if ((noteIdx + 1) % 5 === 0 || noteIdx === notesInCat.length - 1) {
        addLog(`[${cat.groupName}] 已提取 ${noteIdx + 1}/${notesInCat.length} 篇 (当前: ${finalTitle})`);
      }
      await delay(40);
    }

    if (localServiceOnline && currentCatNotesForSync.length > 0) {
      try {
        await fetch('http://127.0.0.1:8765/save', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ clean: false, notes: currentCatNotesForSync })
        });
        addLog(`💾 [${cat.groupName}] 已同步写入本地磁盘`);
      } catch (err) {}
    }
  }

  // 8. 检查未归类独立便签
  try {
    addLog('正在检查未归类的独立便签...');
    const homeRes = await store.dispatch('getHomeNotes');
    const homeNotes = (homeRes && homeRes.data && homeRes.data.webNotes) || [];
    let uncatNotesForSync = [];

    for (const note of homeNotes) {
      if (!processedNoteIds.has(note.noteId)) {
        processedNoteIds.add(note.noteId);
        let fullContent = '';
        let rawTitle = note.title || '';
        let rawSummary = note.summary || '';

        if (decryptor && rawTitle) {
          const dt = decryptor.decrypt(rawTitle);
          if (dt && dt !== 'decrypt failed') rawTitle = dt;
        }
        if (decryptor && rawSummary) {
          const ds = decryptor.decrypt(rawSummary);
          if (ds && ds !== 'decrypt failed') rawSummary = ds;
        }

        let rawBody = null;
        let bodyType = 0;
        for (let attempt = 0; attempt < 3; attempt++) {
          try {
            const res = await store.dispatch('getNoteContent', { noteIds: [note.noteId], shouldUpdateNoteInfo: false });
            if (res && res.data && res.data.noteBodies && res.data.noteBodies.length > 0) {
              const nb = res.data.noteBodies.find(b => b.noteId === note.noteId) || res.data.noteBodies[0];
              if (nb && (nb.body !== undefined && nb.body !== null)) {
                rawBody = nb.body;
                bodyType = nb.bodyType;
                break;
              }
            }
          } catch (e) {}
          await delay(80 * (attempt + 1));
        }

        if (decryptor && rawBody) {
          let dec = decryptor.decrypt(rawBody);
          if (bodyType === 1) {
            const s3Res = await store.dispatch('getNoteContentFromS3Server', { key: dec, noteId: note.noteId });
            if (s3Res && s3Res.data) {
              let s3B64 = '';
              if (typeof decryptor.toBase64 === 'function') {
                s3B64 = decryptor.toBase64(s3Res.data);
              } else {
                const bytes = new Uint8Array(s3Res.data);
                let binary = '';
                for (let b = 0; b < bytes.byteLength; b++) binary += String.fromCharCode(bytes[b]);
                s3B64 = btoa(binary);
              }
              const s3Dec = decryptor.decrypt(s3B64);
              if (s3Dec && s3Dec !== 'decrypt failed') dec = s3Dec;
            }
          }
          if (dec && dec !== 'decrypt failed') fullContent = dec;
        }

        if (!fullContent && rawSummary) fullContent = rawSummary;
        if (!fullContent && rawTitle && rawTitle !== '未命名' && rawTitle !== '[图片]') fullContent = rawTitle;

        // 深度清洗：彻底修复 \0、特殊转义符号，并移除首行重复一级标题
        fullContent = cleanMarkdownText(fullContent, rawTitle);
        rawTitle = cleanMarkdownText(rawTitle);

        const smartTitle = getSmartTitle(rawTitle, fullContent);
        
        const { updatedContent, imagesForReceiver, imagesForZip } = await processAndReplaceImages(
          fullContent.trim(),
          note.noteId,
          '未分类便签',
          smartTitle
        );

        // 保持纯净正文，确保无首行重复一级标题与转义乱码
        const finalCleanContent = cleanMarkdownText(updatedContent, smartTitle);
        let mdText = finalCleanContent + '\n';

        const noteItem = { group: '未分类便签', title: smartTitle, content: updatedContent, noteId: note.noteId, images: imagesForReceiver };

        allExtractedNotes.push(noteItem);
        uncatNotesForSync.push(noteItem);
        zipFiles.push({ name: `未分类便签/${smartTitle}.md`, content: mdText });
        zipFiles.push(...imagesForZip);
      }
    }

    if (uncatNotesForSync.length > 0 && localServiceOnline) {
      await fetch('http://127.0.0.1:8765/save', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ clean: false, notes: uncatNotesForSync })
      });
      addLog(`补充了 ${uncatNotesForSync.length} 篇未归类便签`);
    }
  } catch (e) {}

  addLog(`🎉 全部抓取完成！共导出 ${allExtractedNotes.length} 篇便签`);
  updateStatus('正在打包下载...', `已提取 ${allExtractedNotes.length} 篇便签及全部图片附件，正在打包 ZIP...`, 95);

  // 9. 纯 JS 二进制 ZIP 生成器 (浏览器直接下载兜底)
  function buildBinaryZipBlob(files) {
    const encoder = new TextEncoder();
    const crcTable = new Uint32Array(256);
    for (let i = 0; i < 256; i++) {
      let c = i;
      for (let k = 0; k < 8; k++) c = (c & 1) ? (0xEDB88320 ^ (c >>> 1)) : (c >>> 1);
      crcTable[i] = c >>> 0;
    }
    function calcCrc(bytes) {
      let crc = 0xFFFFFFFF;
      for (let i = 0; i < bytes.length; i++) crc = crcTable[(crc ^ bytes[i]) & 0xFF] ^ (crc >>> 8);
      return (crc ^ 0xFFFFFFFF) >>> 0;
    }

    const localParts = [];
    const cdEntries = [];
    let offset = 0;

    for (const f of files) {
      const nameBytes = encoder.encode(f.name);
      let dataBytes;
      if (f.isBinary && f.content instanceof Uint8Array) {
        dataBytes = f.content;
      } else {
        dataBytes = encoder.encode(f.content || '');
      }

      const crc = calcCrc(dataBytes);
      const size = dataBytes.length;

      const lh = new Uint8Array(30 + nameBytes.length);
      const lv = new DataView(lh.buffer);
      lv.setUint32(0, 0x04034b50, true);
      lv.setUint16(4, 20, true);
      lv.setUint16(6, 0x0800, true);
      lv.setUint16(8, 0, true);
      lv.setUint16(10, 0, true);
      lv.setUint16(12, 0, true);
      lv.setUint32(14, crc, true);
      lv.setUint32(18, size, true);
      lv.setUint32(22, size, true);
      lv.setUint16(26, nameBytes.length, true);
      lv.setUint16(28, 0, true);
      lh.set(nameBytes, 30);

      localParts.push(lh);
      localParts.push(dataBytes);

      const cd = new Uint8Array(46 + nameBytes.length);
      const cv = new DataView(cd.buffer);
      cv.setUint32(0, 0x02014b50, true);
      cv.setUint16(4, 20, true);
      cv.setUint16(6, 20, true);
      cv.setUint16(8, 0x0800, true);
      cv.setUint16(10, 0, true);
      cv.setUint16(12, 0, true);
      cv.setUint16(14, 0, true);
      cv.setUint32(16, crc, true);
      cv.setUint32(20, size, true);
      cv.setUint32(24, size, true);
      cv.setUint16(28, nameBytes.length, true);
      cv.setUint16(30, 0, true);
      cv.setUint16(32, 0, true);
      cv.setUint16(34, 0, true);
      cv.setUint16(36, 0, true);
      cv.setUint32(38, 0, true);
      cv.setUint32(42, offset, true);
      cd.set(nameBytes, 46);

      cdEntries.push(cd);
      offset += lh.length + dataBytes.length;
    }

    const cdOffset = offset;
    let cdSize = 0;
    for (const cd of cdEntries) cdSize += cd.length;

    const eocd = new Uint8Array(22);
    const ev = new DataView(eocd.buffer);
    ev.setUint32(0, 0x06054b50, true);
    ev.setUint16(4, 0, true);
    ev.setUint16(6, 0, true);
    ev.setUint16(8, files.length, true);
    ev.setUint16(10, files.length, true);
    ev.setUint32(12, cdSize, true);
    ev.setUint32(16, cdOffset, true);
    ev.setUint16(20, 0, true);

    const allChunks = [...localParts, ...cdEntries, eocd];
    return new Blob(allChunks, { type: 'application/zip' });
  }

  try {
    const zipBlob = buildBinaryZipBlob(zipFiles);
    const downloadUrl = URL.createObjectURL(zipBlob);
    const a = document.createElement('a');
    a.href = downloadUrl;
    a.download = `WPS便签全部导出_${new Date().toISOString().slice(0, 10)}.zip`;
    document.body.appendChild(a);
    a.click();
    setTimeout(() => URL.revokeObjectURL(downloadUrl), 60000);
    addLog('📦 浏览器 ZIP 压缩包已触发自动下载！');
  } catch (zipErr) {
    addLog(`ZIP 打包提示: ${zipErr.message}`);
  }

  if (localServiceOnline) {
    updateStatus('导出全部完成！', `已自动同步写入本地【导出结果】文件夹！<br>包含 ${allExtractedNotes.length} 篇便签及高清附件图片！`, 100);
  } else {
    updateStatus('导出全部完成！', `共导出 ${allExtractedNotes.length} 篇便签，ZIP 备份压缩包已下载到您的浏览器下载文件夹！`, 100);
  }
})();
