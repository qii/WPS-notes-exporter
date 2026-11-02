// Run with: node tests/export_browser_test.cjs
// Exercises the complete browser script with WPS's current Vuex contracts.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { execFileSync } = require('node:child_process');

const source = process.argv.includes('--baseline')
  ? execFileSync('git', ['show', 'f2ee235:wps_scraper_snippet.js'], { encoding: 'utf8' })
  : fs.readFileSync(path.join(__dirname, '..', 'wps_scraper_snippet.js'), 'utf8');

async function run(options = {}) {
  const nodes = new Map(), logs = [], payloads = [], calls = [];
  let zip = null, autoDownloadCount = 0;
  class Element {
    constructor() { this.style = {}; this.children = []; this.html = ''; }
    set id(id) { this._id = id; nodes.set(id, this); }
    get id() { return this._id; }
    set innerHTML(html) {
      this.html = html;
      if (html.includes('id="wps-log-box"')) {
        const log = new Element(); log.id = 'wps-log-box';
      }
    }
    appendChild(child) { this.children.push(child); }
    replaceWith(other) { nodes.set(this.id, other); }
    click() { autoDownloadCount++; }
  }
  const makeNote = (id) => ({ noteId: id, title: id, summary: '正文', createTime: '2022-05-03' });
  const home = options.empty ? [] : Array.from({ length: 101 }, (_, i) => makeNote(`home-${i}`));
  const grouped = options.empty ? [] : [makeNote('grouped')];
  const store = {
    state: { user: options.missingUser ? {} : { user: { userid: 123456 } }, group: { all: {} }, notes: { all: {} } },
    getters: { availableGroups: [] },
    async dispatch(action, params) {
      calls.push({ action, params });
      if (action === 'getAllGroups') {
        return { status: 200, data: { noteGroups: [{ groupId: 'g1', groupName: '工作', valid: 1 }] } };
      }
      if (action === 'getNotesByGroupId') return { status: 200, data: { webNotes: grouped } };
      if (action === 'getHomeNotes') {
        assert.equal(params?.uid, 123456, 'home API requires state.user.user.userid');
        if (options.fallback) return undefined;
        if (options.apiError) return { status: 500, data: {} };
        const offset = options.repeatedPage ? 0 : params.startIndex;
        return { status: 200, data: { webNotes: home.slice(offset, offset + params.rows) } };
      }
      if (action === 'getNoteContent') {
        return { status: 200, data: { noteBodies: [{ noteId: params.noteIds[0], body: '# 标题\n\n正文', bodyType: 0 }] } };
      }
      return undefined;
    }
  };
  const context = {
    TextEncoder, Blob, AbortController,
    console: { log: (...args) => logs.push(args.join(' ')), warn: (...args) => logs.push(args.join(' ')), error: (...args) => logs.push(args.join(' ')) },
    document: {
      cookie: '', body: new Element(), getElementById: id => nodes.get(id),
      createElement: () => new Element(), querySelectorAll: () => [],
      querySelector: () => options.noStore ? null : ({ __vue__: { $store: store } })
    },
    window: { webpackJsonp: { push: entry => entry[1].__wps_export_probe__({}, {}, name =>
      name === '4eb3' ? { a: { decrypt: value => value } } : {}) } },
    setTimeout: (fn, ms) => { if (ms < 1000) queueMicrotask(fn); return 1; }, clearTimeout() {},
    URL: { createObjectURL: blob => { if (options.zipError) throw Error('ZIP failure'); zip = blob; return 'blob:test'; } },
    alert: message => logs.push(message),
    fetch: async (url, init = {}) => {
      if (url.endsWith('/health')) {
        if (options.offline) throw Error('Failed to fetch');
        return { ok: true, status: 200, json: async () => ({ service: 'wps-notes-exporter' }) };
      }
      if (url.startsWith('https://note-api.wps.cn/')) {
        assert.ok(!url.includes('undefined'));
        if (options.apiError) return { ok: false, status: 500 };
        assert.equal(init.headers['X-user-key'], '123456');
        const offset = Number(url.match(/startindex\/(\d+)/)[1]);
        return { ok: true, status: 200, json: async () => ({ webNotes: home.slice(offset, offset + 100) }) };
      }
      assert.equal(url, 'http://127.0.0.1:8765/save');
      const payload = JSON.parse(init.body); payloads.push(payload);
      assert.equal(payload.clean, false, 'probing must never clear existing exports');
      return { ok: !options.saveError, status: options.saveError ? 500 : 200,
        json: async () => options.saveError ? { status: 'error' } : { status: 'success', count: payload.notes.length } };
    }
  };
  await vm.runInNewContext(source, context, { timeout: 5000 });
  return { panel: nodes.get('wps-exporter-panel'), logs: logs.join('\n'), calls, payloads, zip, autoDownloadCount };
}

async function main() {
  const success = await run();
  assert.match(success.panel.html, /本地保存完成/);
  assert.match(success.panel.html, /本地确认保存 102 篇/);
  assert.deepEqual(success.calls.filter(c => c.action === 'getHomeNotes').map(c => c.params.startIndex), [0, 100]);
  assert.equal(success.payloads.flatMap(p => p.notes).length, 102);
  assert.ok(success.payloads.every(p => p.notes.every(n => n.createTime === '2022-05-03')));
  assert.ok(success.panel.children.some(c => c.download && c.href === 'blob:test'), 'manual ZIP link must remain visible');
  assert.ok(success.zip);
  assert.ok(Buffer.from(await success.zip.arrayBuffer()).includes(Buffer.from('【2022.5.3 created】\n\n正文\n')));

  const fallback = await run({ fallback: true });
  assert.match(fallback.panel.html, /本地确认保存 102 篇/);
  const empty = await run({ empty: true });
  assert.match(empty.panel.html, /没有导出任何便签/);
  assert.equal(empty.zip, null);
  assert.equal(empty.payloads.length, 0);
  const failed = await run({ saveError: true });
  assert.match(failed.panel.html, /本地确认保存 0 篇/);
  assert.match(failed.logs, /本地写入失败/);
  assert.ok(failed.zip);
  const offline = await run({ offline: true });
  assert.match(offline.logs, /本地接收器不可用/);
  assert.match(offline.panel.html, /ZIP 已准备好/);
  for (const options of [{ apiError: true }, { repeatedPage: true }, { missingUser: true }]) {
    const partial = await run(options);
    assert.match(partial.panel.html, /导出有遗漏/);
    assert.match(partial.logs, /未分类便签读取失败/);
  }
  const noStore = await run({ noStore: true });
  assert.match(noStore.panel.html, /无法开始导出/);
  const noOutput = await run({ offline: true, zipError: true });
  assert.match(noOutput.panel.html, /导出未完成/);
  console.log('PASS: 10 browser scenarios; nested user ID, pagination, direct API fallback, dates, ZIP link, empty/error handling, non-destructive probe.');
}
main().catch(error => { console.error(error); process.exitCode = 1; });
