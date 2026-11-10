#!/bin/sh
set -eu

cd "$(dirname "$0")"
python3 -m venv .venv
.venv/bin/python -m pip install -r requirements.txt
echo "依赖已安装。运行 .venv/bin/python tennis_booking.py --inspect --venue \"南区网球场-网球\""
