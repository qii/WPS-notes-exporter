import base64
import http.server
import json
import os
import re
import sys
import subprocess
import urllib.request
import urllib.error
from datetime import datetime

# Windows 控制台原生 UTF-8 支持
if sys.platform == "win32":
    try:
        sys.stdout.reconfigure(encoding="utf-8")
        sys.stderr.reconfigure(encoding="utf-8")
    except Exception:
        pass
    os.system("chcp 65001 >nul 2>nul")

PORT = 8765
# 自动定位当前脚本所在目录，并在其下建立「导出结果」文件夹（适配任意电脑、任意路径）
BASE_DIR = os.path.dirname(os.path.abspath(__file__))
SAVE_DIR = os.path.join(BASE_DIR, "导出结果")
os.makedirs(SAVE_DIR, exist_ok=True)

def sanitize_filename(name):
    # Windows invalid characters: \ / : * ? " < > |
    name = re.sub(r'[\\/*?:"<>|]', '_', name)
    name = name.strip()
    return name if name else "未命名"

def format_time(ts):
    if not ts:
        return ""
    try:
        if isinstance(ts, (int, float)):
            # WPS timestamps are often in milliseconds
            if ts > 10000000000:
                ts = ts / 1000.0
            return datetime.fromtimestamp(ts).strftime("%Y-%m-%d %H:%M:%S")
        return str(ts)
    except Exception:
        return str(ts)

def creation_header(value):
    """使用便签创建时间，兼容秒/毫秒时间戳及 ISO 日期，按本机时区显示。"""
    try:
        if isinstance(value, bool) or value is None:
            raise ValueError("missing creation time")
        if isinstance(value, (int, float)) or (
            isinstance(value, str) and re.fullmatch(r"\d+(?:\.\d+)?", value.strip())
        ):
            timestamp = float(value)
            if timestamp <= 0:
                raise ValueError("invalid creation time")
            if timestamp > 10000000000:
                timestamp /= 1000
            created = datetime.fromtimestamp(timestamp)
        else:
            created = datetime.fromisoformat(value.strip().replace("Z", "+00:00"))
            if created.tzinfo is not None:
                created = created.astimezone()
        return f"【{created.year}.{created.month}.{created.day} created】"
    except (ValueError, TypeError, AttributeError, OverflowError, OSError):
        return "【创建时间未知 created】"

def clean_markdown_text(text, title=None):
    if not text:
        return ""
    # 1. 彻底修复数字 0 被错误转义为 \0（身份证、学号、金额、日期等）
    text = text.replace(r"\0", "0")
    # 2. 彻底清理 Markdown 常见标点转义反斜杠
    text = text.replace(r"\[", "[").replace(r"\]", "]")
    text = text.replace(r"\*", "*").replace(r"\~", "~")
    text = text.replace(r"\#", "#")
    
    # 3. 彻底移除首行与文件名重复的一级标题（如 # 标题）及紧随其后的空白行
    lines = text.splitlines(keepends=True)
    if lines:
        first_line = lines[0].strip()
        if first_line.startswith("# "):
            lines.pop(0)
            while lines and not lines[0].strip():
                lines.pop(0)
        text = "".join(lines)
    return text.strip()

class ReceiverHandler(http.server.BaseHTTPRequestHandler):
    def end_headers(self):
        self.send_header("Access-Control-Allow-Origin", "*")
        self.send_header("Access-Control-Allow-Methods", "GET, POST, OPTIONS")
        self.send_header("Access-Control-Allow-Headers", "*")
        self.send_header("Access-Control-Allow-Private-Network", "true")
        super().end_headers()

    def do_GET(self):
        self.send_response(200)
        self.send_header("Content-Type", "text/html; charset=utf-8")
        self.end_headers()
        self.wfile.write("<h3>WPS便签本地接收服务已就绪！</h3><p>等待浏览器端发送便签数据...</p>".encode("utf-8"))

    def do_OPTIONS(self):
        self.send_response(200)
        self.end_headers()

    def do_POST(self):
        if self.path == "/save":
            content_length = int(self.headers.get("Content-Length", 0))
            body = self.rfile.read(content_length).decode("utf-8")
            try:
                data = json.loads(body)
                notes = data.get("notes", [])
                saved_count = 0

                # 如果传入了 clean 标记，先清空已有分类文件夹避免重名混杂
                if data.get("clean", False):
                    protected = {"__pycache__", ".git", ".idea", ".vscode", "备忘录_已去除标题"}
                    for entry in os.listdir(SAVE_DIR):
                        full_p = os.path.join(SAVE_DIR, entry)
                        if os.path.isdir(full_p) and entry not in protected:
                            try:
                                import shutil
                                shutil.rmtree(full_p)
                            except Exception:
                                pass

                for item in notes:
                    group_name = sanitize_filename(item.get("group") or "未分类")
                    title = sanitize_filename(item.get("title") or "无标题便签").replace(r"\0", "0")
                    content = item.get("content", "").replace(r"\0", "0")
                    update_time = format_time(item.get("updateTime") or item.get("infoUpdateTime"))
                    star = item.get("star", 0)

                    group_path = os.path.join(SAVE_DIR, group_name)
                    os.makedirs(group_path, exist_ok=True)

                    # 保存附件图片到该分类下的「附件」文件夹
                    images = item.get("images", [])
                    attachment_dir = os.path.join(group_path, "附件")
                    saved_images = []

                    if images:
                        os.makedirs(attachment_dir, exist_ok=True)
                        print(f"  [附件] 便签 [{title}] 包含 {len(images)} 张图片，保存至: {group_name}/附件", flush=True)
                        for img in images:
                            orig_name = sanitize_filename(img.get("filename") or "image.png")
                            img_url = img.get("url")
                            img_b64 = img.get("data", "")
                            img_bytes = None

                            # 策略 1: 直接从 S3 签名 URL 下载（Python 本地完全不受浏览器 CORS 限制）
                            if img_url:
                                try:
                                    req = urllib.request.Request(img_url, headers={
                                        "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36"
                                    })
                                    with urllib.request.urlopen(req, timeout=30) as resp:
                                        img_bytes = resp.read()
                                except Exception as dl_err:
                                    print(f"    [URL下载失败] {orig_name}: {dl_err}", file=sys.stderr, flush=True)

                            # 策略 2: Base64 解码兜底
                            if not img_bytes and img_b64:
                                try:
                                    if "," in img_b64:
                                        img_b64 = img_b64.split(",", 1)[1]
                                    img_bytes = base64.b64decode(img_b64)
                                except Exception as b64_err:
                                    print(f"    [Base64解码失败] {orig_name}: {b64_err}", file=sys.stderr, flush=True)

                            if img_bytes:
                                # 检查实际图片格式魔数，确保扩展名准确
                                detected_ext = None
                                if img_bytes.startswith(b"\xff\xd8\xff"):
                                    detected_ext = ".jpg"
                                elif img_bytes.startswith(b"\x89PNG\r\n\x1a\n"):
                                    detected_ext = ".png"
                                elif img_bytes.startswith(b"GIF87a") or img_bytes.startswith(b"GIF89a"):
                                    detected_ext = ".gif"
                                elif img_bytes.startswith(b"RIFF") and b"WEBP" in img_bytes[:16]:
                                    detected_ext = ".webp"

                                base_part, old_ext = os.path.splitext(orig_name)
                                final_img_name = orig_name
                                if detected_ext and old_ext.lower() != detected_ext.lower():
                                    final_img_name = f"{base_part}{detected_ext}"
                                    # 同步更新 markdown 中引用的文件名
                                    content = content.replace(f"附件/{orig_name}", f"附件/{final_img_name}")

                                img_file_path = os.path.join(attachment_dir, final_img_name)
                                with open(img_file_path, "wb") as img_fp:
                                    img_fp.write(img_bytes)
                                print(f"    -> 附件落地成功: {final_img_name} ({len(img_bytes)} 字节)", flush=True)
                                saved_images.append(final_img_name)
                            else:
                                print(f"    ⚠️ 图片数据为空，跳过: {orig_name}", file=sys.stderr, flush=True)

                    # 写入 Markdown 文件
                    base_filename = title
                    file_path = os.path.join(group_path, f"{base_filename}.md")
                    counter = 1
                    while os.path.exists(file_path):
                        file_path = os.path.join(group_path, f"{base_filename}_{counter}.md")
                        counter += 1

                    body_text = clean_markdown_text(content, title)
                    body_text = creation_header(item.get("createTime")) + "\n\n" + body_text
                    with open(file_path, "w", encoding="utf-8") as f:
                        f.write(body_text + "\n")

                    # 同步写入「备忘录_已去除标题」目录（如果存在）
                    clean_dir = os.path.join(SAVE_DIR, "备忘录_已去除标题")
                    if os.path.exists(clean_dir):
                        clean_group_path = os.path.join(clean_dir, group_name)
                        os.makedirs(clean_group_path, exist_ok=True)
                        clean_file_path = os.path.join(clean_group_path, os.path.basename(file_path))
                        with open(clean_file_path, "w", encoding="utf-8") as f:
                            f.write(body_text + "\n")
                        if saved_images:
                            clean_att_dir = os.path.join(clean_group_path, "附件")
                            os.makedirs(clean_att_dir, exist_ok=True)
                            for s_img in saved_images:
                                s_src = os.path.join(attachment_dir, s_img)
                                s_dst = os.path.join(clean_att_dir, s_img)
                                if os.path.exists(s_src) and not os.path.exists(s_dst):
                                    import shutil
                                    shutil.copy2(s_src, s_dst)

                    saved_count += 1

                self.send_response(200)
                self.send_header("Content-Type", "application/json")
                self.end_headers()
                response = {"status": "success", "count": saved_count}
                self.wfile.write(json.dumps(response).encode("utf-8"))
                print(f"成功保存 {saved_count} 条便签至 {SAVE_DIR}", flush=True)
            except Exception as e:
                self.send_response(500)
                self.send_header("Content-Type", "application/json")
                self.end_headers()
                self.wfile.write(json.dumps({"status": "error", "message": str(e)}).encode("utf-8"))
                print(f"保存失败: {e}", file=sys.stderr, flush=True)
        else:
            self.send_response(404)
            self.end_headers()

    def log_message(self, format, *args):
        # Quiet log
        pass

def copy_script_to_clipboard():
    js_path = os.path.join(BASE_DIR, "wps_scraper_snippet.js")
    if not os.path.isfile(js_path):
        print("      × 未找到 wps_scraper_snippet.js 脚本文件！", flush=True)
        return False

    if sys.platform == "darwin":
        try:
            with open(js_path, "r", encoding="utf-8") as fp:
                content = fp.read()
            env = os.environ.copy()
            env["LC_ALL"] = "en_US.UTF-8"
            subprocess.run(
                ["pbcopy"], input=content.encode("utf-8"),
                check=True, capture_output=True, timeout=8, env=env,
            )
            print("      √ 复制成功！去浏览器控制台直接按 Command+V 即可粘贴。", flush=True)
            return True
        except (OSError, subprocess.SubprocessError):
            print("      × 自动复制失败，请手动打开 wps_scraper_snippet.js 复制代码。", flush=True)
            return False

    # 1. 优先使用 Windows 内置 clip 命令 (原生秒级复制，无权限与策略限制)
    try:
        with open(js_path, "r", encoding="utf-8") as fp:
            content = fp.read()
        p = subprocess.Popen(["clip"], stdin=subprocess.PIPE, shell=True)
        p.communicate(content.encode("utf-16le"))
        if p.returncode == 0:
            print("      √ 复制成功！去浏览器 F12 控制台直接按 Ctrl+V 即可粘贴。", flush=True)
            return True
    except Exception:
        pass

    # 2. 备用：PowerShell Set-Clipboard
    try:
        cmd = [
            "powershell", "-NoProfile", "-ExecutionPolicy", "Bypass", "-Command",
            f"Set-Clipboard -Value (Get-Content -LiteralPath '{js_path}' -Raw -Encoding UTF8)"
        ]
        res = subprocess.run(cmd, capture_output=True, timeout=8)
        if res.returncode == 0:
            print("      √ 复制成功！去浏览器 F12 控制台直接按 Ctrl+V 即可粘贴。", flush=True)
            return True
    except Exception:
        pass

    print("      × 自动复制失败，请手动打开 wps_scraper_snippet.js 复制代码。", flush=True)
    return False

if __name__ == "__main__":
    console_shortcut = "Command+Option+J" if sys.platform == "darwin" else "F12"
    paste_shortcut = "Command+V" if sys.platform == "darwin" else "Ctrl+V"
    print("=" * 60)
    print("         WPS 便签自动导出 - 一键准备助手")
    print("=" * 60)
    print("\n[1/2] 正在将导出脚本 (wps_scraper_snippet.js) 复制到剪贴板...")
    copy_script_to_clipboard()

    print("\n[2/2] 正在启动本地接收服务 (端口 8765)...")
    try:
        server = http.server.HTTPServer(("127.0.0.1", PORT), ReceiverHandler)
        print(f"      √ 本地接收服务已就绪: http://127.0.0.1:{PORT}")
        print("=" * 60)
        print(" 现在请前往 WPS 便签网页版 (https://note.wps.cn)：")
        print(f" 1. 按 {console_shortcut} 打开开发者工具，切换到【控制台 (Console)】")
        print(f" 2. 按 {paste_shortcut} 粘贴脚本并回车运行！")
        print(" (导出完成前请勿关闭此命令窗口)")
        print("=" * 60 + "\n", flush=True)
        server.serve_forever()
    except OSError as e:
        if "Address already in use" in str(e) or getattr(e, "winerror", None) == 10048:
            print(f"      √ 端口 {PORT} 已有接收服务在运行中，无需重复启动。")
            print("=" * 60)
            print(" 现在请前往 WPS 便签网页版 (https://note.wps.cn)：")
            print(f" 1. 按 {console_shortcut} 打开控制台 (Console)")
            print(f" 2. 按 {paste_shortcut} 粘贴脚本并回车运行即可！")
            print("=" * 60 + "\n", flush=True)
            input("按回车键退出此窗口...")
        else:
            print(f"      × 启动服务失败: {e}", file=sys.stderr)
            input("按回车键退出...")
    except KeyboardInterrupt:
        print("\n接收服务已安全退出。")
