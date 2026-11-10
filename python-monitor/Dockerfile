FROM mcr.microsoft.com/playwright/python:v1.55.0-noble

ENV DEBIAN_FRONTEND=noninteractive \
    DISPLAY=:99 \
    MONITOR_DATA_DIR=/data

RUN apt-get update \
    && apt-get install -y --no-install-recommends \
        fonts-noto-cjk \
        novnc \
        openbox \
        python3-websockify \
        x11vnc \
        xvfb \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app
COPY requirements.txt tennis_booking.py booking_targets.json cloud-entrypoint.sh ./
RUN python -m pip install --no-cache-dir -r requirements.txt \
    && chmod 700 /app/cloud-entrypoint.sh

VOLUME ["/data"]
EXPOSE 6080
ENTRYPOINT ["/app/cloud-entrypoint.sh"]
