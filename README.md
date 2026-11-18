# VeloFetch — Telegram Video Downloader & Uploader

VeloFetch is a production-ready Telegram video downloader and uploader system paired with a Midnight Black & Electric Blue SaaS control panel. It integrates **Node.js**, **Python (Wzgram MTProto)**, **yt-dlp**, **aria2c**, **FFmpeg**, and **FFprobe** into a unified, real-time synchronized pipeline.

## Architecture & Directory Structure

- `frontend/` & `src/` — React 19 + Tailwind CSS v4 real-time dashboard.
- `backend/` — Express REST API, WebSocket broadcast engine, and job orchestrator.
- `telegram/` — Node.js <-> Python IPC controller and Telegram Bot workflow coordinator.
- `python/` — Wzgram (`https://github.com/rjriajul/wzgram.git`) MTProto client and bot polling/upload worker (`wzgram_bridge.py`).
- `downloader/` — `yt-dlp` stream extractor and `aria2c` multi-connection download engine with live progress parsing.
- `media/` — `FFprobe` metadata extractor (resolution, codecs, FPS, bitrate, duration) and `FFmpeg` fast-seek JPEG thumbnail generator (without video re-encoding).
- `storage/` — Automatic post-upload cleanup, failed-upload retention for retries, active-job file lock protection, and disk usage analyzer.
- `database/` — Persistent SQLite database (`better-sqlite3`) storing jobs, media library, upload history, destination channels, settings, and structured logs.
- `config/` — Environment and runtime configuration management.
- `logs/` — Structured system and pipeline logs.

## Environment Variables

Configure these in `.env` (or via the Settings tab in the web dashboard):

```env
BOT_TOKEN="your_telegram_bot_token"
API_ID="your_telegram_api_id"
API_HASH="your_telegram_api_hash"
TARGET_CHANNEL="@your_channel_or_chat_id"
```

## Features

1. **Unified Job Queue**: Submit URLs from either the Telegram Bot or the Web Dashboard. Progress, speed, ETA, cancellations, and retries stay synchronized in real time over WebSockets and Telegram inline messages.
2. **Accelerated Downloading**: Uses `yt-dlp` with `aria2c` (`-x 16 -s 16 -k 1M`) for multi-connection segmented downloading and format selection.
3. **FFprobe & FFmpeg Media Pipeline**: Extracts exact stream telemetry and generates compressed JPEG thumbnails at configurable timestamps without re-encoding the source video.
4. **Wzgram MTProto Uploads**: Supports large file uploads with live progress callbacks, custom or template-driven metadata captions, thumbnail attachment, and inline destination selection buttons.
5. **Smart Storage Management**: Automatically cleans up source videos and temporary thumbnails only after confirmed upload completion while preserving files for failed jobs so they can be retried cleanly.
