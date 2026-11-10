#!/bin/sh
set -eu

mkdir -p "$MONITOR_DATA_DIR"
umask 077

Xvfb "$DISPLAY" -screen 0 1440x900x24 -nolisten tcp &
openbox --display "$DISPLAY" &
x11vnc \
  -display "$DISPLAY" \
  -forever \
  -shared \
  -localhost \
  -rfbport 5900 \
  -nopw &
websockify --web=/usr/share/novnc 0.0.0.0:6080 127.0.0.1:5900 &

sleep 2
exec python /app/tennis_booking.py --config /app/booking_targets.json --watch
