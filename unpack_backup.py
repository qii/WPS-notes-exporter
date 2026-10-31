import os
import glob
import zipfile
import shutil
import re

BASE_DIR = os.path.dirname(os.path.abspath(__file__))
TARGET_DIR = os.path.join(BASE_DIR, "导出结果")
os.makedirs(TARGET_DIR, exist_ok=True)

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

def unpack_latest_zip():
    # Look for wps note zip in current folder or user Downloads folder
    user_downloads = os.path.join(os.path.expanduser("~"), "Downloads")
    zip_candidates = glob.glob(os.path.join(BASE_DIR, "*.zip")) + glob.glob(os.path.join(TARGET_DIR, "*.zip")) + glob.glob(os.path.join(user_downloads, "WPS便签*.zip"))
    
    if not zip_candidates:
        print("未找到便签备份压缩包 (.zip)。")
        return

    # Sort by mtime descending
    zip_candidates.sort(key=lambda x: os.path.getmtime(x), reverse=True)
    latest_zip = zip_candidates[0]
    print(f"找到最新便签压缩包: {latest_zip}")

    with zipfile.ZipFile(latest_zip, 'r') as zf:
        zf.extractall(TARGET_DIR)
        print(f"✅ 成功解压到: {TARGET_DIR}")
        print(f"解压包含 {len(zf.namelist())} 个文件/目录。")

    # 自动进行格式清洗与同步
    clean_dir = os.path.join(TARGET_DIR, "备忘录_已去除标题")
    cleaned_count = 0

    for root, dirs, files in os.walk(TARGET_DIR):
        if "备忘录_已去除标题" in root or any(ig in root for ig in [".git", "__pycache__"]):
            continue
        for f in files:
            if f.endswith('.md') and f != 'README.md':
                fpath = os.path.join(root, f)
                try:
                    with open(fpath, 'r', encoding='utf-8', errors='ignore') as fp:
                        content = fp.read()
                    cleaned = clean_markdown_text(content, os.path.splitext(f)[0])
                    if cleaned != content:
                        with open(fpath, 'w', encoding='utf-8') as fp:
                            fp.write(cleaned + '\n')
                        cleaned_count += 1
                        
                    # 同步到 备忘录_已去除标题 目录
                    if os.path.exists(clean_dir):
                        rel_path = os.path.relpath(fpath, TARGET_DIR)
                        tgt_path = os.path.join(clean_dir, rel_path)
                        os.makedirs(os.path.dirname(tgt_path), exist_ok=True)
                        with open(tgt_path, 'w', encoding='utf-8') as fp:
                            fp.write(cleaned + '\n')
                except Exception as err:
                    print(f"处理 {f} 失败: {err}")

    if cleaned_count:
        print(f"✨ 自动优化清洗了 {cleaned_count} 篇 Markdown 文件（已去除冗余一级标题及 \\0 等误转义符）。")

if __name__ == "__main__":
    unpack_latest_zip()
