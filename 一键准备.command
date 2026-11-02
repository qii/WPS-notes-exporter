#!/bin/bash

# macOS Finder 双击入口，复用终端脚本。
/bin/bash "$(dirname -- "${BASH_SOURCE[0]}")/一键准备.sh"
status=$?
if [ "$status" -ne 0 ] && [ -t 0 ]; then
    read -r -p '启动失败，按回车键退出此窗口…' _
fi
exit "$status"
