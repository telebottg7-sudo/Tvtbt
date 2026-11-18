#!/usr/bin/env bash
set -e

echo "===================================================="
echo "  VeloFetch — Telegram Video Downloader & Uploader  "
echo "===================================================="

# Ensure required directories exist
mkdir -p storage/downloads storage/thumbnails storage/temp database logs

# Verify binaries
echo "[1/3] Checking multimedia binaries..."
which ffmpeg && ffmpeg -version | head -n 1 || echo "Warning: ffmpeg not found"
which ffprobe && ffprobe -version | head -n 1 || echo "Warning: ffprobe not found"
which aria2c && aria2c --version | head -n 1 || echo "Warning: aria2c not found"
which yt-dlp && yt-dlp --version || echo "Warning: yt-dlp not found"

echo "[2/3] Checking Python Wzgram bridge..."
python3 --version

echo "[3/3] Starting VeloFetch Full-Stack Server on port 3000..."
exec npx tsx server.ts
