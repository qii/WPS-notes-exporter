#!/bin/bash

# 无论从哪个目录启动，都使用本脚本旁边的接收器。
cd -- "$(dirname -- "${BASH_SOURCE[0]}")" || exit 1
export PYTHONIOENCODING=utf-8
export PYTHONUTF8=1

for python_cmd in python3 python; do
    if command -v "$python_cmd" >/dev/null 2>&1 &&
        "$python_cmd" -c 'import sys; sys.exit(0 if sys.version_info >= (3, 7) else 1)' >/dev/null 2>&1; then
        exec "$python_cmd" -B local_receiver.py
    fi
done

printf '%s\n' '未找到可用的 Python 3.7 或更新版本。' \
    '请从 https://www.python.org/downloads/macos/ 安装 Python 3，然后重新运行。' >&2
exit 1
