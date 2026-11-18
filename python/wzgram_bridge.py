#!/usr/bin/env python3
"""
VeloFetch — Wzgram (https://github.com/rjriajul/wzgram.git) MTProto & Zero-Dependency Bot Bridge
Guarantees:
1. Self-contained path resolution: automatically adds `./vendor/py` to `sys.path` so `wzgram` is loaded
   from the persistent workspace directory.
2. Zero external dependency fallback: uses Python's built-in `urllib.request` + `asyncio.to_thread` for
   all HTTP Bot API fallback operations so the bridge NEVER crashes even if external pip packages are absent.
3. Immediate Quality Selection + Destination Options on every link sent to the Telegram bot:
   - Shows quick 1-tap Quality buttons (`Best MP4`, `1080p`, `720p`, `480p`, `360p`, `4K`) right on the initial
     reply message AND allows switching destination between Private Bot Chat and Target Channel.
4. Dual-Delivery Support: When uploading to a Target Channel from a Telegram bot request, also delivers/confirms
   the video in the user's Bot Private Chat so you always receive the video directly in the bot chat as well.
5. Strict Telegram Rate-Limit Governor (`TelegramRateLimiter`):
   - >= 4.0s interval between live progress edits + duplicate suppression
   - >= 1.1s per-chat pacing + automatic `FloodWait` / HTTP 429 retry
"""

from __future__ import annotations

import asyncio
from collections import deque, OrderedDict
import hashlib
import html
import importlib
import json
import mimetypes
import os
import re
import subprocess
import sys
import time
import traceback
import urllib.error
import urllib.parse
import urllib.request
import uuid
from typing import Dict, Any, Optional, Callable, Awaitable

# Ensure persistent workspace vendor/py is on sys.path before importing wzgram
VENDOR_PY = os.path.join(os.getcwd(), "vendor", "py")
if VENDOR_PY not in sys.path:
    sys.path.insert(0, VENDOR_PY)

# Tune Wzgram MTProto media upload pool for high throughput without FloodWait stampedes (12 sessions x 4 workers = 48 concurrent 512KB streams)
os.environ.setdefault("WZGRAM_UPLOAD_POOL_BOT", "12")
os.environ.setdefault("WZGRAM_UPLOAD_RATE_BOT", "120")
os.environ.setdefault("WZGRAM_UPLOAD_WORKERS_PER_SESSION", "4")
os.environ.setdefault("WZGRAM_MAX_INFLIGHT_MEDIA", "12")
os.environ.setdefault("WZGRAM_MAX_INFLIGHT_PACKETS", "32")
os.environ.setdefault("WZGRAM_MAX_READ_AHEAD", "256")
os.environ.setdefault("WZGRAM_MEDIA_TIMEOUT", "90")
os.environ.setdefault("WZGRAM_TCP_TIMEOUT", "30")
os.environ.setdefault("WZGRAM_CRYPTO_WORKERS", "4")
os.environ.setdefault("WZGRAM_SOCKET_BUFFER", "4194304")

BOT_API_MAX_BYTES = 48 * 1024 * 1024  # 48 MiB safe ceiling below Telegram's 50 MiB HTTP Bot API limit

Client = Any
Message = Any
CallbackQuery = Any
InlineKeyboardMarkup = Any
InlineKeyboardButton = Any
StopTransmission = Exception
filters = None
pyro_raw = None
pyro_utils = None
pyro_enums = None
WZGRAM_AVAILABLE = False
WZGRAM_VERSION = "3.1.7"


def _apply_wzgram_runtime_tuning() -> None:
    """Apply belt-and-suspenders runtime Session/TCP/SaveFile tuning cleanly for wzgram 3.1.7."""
    try:
        from pyrogram.session.session import Session as _PyroSession

        _PyroSession.MAX_SKEW_AHEAD = 86400
        _PyroSession.MAX_SKEW_BEHIND = 86400
        _PyroSession.MEDIA_WAIT_TIMEOUT = int(os.environ.get("WZGRAM_MEDIA_TIMEOUT", 90))
        _PyroSession.MAX_INFLIGHT_MEDIA = int(os.environ.get("WZGRAM_MAX_INFLIGHT_MEDIA", 12))
        _PyroSession.MAX_INFLIGHT_PACKETS = int(os.environ.get("WZGRAM_MAX_INFLIGHT_PACKETS", 32))
    except Exception:
        pass
    try:
        from pyrogram.connection.transport.tcp.tcp import TCP as _PyroTCP

        _PyroTCP.TIMEOUT = int(os.environ.get("WZGRAM_TCP_TIMEOUT", 30))
        _PyroTCP.SOCKET_BUFFER = int(os.environ.get("WZGRAM_SOCKET_BUFFER", 4194304))
    except Exception:
        pass
    try:
        from pyrogram.client import Client as _PyroClient, _transfer_budgets

        target_read_ahead = int(os.environ.get("WZGRAM_MAX_READ_AHEAD", 256))
        if _PyroClient.MAX_READ_AHEAD_CHUNKS != target_read_ahead:
            _PyroClient.MAX_READ_AHEAD_CHUNKS = target_read_ahead
            _transfer_budgets.clear()
    except Exception:
        pass
    try:
        import pyrogram.methods.advanced.save_file as _save_file

        _save_file.READ_BUFFER = 16 * 1024 * 1024
        _save_file.MAX_BATCH = 32 * 1024 * 1024
        _save_file.PACER_BURST = 32
        _save_file.WORKERS_PER_SESSION = max(
            1, int(os.environ.get("WZGRAM_UPLOAD_WORKERS_PER_SESSION", 4))
        )
    except Exception:
        pass


def _try_import_wzgram(auto_install: bool = False) -> bool:
    """
    Dynamically import wzgram from vendor/py (or system site-packages).
    Verifies core Pyrogram storage & Client imports so partial namespace installs are caught.
    """
    global Client, Message, CallbackQuery, InlineKeyboardMarkup, InlineKeyboardButton
    global StopTransmission, filters, pyro_raw, pyro_utils, pyro_enums, WZGRAM_AVAILABLE, WZGRAM_VERSION
    if WZGRAM_AVAILABLE and Client is not Any:
        _apply_wzgram_runtime_tuning()
        return True

    os.makedirs(VENDOR_PY, exist_ok=True)
    if VENDOR_PY not in sys.path:
        sys.path.insert(0, VENDOR_PY)
    importlib.invalidate_caches()

    try:
        import wzgram as _wz
        from wzgram import Client as _Client, filters as _filters
        from wzgram.types import (
            Message as _Message,
            CallbackQuery as _CallbackQuery,
            InlineKeyboardMarkup as _InlineKeyboardMarkup,
            InlineKeyboardButton as _InlineKeyboardButton,
        )
        from pyrogram import (
            StopTransmission as _StopTransmission,
            enums as _enums,
            raw as _raw,
            utils as _utils,
        )
        from pyrogram.storage import SQLiteStorage as _SQLiteStorage  # noqa: F401

        _apply_wzgram_runtime_tuning()
        Client = _Client
        Message = _Message
        CallbackQuery = _CallbackQuery
        InlineKeyboardMarkup = _InlineKeyboardMarkup
        InlineKeyboardButton = _InlineKeyboardButton
        StopTransmission = _StopTransmission
        filters = _filters
        pyro_raw = _raw
        pyro_utils = _utils
        pyro_enums = _enums
        WZGRAM_AVAILABLE = True
        WZGRAM_VERSION = getattr(_wz, "__version__", "3.1.7")
        return True
    except Exception:
        if not auto_install:
            return False

    # Auto-install/repair wzgram into vendor/py if missing or broken
    try:
        pip_pyz = os.path.join(os.getcwd(), "vendor", "bin", "pip.pyz")
        os.makedirs(os.path.dirname(pip_pyz), exist_ok=True)
        if not os.path.exists(pip_pyz):
            urllib.request.urlretrieve("https://bootstrap.pypa.io/pip/pip.pyz", pip_pyz)
        subprocess.run(
            [
                sys.executable,
                pip_pyz,
                "install",
                "--quiet",
                "--upgrade",
                "--target",
                VENDOR_PY,
                "git+https://github.com/rjriajul/wzgram.git",
            ],
            check=False,
            timeout=120,
        )
        importlib.invalidate_caches()
        return _try_import_wzgram(auto_install=False)
    except Exception:
        return False


_try_import_wzgram(auto_install=False)


class UploadProgressTracker:
    """
    Tracks monotonic byte advancement, sliding-window live speed, smoothed ETA,
    and genuine byte-delta stall timestamps (ignores duplicate/0-delta callbacks).
    """

    def __init__(self, total_bytes: int, window_seconds: float = 5.0) -> None:
        self.total_bytes: int = max(0, int(total_bytes))
        self.window_seconds: float = window_seconds
        now = time.monotonic()
        self.start_mono: float = now
        self.last_advance_mono: float = now
        self.last_emit_mono: float = 0.0
        self.max_bytes: int = 0
        self.ema_speed_bps: float = 0.0
        self.samples: deque[tuple[float, int]] = deque([(now, 0)])

    def record(self, current_bytes: int, total_bytes: Optional[int] = None) -> Optional[Dict[str, Any]]:
        if total_bytes and total_bytes > 0:
            self.total_bytes = max(self.total_bytes, int(total_bytes))

        now = time.monotonic()
        raw_clamped = max(0, int(current_bytes))
        if self.total_bytes > 0:
            raw_clamped = min(raw_clamped, self.total_bytes)

        advanced = raw_clamped > self.max_bytes
        if advanced:
            self.max_bytes = raw_clamped
            self.last_advance_mono = now
            self.samples.append((now, self.max_bytes))

        cutoff = now - self.window_seconds
        while len(self.samples) > 2 and self.samples[0][0] < cutoff:
            self.samples.popleft()

        oldest_t, oldest_b = self.samples[0]
        dt = now - oldest_t
        if dt >= 0.25 and self.max_bytes > oldest_b:
            window_bps = (self.max_bytes - oldest_b) / dt
        else:
            elapsed = max(0.1, now - self.start_mono)
            window_bps = self.max_bytes / elapsed if self.max_bytes > 0 else 0.0

        if window_bps > 0:
            if self.ema_speed_bps <= 0:
                self.ema_speed_bps = window_bps
            else:
                self.ema_speed_bps = 0.35 * self.ema_speed_bps + 0.65 * window_bps

        is_upload_parts_done = self.total_bytes > 0 and self.max_bytes >= self.total_bytes
        if not is_upload_parts_done and (now - self.last_emit_mono) < 0.75:
            return None

        self.last_emit_mono = now
        speed_bps = self.ema_speed_bps if (now - self.last_advance_mono) < 4.5 else 0.0
        rem_bytes = max(0, self.total_bytes - self.max_bytes)
        eta_sec = (rem_bytes / speed_bps) if speed_bps > 0 else 0.0
        # Keep progress capped at 99.9% until messages.SendMedia confirms final delivery
        raw_pct = (self.max_bytes / max(1, self.total_bytes)) * 100.0
        pct = min(99.9, round(raw_pct, 1)) if is_upload_parts_done else round(raw_pct, 1)

        return {
            "percent": pct,
            "uploadedBytes": self.max_bytes,
            "totalBytes": self.total_bytes,
            "speedBps": speed_bps,
            "speed": format_speed(speed_bps),
            "eta": format_eta(eta_sec) if not is_upload_parts_done else "Finalizing",
        }

    def idle_seconds(self) -> float:
        return time.monotonic() - self.last_advance_mono

    def check_stalled_snapshot(self) -> Dict[str, Any]:
        raw_pct = (self.max_bytes / max(1, self.total_bytes)) * 100.0 if self.total_bytes > 0 else 0.0
        return {
            "percent": min(99.9, round(raw_pct, 1)),
            "uploadedBytes": self.max_bytes,
            "totalBytes": self.total_bytes,
            "speedBps": 0.0,
            "speed": "0 B/s",
            "eta": "--:--",
        }

URL_REGEX = re.compile(r"(https?://[^\s<>\"']+)", re.IGNORECASE)


def emit_event(event_type: str, payload: Dict[str, Any]) -> None:
    """Send structured JSON line to Node.js controller over stdout."""
    msg = {"event": event_type, "payload": payload, "ts": time.time()}
    try:
        sys.stdout.write("VELOFETCH_IPC:" + json.dumps(msg) + "\n")
        sys.stdout.flush()
    except Exception:
        pass


def format_bytes(num_bytes: float) -> str:
    if num_bytes <= 0:
        return "0 B"
    units = ["B", "KB", "MB", "GB", "TB"]
    idx = 0
    val = float(num_bytes)
    while val >= 1024 and idx < len(units) - 1:
        val /= 1024.0
        idx += 1
    return f"{val:.2f} {units[idx]}" if idx > 0 else f"{int(val)} B"


def format_speed(bytes_per_sec: float) -> str:
    if bytes_per_sec <= 0:
        return "0 B/s"
    units = ["B/s", "KB/s", "MB/s", "GB/s"]
    idx = 0
    val = float(bytes_per_sec)
    while val >= 1024 and idx < len(units) - 1:
        val /= 1024.0
        idx += 1
    return f"{val:.2f} {units[idx]}"


def format_eta(seconds: float) -> str:
    if seconds <= 0 or seconds > 86400:
        return "--:--"
    m = int(seconds // 60)
    s = int(seconds % 60)
    return f"{m:02d}:{s:02d}"


def extract_flood_wait_seconds(err_or_text: Any) -> int:
    val = getattr(err_or_text, "value", None) or getattr(err_or_text, "x", None)
    if isinstance(val, int) and val > 0:
        return val
    text = str(err_or_text)
    m = (
        re.search(r"FLOOD_WAIT_(\d+)", text, re.IGNORECASE)
        or re.search(r"retry after (\d+)", text, re.IGNORECASE)
        or re.search(r"wait of (\d+) seconds", text, re.IGNORECASE)
    )
    if m:
        return int(m.group(1))
    return 0


class TelegramRateLimiter:
    """Strict rate-limit governor for all Telegram API calls."""

    def __init__(self) -> None:
        self._global_lock = asyncio.Lock()
        self._last_global_ts: float = 0.0
        self._chat_last_ts: Dict[str, float] = {}
        self._edit_last_ts: Dict[str, float] = {}
        self._edit_last_text: Dict[str, str] = {}
        self.MIN_GLOBAL_INTERVAL = 0.04  # Max 25 req/s global
        self.MIN_CHAT_INTERVAL = 1.1     # Min 1.1s between messages in same chat
        self.MIN_EDIT_INTERVAL = 3.2     # Slightly below Node's 4.0s throttle to avoid clock jitter drops

    async def acquire_send_slot(self, chat_id: Any) -> None:
        chat_key = str(chat_id)
        async with self._global_lock:
            now = time.time()
            global_wait = (self._last_global_ts + self.MIN_GLOBAL_INTERVAL) - now
            last_chat = self._chat_last_ts.get(chat_key, 0.0)
            chat_wait = (last_chat + self.MIN_CHAT_INTERVAL) - now
            wait_for = max(0.0, global_wait, chat_wait)
            if wait_for > 0:
                await asyncio.sleep(wait_for)
            ts = time.time()
            self._last_global_ts = ts
            self._chat_last_ts[chat_key] = ts

    def can_edit_message(self, chat_id: Any, message_id: Any, text: str, is_final: bool = False) -> bool:
        msg_key = f"{chat_id}:{message_id}"
        if self._edit_last_text.get(msg_key) == text:
            return False
        now = time.time()
        last_edit = self._edit_last_ts.get(msg_key, 0.0)
        if not is_final and (now - last_edit) < self.MIN_EDIT_INTERVAL:
            return False
        self._edit_last_ts[msg_key] = now
        self._edit_last_text[msg_key] = text
        return True

    async def execute_with_flood_retry(
        self,
        coro_factory: Callable[[], Awaitable[Any]],
        max_retries: int = 3,
        max_auto_wait: int = 120,
    ) -> Any:
        attempt = 0
        while True:
            try:
                return await coro_factory()
            except asyncio.CancelledError:
                raise
            except Exception as exc:
                err_str = str(exc)
                if "MESSAGE_NOT_MODIFIED" in err_str:
                    return None
                wait_s = extract_flood_wait_seconds(exc)
                attempt += 1
                if wait_s > 0 and wait_s <= max_auto_wait and attempt <= max_retries:
                    await asyncio.sleep(wait_s + 1)
                    continue
                raise


def _sync_http_json(url: str, payload: Optional[Dict[str, Any]] = None, timeout: int = 20) -> Dict[str, Any]:
    """Zero-dependency synchronous JSON request via urllib.request."""
    data_bytes = None
    headers = {"Accept": "application/json"}
    if payload is not None:
        data_bytes = json.dumps(payload).encode("utf-8")
        headers["Content-Type"] = "application/json"
    req = urllib.request.Request(url, data=data_bytes, headers=headers, method="POST" if data_bytes else "GET")
    try:
        with urllib.request.urlopen(req, timeout=timeout) as resp:
            return json.loads(resp.read().decode("utf-8", errors="replace"))
    except urllib.error.HTTPError as he:
        body = he.read().decode("utf-8", errors="replace")
        try:
            return json.loads(body)
        except Exception:
            return {"ok": False, "error_code": he.code, "description": body or str(he)}
    except Exception as exc:
        return {"ok": False, "description": str(exc)}


class WzgramBotController:
    def __init__(self) -> None:
        self.poll_client: Optional[Client] = None
        self.client: Optional[Client] = None  # Single active MTProto Client session (polling + 1 upload at a time)
        self.bot_info: Dict[str, Any] = {}
        self.is_connected: bool = False
        self.active_transport: str = "none"  # "mtproto" or "bot_api"
        self.bot_token: str = os.environ.get("BOT_TOKEN", "")
        self.api_id: str = os.environ.get("API_ID", "")
        self.api_hash: str = os.environ.get("API_HASH", "")
        self.target_channel: str = os.environ.get("TARGET_CHANNEL", "")
        self.channels: list = []
        self.cancelled_jobs: set = set()
        self.pending_telegram_urls: Dict[str, Dict[str, Any]] = {}
        self.rate_limiter = TelegramRateLimiter()
        self._config_lock = asyncio.Lock()
        self._upload_semaphore = asyncio.Semaphore(1)
        self._active_creds_key: str = ""
        self._http_poll_task: Optional[asyncio.Task] = None
        self._flood_resume_task: Optional[asyncio.Task] = None
        self._last_update_id: int = 0
        self._resolved_peers: set = set()
        self._in_flight_job_ids: set = set()
        self._active_upload_tasks: Dict[str, asyncio.Task] = {}
        self._seen_message_keys: OrderedDict[str, float] = OrderedDict()
        self._seen_callback_ids: OrderedDict[str, float] = OrderedDict()

    def _is_self_or_outgoing_message(self, message: Any) -> bool:
        if message is None:
            return True
        if isinstance(message, dict):
            from_user = message.get("from") or {}
            sender_id = from_user.get("id")
            if from_user.get("is_bot") and sender_id and sender_id == self.bot_info.get("id"):
                return True
            return False
        if getattr(message, "outgoing", False):
            return True
        from_user = getattr(message, "from_user", None)
        bot_id = self.bot_info.get("id")
        if from_user is not None:
            if bot_id and getattr(from_user, "id", None) == bot_id:
                return True
            if getattr(from_user, "is_self", False):
                return True
        return False

    def _is_duplicate_message(self, chat_id: Any, msg_id: Any) -> bool:
        if chat_id is None or msg_id is None:
            return False
        key = f"{chat_id}:{msg_id}"
        if key in self._seen_message_keys:
            self._seen_message_keys.move_to_end(key)
            return True
        self._seen_message_keys[key] = time.monotonic()
        while len(self._seen_message_keys) > 4096:
            self._seen_message_keys.popitem(last=False)
        return False

    def _is_duplicate_callback(self, cq_id: Any) -> bool:
        if not cq_id:
            return False
        key = str(cq_id)
        if key in self._seen_callback_ids:
            self._seen_callback_ids.move_to_end(key)
            return True
        self._seen_callback_ids[key] = time.monotonic()
        while len(self._seen_callback_ids) > 4096:
            self._seen_callback_ids.popitem(last=False)
        return False

    def _get_selected_dest_label(self, info: Dict[str, Any], chat_id: Any) -> str:
        dest = info.get("destinationChatId") or "both"
        if dest == "both":
            if self.target_channel and self.target_channel != "@velofetch_media":
                return f"Bot Chat + Target Channel ({self.target_channel})"
            return f"Bot Private Chat ({chat_id})"
        if str(dest) == str(chat_id):
            return f"Bot Private Chat ({chat_id})"
        return f"Channel ({dest}) + Bot Chat Copy"

    def _build_combined_menu_dict(self, req_key: str, chat_id: Any) -> list:
        """
        Build an inline keyboard showing Quality Selection buttons for /ytdlp,
        plus a destination toggle row at the bottom.
        """
        info = self.pending_telegram_urls.get(req_key, {})
        dest_mode = info.get("destMode", "both")  # "both", "chat", "channel"

        rows = [
            [
                {
                    "text": "⚡ Best Quality (Auto Merge MP4)",
                    "callback_data": f"qual|{req_key}|best",
                }
            ],
            [
                {"text": "🎬 4K (2160p)", "callback_data": f"qual|{req_key}|2160p"},
                {"text": "🎬 2K (1440p)", "callback_data": f"qual|{req_key}|1440p"},
            ],
            [
                {"text": "📺 1080p Full HD", "callback_data": f"qual|{req_key}|1080p"},
                {"text": "📺 720p HD", "callback_data": f"qual|{req_key}|720p"},
            ],
            [
                {"text": "📱 480p SD", "callback_data": f"qual|{req_key}|480p"},
                {"text": "📱 360p Fast", "callback_data": f"qual|{req_key}|360p"},
            ],
        ]

        # Destination selector row
        has_channel = bool(self.target_channel and self.target_channel != "@velofetch_media")
        if has_channel:
            rows.append([
                {
                    "text": f"{'✅ ' if dest_mode == 'both' else ''}📥📤 Bot Chat + Channel",
                    "callback_data": f"setdest|{req_key}|both",
                },
                {
                    "text": f"{'✅ ' if dest_mode == 'chat' else ''}📥 Bot Chat Only",
                    "callback_data": f"setdest|{req_key}|chat",
                },
            ])
        return rows

    def _build_wzgram_combined_menu(self, req_key: str, chat_id: Any) -> list:
        raw_rows = self._build_combined_menu_dict(req_key, chat_id)
        return [
            [InlineKeyboardButton(btn["text"], callback_data=btn["callback_data"]) for btn in row]
            for row in raw_rows
        ]

    def _build_fetch_result_menu_dict(self, req_key: str, chat_id: Any) -> list:
        info = self.pending_telegram_urls.get(req_key, {})
        dest_mode = info.get("destMode", "both")
        fetched = info.get("fetchedResult") or {}
        links = fetched.get("directLinks") or []
        posts = fetched.get("discoveredPosts") or []
        view_mode = info.get("viewMode") or ("links" if len(links) > 0 else "posts")
        has_channel = bool(self.target_channel and self.target_channel != "@velofetch_media")

        rows = []

        if view_mode == "posts" and len(posts) > 0:
            batch_qual = str(info.get("batchQuality") or "1080p").lower()
            page = int(info.get("postsPage", 0))
            per_page = 5
            total_pages = max(1, (len(posts) + per_page - 1) // per_page)
            page = max(0, min(page, total_pages - 1))
            start_idx = page * per_page
            slice_posts = posts[start_idx : start_idx + per_page]

            # Batch Download & Upload Row 1
            batch_row_1 = [
                {
                    "text": f"🚀 Download Top {min(3, len(posts))} Posts",
                    "callback_data": f"fetchbatch|{req_key}|3",
                }
            ]
            if len(posts) > 3:
                batch_row_1.append({
                    "text": f"🚀 Download Top {min(5, len(posts))} Posts",
                    "callback_data": f"fetchbatch|{req_key}|5",
                })
            rows.append(batch_row_1)

            # Batch Download & Upload Row 2
            if len(posts) > 5:
                batch_row_2 = []
                if len(posts) > 10:
                    batch_row_2.append({
                        "text": "🚀 Top 10 Posts",
                        "callback_data": f"fetchbatch|{req_key}|10",
                    })
                batch_row_2.append({
                    "text": f"🚀 All ({len(posts)}) Posts",
                    "callback_data": f"fetchbatch|{req_key}|all",
                })
                rows.append(batch_row_2)

            # Individual Post Rows for current page
            for i, post in enumerate(slice_posts):
                abs_idx = start_idx + i
                raw_title = str(post.get("title") or f"Post #{abs_idx + 1}")
                short_title = (raw_title[:20] + "…") if len(raw_title) > 21 else raw_title
                rows.append([
                    {
                        "text": f"⬇️📤 #{abs_idx + 1}: {short_title}",
                        "callback_data": f"fetchpostdl|{req_key}|{abs_idx}",
                    },
                    {
                        "text": f"🔗 Direct Links #{abs_idx + 1}",
                        "callback_data": f"fetchpostinspect|{req_key}|{abs_idx}",
                    },
                ])

            # Pagination Row
            if total_pages > 1:
                nav_row = []
                if page > 0:
                    nav_row.append({
                        "text": "⬅️ Prev 5",
                        "callback_data": f"fetchpage|{req_key}|{page - 1}",
                    })
                nav_row.append({
                    "text": f"📄 Page {page + 1}/{total_pages}",
                    "callback_data": f"fetchpage|{req_key}|{page}",
                })
                if page < total_pages - 1:
                    nav_row.append({
                        "text": "Next 5 ➡️",
                        "callback_data": f"fetchpage|{req_key}|{page + 1}",
                    })
                rows.append(nav_row)

            # Quality Preset Selector Row for Batch/Post Downloads
            rows.append([
                {
                    "text": f"{'✅ ' if batch_qual == 'best' else ''}Best",
                    "callback_data": f"fetchqual|{req_key}|best",
                },
                {
                    "text": f"{'✅ ' if batch_qual == '1080p' else ''}1080p",
                    "callback_data": f"fetchqual|{req_key}|1080p",
                },
                {
                    "text": f"{'✅ ' if batch_qual == '720p' else ''}720p",
                    "callback_data": f"fetchqual|{req_key}|720p",
                },
                {
                    "text": f"{'✅ ' if batch_qual == '480p' else ''}480p",
                    "callback_data": f"fetchqual|{req_key}|480p",
                },
            ])

            if len(links) > 0:
                rows.append([
                    {
                        "text": f"🎬 View Direct Streams for Current Video ({len(links)})",
                        "callback_data": f"fetchmode|{req_key}|links",
                    }
                ])
        else:
            for idx, link in enumerate(links[:8]):
                qual = str(link.get("quality") or link.get("resolution") or "Stream").upper()
                ext = str(link.get("ext") or "mp4").upper()
                size_str = str(link.get("filesizeFormatted") or "Stream")
                btn_text = f"⬇️📤 {qual} {ext} ({size_str})"
                rows.append([
                    {
                        "text": btn_text,
                        "callback_data": f"fetchdl|{req_key}|{idx}",
                    }
                ])

            if len(posts) > 0:
                rows.append([
                    {
                        "text": f"📂 View All Posts Found on Page ({len(posts)} Posts)",
                        "callback_data": f"fetchmode|{req_key}|posts",
                    }
                ])

        if has_channel:
            rows.append([
                {
                    "text": f"{'✅ ' if dest_mode == 'both' else ''}📥📤 Bot Chat + Channel",
                    "callback_data": f"fetchdest|{req_key}|both",
                },
                {
                    "text": f"{'✅ ' if dest_mode == 'chat' else ''}📥 Bot Chat Only",
                    "callback_data": f"fetchdest|{req_key}|chat",
                },
            ])
        return rows

    def _build_wzgram_fetch_result_menu(self, req_key: str, chat_id: Any) -> list:
        raw_rows = self._build_fetch_result_menu_dict(req_key, chat_id)
        return [
            [InlineKeyboardButton(btn["text"], callback_data=btn["callback_data"]) for btn in row]
            for row in raw_rows
        ]

    def _format_fetch_result_html(self, req_key: str, chat_id: Any) -> str:
        info = self.pending_telegram_urls.get(req_key, {})
        fetched = info.get("fetchedResult") or {}
        title = html.escape(str(fetched.get("title") or "Extracted Media"))
        extractor = html.escape(str(fetched.get("extractor") or "Direct"))
        duration = html.escape(str(fetched.get("durationFormatted") or ""))
        links = fetched.get("directLinks") or []
        posts = fetched.get("discoveredPosts") or []
        view_mode = info.get("viewMode") or ("links" if len(links) > 0 else "posts")
        dest_label = html.escape(self._get_selected_dest_label(info, chat_id))

        if view_mode == "posts" and len(posts) > 0:
            batch_qual = html.escape(str(info.get("batchQuality") or "1080p").upper())
            page = int(info.get("postsPage", 0))
            per_page = 5
            total_pages = max(1, (len(posts) + per_page - 1) // per_page)
            page = max(0, min(page, total_pages - 1))
            start_idx = page * per_page
            slice_posts = posts[start_idx : start_idx + per_page]

            lines = [
                f"🌐 <b>Website Page Posts Extracted ({len(posts)} Posts Found)</b>",
                f"📄 <b>{title}</b> (Page {page + 1}/{total_pages})",
                "",
            ]
            for i, post in enumerate(slice_posts):
                abs_idx = start_idx + i
                p_title = html.escape(str(post.get("title") or f"Video Post #{abs_idx + 1}"))
                p_url = str(post.get("postUrl") or "")
                p_dur = html.escape(str(post.get("duration") or ""))
                p_qual = html.escape(str(post.get("qualityHint") or ""))
                meta_badge = " · ".join([x for x in [p_dur, p_qual] if x])
                badge_str = f" (<code>{meta_badge}</code>)" if meta_badge else ""
                lines.append(
                    f"{abs_idx + 1}. 🎬 <a href=\"{html.escape(p_url)}\"><b>{p_title}</b></a>{badge_str}\n"
                    f"<code>{html.escape(p_url)}</code>"
                )

            lines.extend([
                "",
                f"📍 <b>Upload To</b>: <code>{dest_label}</code> · 🎞 <b>Quality</b>: <code>{batch_qual}</code>",
                "👇 <b>Batch Download &amp; Upload Posts or Pick Individual Post:</b>",
            ])
            return "\n".join(lines)

        lines = [
            f"🔗 <b>Direct Download Links Extracted ({len(links)})</b>",
            f"🎬 <b>{title}</b>",
            f"🌐 Source: <code>{extractor}</code>" + (f" · ⏱ <code>{duration}</code>" if duration else ""),
            "",
        ]
        for idx, link in enumerate(links[:6]):
            qual = html.escape(str(link.get("quality") or "Best").upper())
            ext = html.escape(str(link.get("ext") or "mp4").upper())
            size_str = html.escape(str(link.get("filesizeFormatted") or "Stream"))
            d_url = str(link.get("directUrl") or "")
            lines.append(
                f"{idx + 1}. <b>{qual} {ext}</b> (<code>{size_str}</code>) — <a href=\"{html.escape(d_url)}\">Direct Link</a>\n"
                f"<code>{html.escape(d_url)}</code>"
            )

        lines.extend([
            "",
            f"📍 <b>Upload To</b>: <code>{dest_label}</code>",
            "👇 <b>Tap a stream below to Download &amp; Upload to Telegram:</b>",
        ])
        return "\n".join(lines)

    def _format_fetch_result_markdown(self, req_key: str, chat_id: Any) -> str:
        info = self.pending_telegram_urls.get(req_key, {})
        fetched = info.get("fetchedResult") or {}
        title = str(fetched.get("title") or "Extracted Media").replace("`", "'")
        extractor = str(fetched.get("extractor") or "Direct").replace("`", "'")
        duration = str(fetched.get("durationFormatted") or "")
        links = fetched.get("directLinks") or []
        posts = fetched.get("discoveredPosts") or []
        view_mode = info.get("viewMode") or ("links" if len(links) > 0 else "posts")
        dest_label = self._get_selected_dest_label(info, chat_id)

        if view_mode == "posts" and len(posts) > 0:
            batch_qual = str(info.get("batchQuality") or "1080p").upper()
            page = int(info.get("postsPage", 0))
            per_page = 5
            total_pages = max(1, (len(posts) + per_page - 1) // per_page)
            page = max(0, min(page, total_pages - 1))
            start_idx = page * per_page
            slice_posts = posts[start_idx : start_idx + per_page]

            lines = [
                f"🌐 **Website Page Posts Extracted ({len(posts)} Posts Found)**",
                f"📄 **{title}** (Page {page + 1}/{total_pages})",
                "",
            ]
            for i, post in enumerate(slice_posts):
                abs_idx = start_idx + i
                p_title = str(post.get("title") or f"Video Post #{abs_idx + 1}").replace("`", "'")
                p_url = str(post.get("postUrl") or "")
                p_dur = str(post.get("duration") or "")
                p_qual = str(post.get("qualityHint") or "")
                meta_badge = " · ".join([x for x in [p_dur, p_qual] if x])
                badge_str = f" (`{meta_badge}`)" if meta_badge else ""
                lines.append(
                    f"{abs_idx + 1}. 🎬 **{p_title}**{badge_str}\n"
                    f"`{p_url}`"
                )

            lines.extend([
                "",
                f"📍 **Upload To**: `{dest_label}` · 🎞 **Quality**: `{batch_qual}`",
                "👇 **Batch Download & Upload Posts or Pick Individual Post:**",
            ])
            return "\n".join(lines)

        lines = [
            f"🔗 **Direct Download Links Extracted ({len(links)})**",
            f"🎬 **{title}**",
            f"🌐 Source: `{extractor}`" + (f" · ⏱ `{duration}`" if duration else ""),
            "",
        ]
        for idx, link in enumerate(links[:6]):
            qual = str(link.get("quality") or "Best").upper()
            ext = str(link.get("ext") or "mp4").upper()
            size_str = str(link.get("filesizeFormatted") or "Stream")
            d_url = str(link.get("directUrl") or "")
            lines.append(
                f"{idx + 1}. **{qual} {ext}** (`{size_str}`)\n"
                f"`{d_url}`"
            )

        lines.extend([
            "",
            f"📍 **Upload To**: `{dest_label}`",
            "👇 **Tap a stream below to Download & Upload to Telegram:**",
        ])
        return "\n".join(lines)

    async def _refresh_fetch_view(self, req_key: str, chat_id: Any, msg_id: Any) -> None:
        target = int(chat_id) if str(chat_id).lstrip("-").isdigit() else chat_id
        rows = self._build_fetch_result_menu_dict(req_key, chat_id)
        text_html = self._format_fetch_result_html(req_key, chat_id)
        edited = await self._bot_api_call("editMessageText", {
            "chat_id": target,
            "message_id": int(msg_id),
            "text": text_html,
            "parse_mode": "HTML",
            "disable_web_page_preview": True,
            "reply_markup": {"inline_keyboard": rows},
        })
        if not edited and self.poll_client and self.active_transport == "mtproto":
            buttons = self._build_wzgram_fetch_result_menu(req_key, chat_id)
            text_md = self._format_fetch_result_markdown(req_key, chat_id)
            await self.rate_limiter.acquire_send_slot(target)
            await self.rate_limiter.execute_with_flood_retry(
                lambda: self.poll_client.edit_message_text(
                    chat_id=target,
                    message_id=int(msg_id),
                    text=text_md,
                    disable_web_page_preview=True,
                    reply_markup=InlineKeyboardMarkup(buttons),
                )
            )

    def _get_session_dir_and_hash(self) -> tuple[str, str]:
        session_dir = os.path.join(os.getcwd(), "database", "sessions")
        os.makedirs(session_dir, exist_ok=True)
        token_hash = hashlib.sha256(self.bot_token.encode()).hexdigest()[:10]
        return session_dir, token_hash

    async def _stop_poll_client(self) -> None:
        self._resolved_peers.clear()
        if self.poll_client:
            try:
                sess = getattr(self.poll_client, "session", None)
                if sess is not None and getattr(self.poll_client, "is_connected", False):
                    await asyncio.wait_for(sess.flush_acks(), timeout=1.5)
            except Exception:
                pass
            try:
                await asyncio.wait_for(self.poll_client.stop(), timeout=8.0)
            except Exception:
                pass
            self.poll_client = None
        self.client = None

    async def shutdown(self) -> None:
        if self._flood_resume_task and not self._flood_resume_task.done():
            self._flood_resume_task.cancel()
        if self._http_poll_task and not self._http_poll_task.done():
            self._http_poll_task.cancel()
        for task in list(self._active_upload_tasks.values()):
            if not task.done():
                task.cancel()
        await self._stop_poll_client()

    async def configure_and_start(self, config: Dict[str, Any]) -> None:
        async with self._config_lock:
            new_token = str(config.get("botToken") or self.bot_token or os.environ.get("BOT_TOKEN") or "").strip()
            new_api_id = str(config.get("apiId") or self.api_id or os.environ.get("API_ID") or "").strip()
            new_api_hash = str(config.get("apiHash") or self.api_hash or os.environ.get("API_HASH") or "").strip()
            new_target = str(config.get("targetChannel") or self.target_channel or os.environ.get("TARGET_CHANNEL") or "").strip()
            force = bool(config.get("force", False))

            self.target_channel = new_target
            if "channels" in config and isinstance(config["channels"], list):
                self.channels = config["channels"]

            await asyncio.to_thread(_try_import_wzgram, False)

            new_creds_key = f"{new_token}|{new_api_id}|{new_api_hash}"

            # Only skip restart if already connected via MTProto on our single active session
            if (
                not force
                and self.is_connected
                and (
                    (self.active_transport == "mtproto" and self.client and getattr(self.client, "is_connected", False))
                    or not WZGRAM_AVAILABLE
                )
                and new_creds_key == self._active_creds_key
                and new_token
            ):
                return

            self.bot_token = new_token
            self.api_id = new_api_id
            self.api_hash = new_api_hash

            if self._flood_resume_task and not self._flood_resume_task.done():
                self._flood_resume_task.cancel()
                self._flood_resume_task = None

            if self._http_poll_task and not self._http_poll_task.done():
                self._http_poll_task.cancel()
                self._http_poll_task = None

            await self._stop_poll_client()

            self.is_connected = False
            self.active_transport = "none"

            if not self.bot_token:
                emit_event("bot_status", {
                    "online": False,
                    "mode": "standby_unconfigured",
                    "wzgramVersion": WZGRAM_VERSION,
                    "message": f"Wzgram {WZGRAM_VERSION} ready — configure BOT_TOKEN in Settings to enable live Telegram bot polling.",
                })
                return

            if WZGRAM_AVAILABLE and self.api_id and self.api_hash:
                try:
                    api_id_int = int(self.api_id)
                    session_dir, token_hash = self._get_session_dir_and_hash()
                    poll_session_name = f"wzgram_bot_{token_hash}"

                    poll_app = Client(
                        name=poll_session_name,
                        api_id=api_id_int,
                        api_hash=self.api_hash,
                        bot_token=self.bot_token,
                        workdir=session_dir,
                        in_memory=False,
                        no_updates=False,
                        skip_updates=True,
                        sleep_threshold=60,
                        workers=4,
                        max_concurrent_transmissions=1,
                    )
                    self._register_wzgram_handlers(poll_app)
                    await poll_app.start()
                    if getattr(poll_app, "session", None) is not None:
                        poll_app.session.ACKS_THRESHOLD = 1
                    self.poll_client = poll_app
                    self.client = poll_app
                    me = await poll_app.get_me()

                    self.is_connected = True
                    self.active_transport = "mtproto"
                    self._active_creds_key = new_creds_key
                    self.bot_info = {
                        "id": me.id,
                        "username": getattr(me, "username", "velofetch_bot"),
                        "firstName": getattr(me, "first_name", "VeloFetch Bot"),
                    }
                    asyncio.create_task(self._register_bot_commands())
                    asyncio.create_task(self._prewarm_media_pool())
                    emit_event("bot_status", {
                        "online": True,
                        "mode": "mtproto_polling",
                        "wzgramVersion": WZGRAM_VERSION,
                        "botInfo": self.bot_info,
                        "message": f"Connected as @{self.bot_info['username']} via Wzgram {WZGRAM_VERSION} (Single-Session · 1 Download + 1 Upload Worker)",
                    })
                    return
                except Exception as mtproto_exc:
                    err_text = str(mtproto_exc)
                    await self._stop_poll_client()
                    wait_sec = extract_flood_wait_seconds(err_text)
                    if wait_sec > 0:
                        self._flood_resume_task = asyncio.create_task(self._schedule_flood_auto_resume(wait_sec))
                    await self._start_http_bot_fallback(new_creds_key, reason=err_text)
                    return

            await self._start_http_bot_fallback(new_creds_key, reason="Direct Bot Token Mode")

    async def _prewarm_media_pool(self) -> None:
        """Pre-warm the multi-socket MTProto media upload pool on the single active MTProto session."""
        target_client = self.client
        if not target_client or self.active_transport != "mtproto":
            return
        try:
            dc_id = await target_client.storage.dc_id()
            pool_size = int(os.environ.get("WZGRAM_UPLOAD_POOL_BOT", 12))
            async with target_client._media_pool(dc_id, pool_size) as pool_task:
                await pool_task
            if self.target_channel and self.target_channel not in ("@velofetch_media", "me"):
                t_peer = int(self.target_channel) if str(self.target_channel).lstrip("-").isdigit() else self.target_channel
                try:
                    await self._ensure_peer_on_client(t_peer)
                except Exception:
                    pass
        except Exception:
            pass

    async def _register_bot_commands(self) -> None:
        if not self.bot_token:
            return
        try:
            url = f"https://api.telegram.org/bot{self.bot_token}/setMyCommands"
            payload = {
                "commands": [
                    {"command": "start", "description": "Welcome & command guide"},
                    {"command": "ytdlp", "description": "Download & upload video via yt-dlp + aria2c"},
                    {"command": "fetch", "description": "Fetch all posts or direct download links from a site URL"},
                    {"command": "help", "description": "Show bot commands & usage examples"},
                ]
            }
            await asyncio.to_thread(_sync_http_json, url, payload, 8)
        except Exception:
            pass

    async def _schedule_flood_auto_resume(self, wait_seconds: int) -> None:
        try:
            await asyncio.sleep(wait_seconds + 2)
            await self.configure_and_start({"force": True})
        except asyncio.CancelledError:
            pass

    async def _start_http_bot_fallback(self, creds_key: str, reason: str = "") -> None:
        try:
            get_me_url = f"https://api.telegram.org/bot{self.bot_token}/getMe"
            data = await asyncio.to_thread(_sync_http_json, get_me_url, None, 10)
            if not data.get("ok"):
                raise RuntimeError(data.get("description", "Invalid BOT_TOKEN"))
            result = data["result"]
            self.bot_info = {
                "id": result.get("id"),
                "username": result.get("username", "velofetch_bot"),
                "firstName": result.get("first_name", "VeloFetch Bot"),
            }

            del_wh_url = f"https://api.telegram.org/bot{self.bot_token}/deleteWebhook"
            await asyncio.to_thread(_sync_http_json, del_wh_url, {}, 8)
            asyncio.create_task(self._register_bot_commands())

            self.is_connected = True
            self.active_transport = "bot_api"
            self._active_creds_key = creds_key
            self._http_poll_task = asyncio.create_task(self._http_poll_loop())

            emit_event("bot_status", {
                "online": True,
                "mode": "hybrid_polling",
                "wzgramVersion": WZGRAM_VERSION,
                "botInfo": self.bot_info,
                "message": f"Connected as @{self.bot_info['username']} (Commands /ytdlp & /fetch Active)",
            })
        except Exception as exc:
            self.is_connected = False
            err_msg = str(exc) or reason
            wait_sec = extract_flood_wait_seconds(err_msg) or extract_flood_wait_seconds(reason)
            if wait_sec > 0:
                mins = max(1, round(wait_sec / 60))
                emit_event("bot_status", {
                    "online": False,
                    "mode": "flood_wait",
                    "wzgramVersion": WZGRAM_VERSION,
                    "message": f"Telegram Rate Limit Cooldown ({wait_sec}s / ~{mins}m remaining). Auto-reconnect scheduled when timer expires.",
                })
                self._flood_resume_task = asyncio.create_task(self._schedule_flood_auto_resume(wait_sec))
            else:
                emit_event("bot_status", {
                    "online": False,
                    "mode": "auth_error",
                    "wzgramVersion": WZGRAM_VERSION,
                    "message": f"Telegram connection failed: {err_msg}",
                })

    async def _bot_api_call(
        self,
        method: str,
        payload: Dict[str, Any],
        respect_chat_limit: bool = True,
    ) -> Optional[Dict[str, Any]]:
        if not self.bot_token:
            return None

        chat_id = payload.get("chat_id")
        if respect_chat_limit and chat_id is not None:
            await self.rate_limiter.acquire_send_slot(chat_id)

        url = f"https://api.telegram.org/bot{self.bot_token}/{method}"
        req_payload = dict(payload)
        for attempt in range(3):
            data = await asyncio.to_thread(_sync_http_json, url, req_payload, 15)
            if data.get("ok"):
                return data.get("result")
            desc = str(data.get("description", ""))
            # If Markdown/HTML entity parsing fails due to special characters in URL/title, retry plain text immediately
            if "can't parse entities" in desc.lower() and "parse_mode" in req_payload:
                req_payload.pop("parse_mode", None)
                continue
            retry_after = data.get("parameters", {}).get("retry_after") or extract_flood_wait_seconds(desc)
            if retry_after and int(retry_after) <= 120 and attempt < 2:
                await asyncio.sleep(int(retry_after) + 1)
                continue
            return data
        return None

    async def _http_poll_loop(self) -> None:
        while self.is_connected and self.active_transport == "bot_api":
            try:
                url = f"https://api.telegram.org/bot{self.bot_token}/getUpdates"
                params = {
                    "offset": self._last_update_id + 1,
                    "timeout": 15,
                    "allowed_updates": ["message", "callback_query"],
                }
                data = await asyncio.to_thread(_sync_http_json, url, params, 22)
                if not data.get("ok"):
                    retry_after = data.get("parameters", {}).get("retry_after", 3)
                    await asyncio.sleep(min(60, max(2, int(retry_after))))
                    continue
                updates = data.get("result", [])
                for upd in updates:
                    upd_id = upd.get("update_id", 0)
                    if upd_id > self._last_update_id:
                        self._last_update_id = upd_id
                    asyncio.create_task(self._handle_raw_update(upd))
            except asyncio.CancelledError:
                break
            except Exception:
                await asyncio.sleep(3)

    async def _handle_raw_update(self, upd: Dict[str, Any]) -> None:
        if "message" in upd:
            msg = upd["message"]
            if self._is_self_or_outgoing_message(msg):
                return
            chat_id = msg.get("chat", {}).get("id")
            msg_id = msg.get("message_id")
            text = (msg.get("text") or "").strip()
            if not chat_id or not text:
                return

            # Only accept commands starting with '/' (ignore bare links)
            if not text.startswith("/"):
                return

            if self._is_duplicate_message(chat_id, msg_id):
                return

            cmd_token = text.split()[0].lower().split("@")[0]

            if cmd_token in ("/start", "/help"):
                welcome = (
                    "⚡ <b>VeloFetch — Telegram Video Downloader &amp; Uploader</b>\n\n"
                    "Use one of the commands below with your link:\n\n"
                    "• <b>/ytdlp &lt;video_url&gt;</b>: Download &amp; upload video via <code>yt-dlp</code> + <code>aria2c</code> with quality selection (<code>Best</code>, <code>4K</code>, <code>2K</code>, <code>1080p</code>, <code>720p</code>, <code>480p</code>, <code>360p</code>)\n"
                    "• <b>/fetch &lt;site_or_post_url&gt;</b>: Crawl all video post links from a website/category page or extract direct download streams from a post URL\n\n"
                    "<i>Tip: You can also reply <code>/ytdlp</code> or <code>/fetch</code> to any message containing a URL.</i>"
                )
                await self._bot_api_call("sendMessage", {
                    "chat_id": chat_id,
                    "text": welcome,
                    "parse_mode": "HTML",
                    "reply_to_message_id": msg_id,
                })
                return

            if cmd_token in ("/ytdlp", "/ytdl"):
                reply_text = (msg.get("reply_to_message") or {}).get("text") or ""
                match = URL_REGEX.search(text) or URL_REGEX.search(reply_text)
                if not match:
                    await self._bot_api_call("sendMessage", {
                        "chat_id": chat_id,
                        "text": (
                            "🎬 <b>Video Downloader (/ytdlp)</b>\n\n"
                            "Send <code>/ytdlp</code> followed by any video URL:\n"
                            "<code>/ytdlp https://www.eporner.com/video-CeH7wwgZKGL/tori/</code>\n\n"
                            "<i>Or reply <code>/ytdlp</code> to any message containing a video URL.</i>"
                        ),
                        "parse_mode": "HTML",
                        "reply_to_message_id": msg_id,
                    })
                    return

                url = match.group(1)
                req_key = f"{chat_id}_{msg_id}"
                has_channel = bool(self.target_channel and self.target_channel != "@velofetch_media")
                self.pending_telegram_urls[req_key] = {
                    "url": url,
                    "chatId": str(chat_id),
                    "messageId": msg_id,
                    "destMode": "both" if has_channel else "chat",
                    "destinationChatId": self.target_channel if has_channel else str(chat_id),
                }

                rows = self._build_combined_menu_dict(req_key, chat_id)
                dest_label = self._get_selected_dest_label(self.pending_telegram_urls[req_key], chat_id)
                sent = await self._bot_api_call("sendMessage", {
                    "chat_id": chat_id,
                    "text": (
                        f"🎬 <b>yt-dlp Video Downloader</b>\n"
                        f"<code>{html.escape(url)}</code>\n\n"
                        f"📍 <b>Upload To</b>: <code>{html.escape(dest_label)}</code>\n"
                        f"👇 <b>Select Video Quality to Download &amp; Upload:</b>"
                    ),
                    "parse_mode": "HTML",
                    "reply_to_message_id": msg_id,
                    "reply_markup": {"inline_keyboard": rows},
                })
                if sent and isinstance(sent, dict) and "message_id" in sent:
                    self.pending_telegram_urls[req_key]["promptMessageId"] = sent["message_id"]
                return

            if cmd_token == "/fetch":
                reply_text = (msg.get("reply_to_message") or {}).get("text") or ""
                match = URL_REGEX.search(text) or URL_REGEX.search(reply_text)
                if not match:
                    await self._bot_api_call("sendMessage", {
                        "chat_id": chat_id,
                        "text": (
                            "🔗 <b>Website Post Crawler &amp; Direct Link Extractor (/fetch)</b>\n\n"
                            "Send <code>/fetch</code> followed by any Website URL or Video Post URL:\n"
                            "• <code>/fetch https://www.eporner.com/</code> <i>(Fetch all posts from site)</i>\n"
                            "• <code>/fetch https://www.eporner.com/video-CeH7wwgZKGL/tori/</code> <i>(Extract direct streams)</i>\n\n"
                            "<i>Or reply <code>/fetch</code> to any message containing a URL.</i>"
                        ),
                        "parse_mode": "HTML",
                        "reply_to_message_id": msg_id,
                    })
                    return

                url = match.group(1)
                req_key = f"{chat_id}_{msg_id}"
                has_channel = bool(self.target_channel and self.target_channel != "@velofetch_media")
                self.pending_telegram_urls[req_key] = {
                    "url": url,
                    "chatId": str(chat_id),
                    "messageId": msg_id,
                    "destMode": "both" if has_channel else "chat",
                    "destinationChatId": self.target_channel if has_channel else str(chat_id),
                }
                sent = await self._bot_api_call("sendMessage", {
                    "chat_id": chat_id,
                    "text": (
                        f"🔍 <b>Scanning Page for Video Posts &amp; Direct Links...</b>\n"
                        f"<code>{html.escape(url)}</code>\n\n"
                        f"Crawling page DOM, post cards &amp; stream manifests..."
                    ),
                    "parse_mode": "HTML",
                    "reply_to_message_id": msg_id,
                })
                prompt_msg_id = sent.get("message_id", msg_id) if isinstance(sent, dict) else msg_id
                self.pending_telegram_urls[req_key]["promptMessageId"] = prompt_msg_id
                emit_event("telegram_fetch_request", {
                    "reqKey": req_key,
                    "url": url,
                    "telegramChatId": str(chat_id),
                    "telegramMessageId": prompt_msg_id,
                })
                return

        elif "callback_query" in upd:
            cq = upd["callback_query"]
            cq_id = cq.get("id")
            if self._is_duplicate_callback(cq_id):
                return
            data = cq.get("data") or ""
            msg = cq.get("message") or {}
            chat_id = msg.get("chat", {}).get("id")
            msg_id = msg.get("message_id")
            parts = data.split("|")
            action = parts[0]

            if action == "setdest" and len(parts) >= 3:
                req_key = parts[1]
                mode = parts[2]
                info = self.pending_telegram_urls.get(req_key)
                if not info:
                    await self._bot_api_call("answerCallbackQuery", {
                        "callback_query_id": cq_id,
                        "text": "Session expired, please resend the command.",
                        "show_alert": True,
                    }, respect_chat_limit=False)
                    return

                info["destMode"] = mode
                if mode == "chat":
                    info["destinationChatId"] = str(chat_id)
                else:
                    info["destinationChatId"] = self.target_channel or str(chat_id)

                await self._bot_api_call("answerCallbackQuery", {
                    "callback_query_id": cq_id,
                    "text": "Updated upload destination!",
                }, respect_chat_limit=False)

                rows = self._build_combined_menu_dict(req_key, chat_id)
                dest_label = self._get_selected_dest_label(info, chat_id)
                await self._bot_api_call("editMessageText", {
                    "chat_id": chat_id,
                    "message_id": msg_id,
                    "text": (
                        f"🎬 <b>yt-dlp Video Downloader</b>\n"
                        f"<code>{html.escape(info['url'])}</code>\n\n"
                        f"📍 <b>Upload To</b>: <code>{html.escape(dest_label)}</code>\n"
                        f"👇 <b>Select Video Quality to Download &amp; Upload:</b>"
                    ),
                    "parse_mode": "HTML",
                    "reply_markup": {"inline_keyboard": rows},
                })

            elif action.startswith("fetch"):
                async def _ans_http(txt: str, alert: bool = False):
                    await self._bot_api_call("answerCallbackQuery", {
                        "callback_query_id": cq_id,
                        "text": txt,
                        "show_alert": alert,
                    }, respect_chat_limit=False)

                await self._process_fetch_callback(action, parts, chat_id, msg_id, _ans_http)

            elif action == "qual" and len(parts) >= 3:
                req_key = parts[1]
                quality = parts[2]
                info = self.pending_telegram_urls.get(req_key)
                if not info:
                    await self._bot_api_call("answerCallbackQuery", {
                        "callback_query_id": cq_id,
                        "text": "Session expired, please resend the command.",
                        "show_alert": True,
                    }, respect_chat_limit=False)
                    return

                dest_chat_id = info.get("destinationChatId") or str(chat_id)
                dest_label = self._get_selected_dest_label(info, chat_id)
                await self._bot_api_call("answerCallbackQuery", {
                    "callback_query_id": cq_id,
                    "text": f"Starting {quality.upper()} download!",
                }, respect_chat_limit=False)

                await self._bot_api_call("editMessageText", {
                    "chat_id": chat_id,
                    "message_id": msg_id,
                    "text": (
                        f"⏳ <b>Queued in VeloFetch</b>\n"
                        f"URL: <code>{html.escape(info['url'])}</code>\n"
                        f"Quality: <code>{html.escape(quality.upper())}</code>\n"
                        f"Upload To: <code>{html.escape(dest_label)}</code>\n\n"
                        f"Launching <code>yt-dlp</code> + <code>aria2c</code> (16x)..."
                    ),
                    "parse_mode": "HTML",
                })
                emit_event("telegram_job_request", {
                    "url": info["url"],
                    "quality": quality,
                    "formatId": quality,
                    "destinationChatId": dest_chat_id,
                    "telegramChatId": str(chat_id),
                    "telegramMessageId": msg_id,
                })

            elif action == "cancel" and len(parts) >= 2:
                job_id = parts[1]
                self.cancel_job(job_id)
                await self._bot_api_call("answerCallbackQuery", {
                    "callback_query_id": cq_id,
                    "text": "Cancelling job...",
                }, respect_chat_limit=False)
                emit_event("telegram_cancel_job", {"jobId": job_id})

            elif action == "retry" and len(parts) >= 2:
                job_id = parts[1]
                await self._bot_api_call("answerCallbackQuery", {
                    "callback_query_id": cq_id,
                    "text": "Retrying job...",
                }, respect_chat_limit=False)
                emit_event("telegram_retry_job", {"jobId": job_id})

    async def _process_fetch_callback(
        self,
        action: str,
        parts: list,
        chat_id: Any,
        msg_id: Any,
        answer_cb: Any,
    ) -> None:
        if action == "fetchnow" and len(parts) >= 2:
            req_key = parts[1]
            info = self.pending_telegram_urls.get(req_key)
            if not info:
                await answer_cb("Session expired, please resend the URL.", True)
                return

            await answer_cb("Scanning page for posts & direct links...", False)
            info["promptMessageId"] = msg_id
            await self._bot_api_call("editMessageText", {
                "chat_id": chat_id,
                "message_id": msg_id,
                "text": (
                    f"🔍 <b>Scanning Page for Video Posts &amp; Direct Links...</b>\n"
                    f"<code>{html.escape(info['url'])}</code>\n\n"
                    f"Crawling page DOM, post cards &amp; stream manifests..."
                ),
                "parse_mode": "HTML",
            })
            emit_event("telegram_fetch_request", {
                "reqKey": req_key,
                "url": info["url"],
                "telegramChatId": str(chat_id),
                "telegramMessageId": msg_id,
            })
            return

        if action == "fetchdest" and len(parts) >= 3:
            req_key = parts[1]
            mode = parts[2]
            info = self.pending_telegram_urls.get(req_key)
            if not info or not info.get("fetchedResult"):
                await answer_cb("Session expired, please run /fetch again.", True)
                return

            info["destMode"] = mode
            if mode == "chat":
                info["destinationChatId"] = str(chat_id)
            else:
                info["destinationChatId"] = self.target_channel or str(chat_id)

            await answer_cb("Updated upload destination!", False)
            await self._refresh_fetch_view(req_key, chat_id, msg_id)
            return

        if action == "fetchmode" and len(parts) >= 3:
            req_key = parts[1]
            new_mode = parts[2]
            info = self.pending_telegram_urls.get(req_key)
            if not info or not info.get("fetchedResult"):
                await answer_cb("Session expired, please run /fetch again.", True)
                return

            info["viewMode"] = new_mode
            await answer_cb(f"Switched to {new_mode} view", False)
            await self._refresh_fetch_view(req_key, chat_id, msg_id)
            return

        if action == "fetchpage" and len(parts) >= 3:
            req_key = parts[1]
            page = int(parts[2])
            info = self.pending_telegram_urls.get(req_key)
            if not info or not info.get("fetchedResult"):
                await answer_cb("Session expired, please run /fetch again.", True)
                return

            info["postsPage"] = page
            info["viewMode"] = "posts"
            await answer_cb(f"Page {page + 1}", False)
            await self._refresh_fetch_view(req_key, chat_id, msg_id)
            return

        if action == "fetchqual" and len(parts) >= 3:
            req_key = parts[1]
            qual = parts[2]
            info = self.pending_telegram_urls.get(req_key)
            if not info or not info.get("fetchedResult"):
                await answer_cb("Session expired, please run /fetch again.", True)
                return

            info["batchQuality"] = qual
            await answer_cb(f"Batch quality set to {qual.upper()}!", False)
            await self._refresh_fetch_view(req_key, chat_id, msg_id)
            return

        if action == "fetchbatch" and len(parts) >= 3:
            req_key = parts[1]
            count_str = parts[2]
            info = self.pending_telegram_urls.get(req_key)
            fetched = (info or {}).get("fetchedResult") or {}
            posts = fetched.get("discoveredPosts") or []
            if not info or not posts:
                await answer_cb("Session expired, please run /fetch again.", True)
                return

            selected = posts if count_str == "all" else posts[: max(1, int(count_str))]
            batch_qual = str(info.get("batchQuality") or "1080p")
            dest_chat_id = info.get("destinationChatId") or str(chat_id)
            dest_label = self._get_selected_dest_label(info, chat_id)

            await answer_cb(f"Queueing {len(selected)} posts for download & upload!", False)
            await self._bot_api_call("editMessageText", {
                "chat_id": chat_id,
                "message_id": msg_id,
                "text": (
                    f"🚀 <b>Batch Queued {len(selected)} Video Posts in VeloFetch</b>\n"
                    f"🌐 Source: <code>{html.escape(str(fetched.get('domain') or info['url']))}</code>\n"
                    f"🎞 Quality: <code>{html.escape(batch_qual.upper())}</code>\n"
                    f"📍 Upload To: <code>{html.escape(dest_label)}</code>\n\n"
                    f"Extracting direct video links &amp; launching <code>aria2c</code> (16x) + Wzgram uploads..."
                ),
                "parse_mode": "HTML",
            })
            emit_event("telegram_batch_job_request", {
                "posts": selected,
                "quality": batch_qual,
                "destinationChatId": dest_chat_id,
                "telegramChatId": str(chat_id),
                "telegramMessageId": msg_id,
            })
            return

        if action == "fetchpostdl" and len(parts) >= 3:
            req_key = parts[1]
            idx = int(parts[2])
            info = self.pending_telegram_urls.get(req_key)
            fetched = (info or {}).get("fetchedResult") or {}
            posts = fetched.get("discoveredPosts") or []
            if not info or idx < 0 or idx >= len(posts):
                await answer_cb("Session expired, please run /fetch again.", True)
                return

            post = posts[idx]
            post_url = post.get("postUrl") or info["url"]
            title = str(post.get("title") or f"Post #{idx + 1}")
            thumb_url = str(post.get("thumbnail") or "")
            batch_qual = str(info.get("batchQuality") or "1080p")
            dest_chat_id = info.get("destinationChatId") or str(chat_id)
            dest_label = self._get_selected_dest_label(info, chat_id)

            await answer_cb(f"Queueing Post #{idx + 1} ({batch_qual.upper()})!", False)
            await self._bot_api_call("editMessageText", {
                "chat_id": chat_id,
                "message_id": msg_id,
                "text": (
                    f"⏳ <b>Queued Post #{idx + 1} in VeloFetch</b>\n"
                    f"🎬 <b>{html.escape(title)}</b>\n"
                    f"🔗 Post: <code>{html.escape(post_url)}</code>\n"
                    f"🎞 Quality: <code>{html.escape(batch_qual.upper())}</code>\n"
                    f"📍 Upload To: <code>{html.escape(dest_label)}</code>\n\n"
                    f"Resolving direct stream &amp; launching <code>aria2c</code> (16x)..."
                ),
                "parse_mode": "HTML",
            })
            emit_event("telegram_job_request", {
                "url": post_url,
                "title": title,
                "extractor": "Post Crawler",
                "thumbnailUrl": thumb_url,
                "quality": batch_qual,
                "formatId": batch_qual,
                "destinationChatId": dest_chat_id,
                "telegramChatId": str(chat_id),
                "telegramMessageId": msg_id,
            })
            return

        if action == "fetchpostinspect" and len(parts) >= 3:
            req_key = parts[1]
            idx = int(parts[2])
            info = self.pending_telegram_urls.get(req_key)
            fetched = (info or {}).get("fetchedResult") or {}
            posts = fetched.get("discoveredPosts") or []
            if not info or idx < 0 or idx >= len(posts):
                await answer_cb("Session expired, please run /fetch again.", True)
                return

            post = posts[idx]
            post_url = post.get("postUrl") or info["url"]
            title = str(post.get("title") or f"Post #{idx + 1}")
            info["url"] = post_url
            info["fallbackThumbnail"] = str(post.get("thumbnail") or "")
            info["fallbackTitle"] = title
            info["viewMode"] = "links"

            await answer_cb(f"Extracting direct links for Post #{idx + 1}...", False)
            await self._bot_api_call("editMessageText", {
                "chat_id": chat_id,
                "message_id": msg_id,
                "text": (
                    f"🔍 <b>Extracting Direct Download Links for Post #{idx + 1}...</b>\n"
                    f"🎬 <b>{html.escape(title)}</b>\n"
                    f"<code>{html.escape(post_url)}</code>"
                ),
                "parse_mode": "HTML",
            })
            emit_event("telegram_fetch_request", {
                "reqKey": req_key,
                "url": post_url,
                "telegramChatId": str(chat_id),
                "telegramMessageId": msg_id,
            })
            return

        if action == "fetchdl" and len(parts) >= 3:
            req_key = parts[1]
            idx = int(parts[2])
            info = self.pending_telegram_urls.get(req_key)
            fetched = (info or {}).get("fetchedResult") or {}
            links = fetched.get("directLinks") or []
            if not info or idx < 0 or idx >= len(links):
                await answer_cb("Session expired, please run /fetch again.", True)
                return

            link = links[idx]
            direct_url = link.get("directUrl") or info["url"]
            quality = str(link.get("quality") or "best")
            size_str = str(link.get("filesizeFormatted") or "Stream")
            title = str(fetched.get("title") or "Direct Video")
            extractor = str(fetched.get("extractor") or "Direct")
            thumb_url = str(fetched.get("thumbnail") or "")
            dest_chat_id = info.get("destinationChatId") or str(chat_id)
            dest_label = self._get_selected_dest_label(info, chat_id)

            await answer_cb(f"Starting {quality.upper()} ({size_str}) direct download!", False)
            await self._bot_api_call("editMessageText", {
                "chat_id": chat_id,
                "message_id": msg_id,
                "text": (
                    f"⏳ <b>Queued Direct Link in VeloFetch</b>\n"
                    f"🎬 <b>{html.escape(title)}</b>\n"
                    f"🎞 Stream: <code>{html.escape(quality.upper())} ({html.escape(size_str)})</code>\n"
                    f"📍 Upload To: <code>{html.escape(dest_label)}</code>\n\n"
                    f"Launching <code>aria2c</code> (16x) direct download &amp; Wzgram upload..."
                ),
                "parse_mode": "HTML",
            })
            emit_event("telegram_job_request", {
                "url": direct_url,
                "title": title,
                "extractor": f"{extractor} Direct ({quality})",
                "thumbnailUrl": thumb_url,
                "quality": quality,
                "formatId": "best",
                "destinationChatId": dest_chat_id,
                "telegramChatId": str(chat_id),
                "telegramMessageId": msg_id,
            })

    def _register_wzgram_handlers(self, app: Client) -> None:
        if getattr(app, "_velofetch_handlers_registered", False):
            return
        setattr(app, "_velofetch_handlers_registered", True)

        @app.on_message(filters.command(["start", "help"]))
        async def start_handler(client: Client, message: Message):
            if self._is_self_or_outgoing_message(message):
                return
            if self._is_duplicate_message(getattr(message.chat, "id", None), getattr(message, "id", None)):
                return
            await self.rate_limiter.acquire_send_slot(message.chat.id)
            welcome = (
                "⚡ **VeloFetch — Telegram Video Downloader & Uploader**\n\n"
                "Use one of the commands below with your link:\n\n"
                "• **/ytdlp <video_url>**: Download & upload video via `yt-dlp` + `aria2c` with quality selection (`Best`, `4K`, `2K`, `1080p`, `720p`, `480p`, `360p`)\n"
                "• **/fetch <site_or_post_url>**: Crawl all video post links from a website/category page or extract direct download streams from a post URL\n\n"
                "_Tip: You can also reply `/ytdlp` or `/fetch` to any message containing a URL._"
            )
            await self.rate_limiter.execute_with_flood_retry(lambda: message.reply_text(welcome))

        @app.on_message(filters.command(["ytdlp", "ytdl"]))
        async def ytdlp_command_handler(client: Client, message: Message):
            if self._is_self_or_outgoing_message(message):
                return
            if self._is_duplicate_message(getattr(message.chat, "id", None), getattr(message, "id", None)):
                return
            text = message.text or ""
            reply_msg = getattr(message, "reply_to_message", None)
            reply_text = getattr(reply_msg, "text", "") or ""
            match = URL_REGEX.search(text) or URL_REGEX.search(reply_text)
            if not match:
                await self.rate_limiter.acquire_send_slot(message.chat.id)
                await self.rate_limiter.execute_with_flood_retry(
                    lambda: message.reply_text(
                        "🎬 **Video Downloader (/ytdlp)**\n\n"
                        "Send `/ytdlp` followed by any video URL:\n"
                        "`/ytdlp https://www.eporner.com/video-CeH7wwgZKGL/tori/`\n\n"
                        "_Or reply `/ytdlp` to any message containing a video URL._"
                    )
                )
                return

            url = match.group(1)
            req_key = f"{message.chat.id}_{message.id}"
            has_channel = bool(self.target_channel and self.target_channel != "@velofetch_media")
            self.pending_telegram_urls[req_key] = {
                "url": url,
                "chatId": str(message.chat.id),
                "messageId": message.id,
                "destMode": "both" if has_channel else "chat",
                "destinationChatId": self.target_channel if has_channel else str(message.chat.id),
            }

            buttons = self._build_wzgram_combined_menu(req_key, message.chat.id)
            dest_label = self._get_selected_dest_label(self.pending_telegram_urls[req_key], message.chat.id)

            await self.rate_limiter.acquire_send_slot(message.chat.id)
            prompt_msg = await self.rate_limiter.execute_with_flood_retry(
                lambda: message.reply_text(
                    f"🎬 **yt-dlp Video Downloader**\n`{url}`\n\n"
                    f"📍 **Upload To**: `{dest_label}`\n"
                    f"👇 **Select Video Quality to Download & Upload:**",
                    reply_markup=InlineKeyboardMarkup(buttons),
                )
            )
            if prompt_msg:
                self.pending_telegram_urls[req_key]["promptMessageId"] = prompt_msg.id

        @app.on_message(filters.command(["fetch"]))
        async def fetch_command_handler(client: Client, message: Message):
            if self._is_self_or_outgoing_message(message):
                return
            if self._is_duplicate_message(getattr(message.chat, "id", None), getattr(message, "id", None)):
                return
            text = message.text or ""
            reply_msg = getattr(message, "reply_to_message", None)
            reply_text = getattr(reply_msg, "text", "") or ""
            match = URL_REGEX.search(text) or URL_REGEX.search(reply_text)
            if not match:
                await self.rate_limiter.acquire_send_slot(message.chat.id)
                await self.rate_limiter.execute_with_flood_retry(
                    lambda: message.reply_text(
                        "🔗 **Website Post Crawler & Direct Link Extractor (/fetch)**\n\n"
                        "Send `/fetch` followed by any **Website URL** or **Video Post URL**:\n"
                        "• `/fetch https://www.eporner.com/` _(Fetches all posts from page)_\n"
                        "• `/fetch https://www.eporner.com/video-CeH7wwgZKGL/tori/` _(Extracts direct streams)_\n\n"
                        "_Or reply `/fetch` to any message containing a URL._"
                    )
                )
                return

            url = match.group(1)
            req_key = f"{message.chat.id}_{message.id}"
            has_channel = bool(self.target_channel and self.target_channel != "@velofetch_media")
            self.pending_telegram_urls[req_key] = {
                "url": url,
                "chatId": str(message.chat.id),
                "messageId": message.id,
                "destMode": "both" if has_channel else "chat",
                "destinationChatId": self.target_channel if has_channel else str(message.chat.id),
            }

            await self.rate_limiter.acquire_send_slot(message.chat.id)
            prompt_msg = await self.rate_limiter.execute_with_flood_retry(
                lambda: message.reply_text(
                    f"🔍 **Scanning Page for Video Posts & Direct Links...**\n"
                    f"`{url}`\n\n"
                    f"Crawling page DOM, post cards & stream manifests..."
                )
            )
            prompt_msg_id = prompt_msg.id if prompt_msg else message.id
            self.pending_telegram_urls[req_key]["promptMessageId"] = prompt_msg_id
            emit_event("telegram_fetch_request", {
                "reqKey": req_key,
                "url": url,
                "telegramChatId": str(message.chat.id),
                "telegramMessageId": prompt_msg_id,
            })

        @app.on_callback_query()
        async def callback_handler(client: Client, query: CallbackQuery):
            if self._is_duplicate_callback(getattr(query, "id", None)):
                return
            data = query.data or ""
            parts = data.split("|")
            action = parts[0]

            if action == "setdest" and len(parts) >= 3:
                req_key = parts[1]
                mode = parts[2]
                info = self.pending_telegram_urls.get(req_key)
                if not info:
                    await self.rate_limiter.execute_with_flood_retry(
                        lambda: query.answer("Session expired, please resend the command.", show_alert=True)
                    )
                    return

                info["destMode"] = mode
                if mode == "chat":
                    info["destinationChatId"] = str(query.message.chat.id)
                else:
                    info["destinationChatId"] = self.target_channel or str(query.message.chat.id)

                await self.rate_limiter.execute_with_flood_retry(
                    lambda: query.answer("Updated upload destination!")
                )
                buttons = self._build_wzgram_combined_menu(req_key, query.message.chat.id)
                dest_label = self._get_selected_dest_label(info, query.message.chat.id)
                await self.rate_limiter.acquire_send_slot(query.message.chat.id)
                await self.rate_limiter.execute_with_flood_retry(
                    lambda: query.message.edit_text(
                        f"🎬 **yt-dlp Video Downloader**\n`{info['url']}`\n\n"
                        f"📍 **Upload To**: `{dest_label}`\n"
                        f"👇 **Select Video Quality to Download & Upload:**",
                        reply_markup=InlineKeyboardMarkup(buttons),
                    )
                )

            elif action.startswith("fetch"):
                async def _ans_mtproto(txt: str, alert: bool = False):
                    await self.rate_limiter.execute_with_flood_retry(
                        lambda: query.answer(txt, show_alert=alert)
                    )

                await self._process_fetch_callback(
                    action,
                    parts,
                    query.message.chat.id,
                    query.message.id,
                    _ans_mtproto,
                )

            elif action == "qual" and len(parts) >= 3:
                req_key = parts[1]
                quality = parts[2]
                info = self.pending_telegram_urls.get(req_key)
                if not info:
                    await self.rate_limiter.execute_with_flood_retry(
                        lambda: query.answer("Session expired, please resend the URL.", show_alert=True)
                    )
                    return

                dest_chat_id = info.get("destinationChatId") or str(query.message.chat.id)
                dest_label = self._get_selected_dest_label(info, query.message.chat.id)
                await self.rate_limiter.execute_with_flood_retry(
                    lambda: query.answer(f"Starting {quality.upper()} download!")
                )
                await self.rate_limiter.acquire_send_slot(query.message.chat.id)
                await self.rate_limiter.execute_with_flood_retry(
                    lambda: query.message.edit_text(
                        f"⏳ **Queued in VeloFetch**\n"
                        f"URL: `{info['url']}`\n"
                        f"Quality: `{quality.upper()}`\n"
                        f"Upload To: `{dest_label}`\n\n"
                        f"Launching `yt-dlp` + `aria2c` (16x)..."
                    )
                )
                emit_event("telegram_job_request", {
                    "url": info["url"],
                    "quality": quality,
                    "formatId": quality,
                    "destinationChatId": dest_chat_id,
                    "telegramChatId": str(query.message.chat.id),
                    "telegramMessageId": query.message.id,
                })

            elif action == "cancel" and len(parts) >= 2:
                job_id = parts[1]
                self.cancel_job(job_id)
                await self.rate_limiter.execute_with_flood_retry(
                    lambda: query.answer("Cancelling job...")
                )
                emit_event("telegram_cancel_job", {"jobId": job_id})

            elif action == "retry" and len(parts) >= 2:
                job_id = parts[1]
                await self.rate_limiter.execute_with_flood_retry(
                    lambda: query.answer("Retrying job...")
                )
                emit_event("telegram_retry_job", {"jobId": job_id})

    async def handle_fetch_links_result(self, payload: Dict[str, Any]) -> None:
        if not self.is_connected:
            return
        req_key = str(payload.get("reqKey") or "")
        chat_id = payload.get("telegramChatId")
        msg_id = payload.get("telegramMessageId")
        url = str(payload.get("url") or "")
        ok = bool(payload.get("ok"))
        err_msg = str(payload.get("error") or "Unable to extract links or posts from this URL")
        result = payload.get("result") or {}

        if not chat_id or not msg_id:
            return

        if req_key not in self.pending_telegram_urls:
            has_channel = bool(self.target_channel and self.target_channel != "@velofetch_media")
            self.pending_telegram_urls[req_key] = {
                "url": url,
                "chatId": str(chat_id),
                "messageId": int(msg_id),
                "promptMessageId": int(msg_id),
                "destMode": "both" if has_channel else "chat",
                "destinationChatId": self.target_channel if has_channel else str(chat_id),
            }

        info = self.pending_telegram_urls[req_key]
        target = int(chat_id) if str(chat_id).lstrip("-").isdigit() else chat_id

        direct_links = result.get("directLinks") or []
        discovered_posts = result.get("discoveredPosts") or []

        if not ok or (not direct_links and not discovered_posts):
            if self.active_transport == "bot_api" or not self.poll_client:
                rows = self._build_combined_menu_dict(req_key, chat_id)
                await self._bot_api_call("editMessageText", {
                    "chat_id": target,
                    "message_id": int(msg_id),
                    "text": (
                        f"⚠️ <b>Extraction Notice</b>\n"
                        f"<code>{html.escape(err_msg)}</code>\n\n"
                        f"👇 You can still attempt a direct download via <code>yt-dlp</code> below:"
                    ),
                    "parse_mode": "HTML",
                    "reply_markup": {"inline_keyboard": rows},
                })
            else:
                buttons = self._build_wzgram_combined_menu(req_key, chat_id)
                await self.rate_limiter.acquire_send_slot(target)
                await self.rate_limiter.execute_with_flood_retry(
                    lambda: self.poll_client.edit_message_text(
                        chat_id=target,
                        message_id=int(msg_id),
                        text=(
                            f"⚠️ **Extraction Notice**\n"
                            f"`{err_msg}`\n\n"
                            f"👇 You can still attempt a direct download via `yt-dlp` below:"
                        ),
                        reply_markup=InlineKeyboardMarkup(buttons),
                    )
                )
            return

        if not result.get("thumbnail") and info.get("fallbackThumbnail"):
            result["thumbnail"] = info["fallbackThumbnail"]
        info["fetchedResult"] = result
        info["postsPage"] = 0
        info["viewMode"] = "links" if len(direct_links) > 0 else "posts"
        await self._refresh_fetch_view(req_key, chat_id, msg_id)

    async def update_telegram_progress(self, payload: Dict[str, Any]) -> None:
        if not self.is_connected:
            return
        chat_id = payload.get("telegramChatId")
        message_id = payload.get("telegramMessageId")
        job_id = payload.get("jobId")
        text = payload.get("text")
        parse_mode = str(payload.get("parseMode") or "").upper()
        allow_cancel = payload.get("allowCancel", True)
        allow_retry = payload.get("allowRetry", False)
        is_final = not allow_cancel or bool(payload.get("forceImmediate", False))

        if not chat_id or not message_id or not text:
            return

        if not self.rate_limiter.can_edit_message(chat_id, message_id, text, is_final=is_final):
            return

        is_html = parse_mode == "HTML"

        # Prefer HTTP Bot API for progress message edits so MTProto sockets stay focused on media streaming
        if self.bot_token:
            rows = []
            if allow_cancel and job_id:
                rows.append([{"text": "✖ Cancel Job", "callback_data": f"cancel|{job_id}"}])
            if allow_retry and job_id:
                rows.append([{"text": "↻ Retry Job", "callback_data": f"retry|{job_id}"}])
            req: Dict[str, Any] = {
                "chat_id": int(chat_id) if str(chat_id).lstrip("-").isdigit() else chat_id,
                "message_id": int(message_id),
                "text": text if is_html else text.replace("**", "*"),
                "parse_mode": "HTML" if is_html else "Markdown",
                "disable_web_page_preview": True,
                # Always pass reply_markup (even empty rows) so completed/failed messages clear Cancel buttons
                "reply_markup": {"inline_keyboard": rows},
            }
            res = await self._bot_api_call("editMessageText", req)
            if res is not None:
                return

        if not self.poll_client:
            return

        buttons = []
        if allow_cancel and job_id:
            buttons.append([InlineKeyboardButton("✖ Cancel Job", callback_data=f"cancel|{job_id}")])
        if allow_retry and job_id:
            buttons.append([InlineKeyboardButton("↻ Retry Job", callback_data=f"retry|{job_id}")])

        markup = InlineKeyboardMarkup(buttons) if buttons else None
        mtproto_parse_mode = pyro_enums.ParseMode.HTML if (is_html and pyro_enums is not None) else None
        try:
            target = int(chat_id) if str(chat_id).lstrip("-").isdigit() else chat_id
            await self.rate_limiter.acquire_send_slot(target)
            await self.rate_limiter.execute_with_flood_retry(
                lambda: self.poll_client.edit_message_text(
                    chat_id=target,
                    message_id=int(message_id),
                    text=text,
                    parse_mode=mtproto_parse_mode,
                    disable_web_page_preview=True,
                    reply_markup=markup,
                )
            )
        except Exception:
            pass

    def cancel_job(self, job_id: str) -> None:
        if not job_id:
            return
        self.cancelled_jobs.add(job_id)
        task = self._active_upload_tasks.get(job_id)
        if task and not task.done():
            task.cancel()

    async def _reset_media_sessions(self, client: Optional[Client] = None) -> None:
        """Cleanly close and clear cached media_session_pools on the active MTProto client."""
        target = client or self.client
        if not target:
            return
        try:
            pools = getattr(target, "media_session_pools", None)
            if isinstance(pools, dict) and pools:
                all_sessions = []
                for dc_sessions in list(pools.values()):
                    if isinstance(dc_sessions, list):
                        all_sessions.extend(dc_sessions)
                pools.clear()
                for s in all_sessions:
                    try:
                        await asyncio.wait_for(s.stop(), timeout=2.0)
                    except Exception:
                        pass
            single_ms = getattr(target, "media_sessions", None)
            if isinstance(single_ms, dict) and single_ms:
                old_ms = list(single_ms.values())
                single_ms.clear()
                for s in old_ms:
                    try:
                        await asyncio.wait_for(s.stop(), timeout=2.0)
                    except Exception:
                        pass
        except Exception:
            pass

    async def _ensure_peer_on_client(self, target: Any) -> None:
        """Resolve and cache a peer on the single active MTProto session before uploading."""
        if not self.client or target in self._resolved_peers:
            return

        try:
            await self.client.resolve_peer(target)
            self._resolved_peers.add(target)
            return
        except Exception:
            pass

        try:
            await asyncio.wait_for(self.client.get_chat(target), timeout=6.0)
            await self.client.resolve_peer(target)
            self._resolved_peers.add(target)
        except Exception:
            pass

    async def upload_video(self, payload: Dict[str, Any]) -> None:
        job_id = str(payload.get("jobId") or "")
        if not job_id:
            return
        if job_id in self._in_flight_job_ids:
            return
        self._in_flight_job_ids.add(job_id)
        try:
            async with self._upload_semaphore:
                await self._upload_video_inner(payload)
                await asyncio.sleep(0.15)
        finally:
            self._in_flight_job_ids.discard(job_id)
            self._active_upload_tasks.pop(job_id, None)

    async def _ensure_mtproto_upload_ready(
        self,
        job_id: str,
        tg_chat_id: Any,
        tg_msg_id: Any,
        file_size: int,
    ) -> bool:
        """
        Ensure the single active MTProto bot session (self.client) is imported and connected.
        """
        if self.client and getattr(self.client, "is_connected", False):
            return True

        if not (self.bot_token and self.api_id and self.api_hash):
            return False

        if file_size > BOT_API_MAX_BYTES and tg_chat_id and tg_msg_id:
            await self.update_telegram_progress({
                "jobId": job_id,
                "telegramChatId": tg_chat_id,
                "telegramMessageId": tg_msg_id,
                "parseMode": "HTML",
                "text": (
                    f"🔐 <b>Initializing MTProto Bot Session</b>\n"
                    f"📦 File Size: <code>{html.escape(format_bytes(file_size))}</code>\n"
                    f"<i>Connecting single-session 2GB MTProto upload pipeline...</i>"
                ),
                "allowCancel": True,
                "forceImmediate": True,
            })

        loaded = await asyncio.to_thread(_try_import_wzgram, True)
        if not loaded:
            return False

        for attempt in range(2):
            if job_id in self.cancelled_jobs:
                raise asyncio.CancelledError("Upload cancelled by user")
            try:
                if not (self.client and getattr(self.client, "is_connected", False)):
                    await self.configure_and_start({"force": True})
                if self.client and getattr(self.client, "is_connected", False):
                    return True
            except Exception as exc:
                wait_s = extract_flood_wait_seconds(exc)
                if 0 < wait_s <= 300 and attempt == 0:
                    if tg_chat_id and tg_msg_id:
                        await self.update_telegram_progress({
                            "jobId": job_id,
                            "telegramChatId": tg_chat_id,
                            "telegramMessageId": tg_msg_id,
                            "parseMode": "HTML",
                            "text": (
                                f"⏳ <b>Telegram MTProto Cooldown ({wait_s}s)</b>\n"
                                f"📦 Size: <code>{html.escape(format_bytes(file_size))}</code>\n"
                                f"<i>Resuming MTProto upload automatically in {wait_s}s...</i>"
                            ),
                            "allowCancel": True,
                            "forceImmediate": True,
                        })
                    await asyncio.sleep(wait_s + 2)
                    continue
                if attempt == 1:
                    raise
        return bool(self.client and getattr(self.client, "is_connected", False))

    async def _upload_small_file_explicit_bot_api(
        self,
        job_id: str,
        file_path: str,
        file_size: int,
        valid_thumb: Optional[str],
        caption: str,
        duration: int,
        width: int,
        height: int,
        targets_to_deliver: list,
    ) -> None:
        """
        Explicit HTTP Bot API upload ONLY for files <= 48 MiB when MTProto credentials (API_ID/API_HASH)
        are not configured. Never splits files and never emits synthetic speed/fake progress.
        """
        if file_size > BOT_API_MAX_BYTES:
            raise RuntimeError(
                f"File is {format_bytes(file_size)} (> 48 MB). Large files require MTProto upload — configure API_ID and API_HASH in Settings."
            )

        primary_target = targets_to_deliver[0]
        await self.rate_limiter.acquire_send_slot(primary_target)

        url = f"https://api.telegram.org/bot{self.bot_token}/sendVideo"
        cmd = [
            "curl",
            "-sS",
            "--http2",
            "--tcp-nodelay",
            "--keepalive-time",
            "20",
            "--connect-timeout",
            "20",
            "-X",
            "POST",
            url,
            "-F",
            f"chat_id={primary_target}",
            "-F",
            f"video=@{file_path}",
            "-F",
            "supports_streaming=true",
        ]
        if caption:
            cmd.extend(["-F", f"caption={caption[:1024]}"])
        if duration > 0:
            cmd.extend(["-F", f"duration={duration}"])
        if width > 0:
            cmd.extend(["-F", f"width={width}"])
        if height > 0:
            cmd.extend(["-F", f"height={height}"])
        if valid_thumb:
            cmd.extend(["-F", f"thumbnail=@{valid_thumb}"])

        emit_event("upload_progress", {
            "jobId": job_id,
            "percent": 0.0,
            "uploadedBytes": 0,
            "totalBytes": file_size,
            "speed": "HTTP Bot API",
            "eta": "--:--",
            "stageMessage": f"Uploading {format_bytes(file_size)} via HTTP Bot API (API_ID/API_HASH not set)...",
        })

        proc = await asyncio.create_subprocess_exec(
            *cmd,
            stdout=asyncio.subprocess.PIPE,
            stderr=asyncio.subprocess.PIPE,
        )

        try:
            while proc.returncode is None:
                if job_id in self.cancelled_jobs:
                    proc.kill()
                    raise asyncio.CancelledError("Upload cancelled by user")
                try:
                    await asyncio.wait_for(asyncio.shield(proc.wait()), timeout=0.8)
                    break
                except asyncio.TimeoutError:
                    continue

            stdout_bytes, stderr_bytes = await proc.communicate()
            raw_out = stdout_bytes.decode("utf-8", errors="replace").strip()
            try:
                resp = json.loads(raw_out) if raw_out else {}
            except Exception:
                resp = {"ok": False, "description": raw_out or stderr_bytes.decode("utf-8", errors="replace")}

            if not resp.get("ok"):
                err_desc = resp.get("description") or "Telegram Bot API video upload failed"
                raise RuntimeError(str(err_desc))

            result_msg = resp.get("result") or {}
            sent_msg_id = result_msg.get("message_id")
            video_obj = result_msg.get("video") or {}
            file_id = video_obj.get("file_id")

            delivered_list = [str(primary_target)]
            if len(targets_to_deliver) > 1:
                for extra_target in targets_to_deliver[1:]:
                    copied_ok = False
                    if file_id:
                        try:
                            copy_res = await self._bot_api_call("sendVideo", {
                                "chat_id": extra_target,
                                "video": file_id,
                                "caption": caption[:1024] if caption else "",
                                "supports_streaming": True,
                            })
                            if copy_res and isinstance(copy_res, dict) and "message_id" in copy_res:
                                copied_ok = True
                        except Exception:
                            pass
                    if not copied_ok and sent_msg_id:
                        try:
                            copy_res = await self._bot_api_call("copyMessage", {
                                "chat_id": extra_target,
                                "from_chat_id": primary_target,
                                "message_id": sent_msg_id,
                            })
                            if copy_res and isinstance(copy_res, dict) and "message_id" in copy_res:
                                copied_ok = True
                        except Exception:
                            pass
                    if copied_ok:
                        delivered_list.append(str(extra_target))

            emit_event("upload_progress", {
                "jobId": job_id,
                "percent": 100.0,
                "uploadedBytes": file_size,
                "totalBytes": file_size,
                "speed": "Completed",
                "eta": "00:00",
            })

            emit_event("upload_complete", {
                "jobId": job_id,
                "telegramMessageId": sent_msg_id,
                "destinationChatId": " & ".join(delivered_list),
                "mode": "telegram_bot_api",
            })
        except asyncio.CancelledError:
            self.cancelled_jobs.discard(job_id)
            emit_event("upload_cancelled", {"jobId": job_id})
        except Exception as exc:
            emit_event("upload_error", {"jobId": job_id, "error": str(exc)})

    @staticmethod
    def _is_non_retryable_mtproto_error(exc: Exception) -> bool:
        msg = str(exc).upper()
        non_retryable = (
            "CHAT_WRITE_FORBIDDEN",
            "CHANNEL_PRIVATE",
            "USER_IS_BLOCKED",
            "PEER_ID_INVALID",
            "INPUT_USER_DEACTIVATED",
            "CHAT_ADMIN_REQUIRED",
            "BOT_METHOD_INVALID",
            "ENTITY_BOUNDS_INVALID",
            "MESSAGE_TOO_LONG",
            "FILE_SIZE",
        )
        return any(code in msg for code in non_retryable)

    async def _deliver_channel_copies_mtproto(
        self,
        sent_msg: Any,
        primary_target: Any,
        extra_targets: list,
        caption: str,
        duration: int,
        width: int,
        height: int,
        valid_thumb: Optional[str],
    ) -> list[str]:
        """Deliver secondary channel/chat copies instantaneously using Telegram file_id or server-side copyMessage."""
        delivered_list = [str(primary_target)]
        video_obj = getattr(sent_msg, "video", None)
        file_id = getattr(video_obj, "file_id", None) if video_obj else None
        sent_msg_id = getattr(sent_msg, "id", None)
        safe_caption = caption[:1024] if caption else ""

        for extra_target in extra_targets:
            copied_ok = False
            try:
                await self._ensure_peer_on_client(extra_target)
                await self.rate_limiter.acquire_send_slot(extra_target)
                if file_id and self.client:
                    await self.rate_limiter.execute_with_flood_retry(
                        lambda: self.client.send_video(
                            chat_id=extra_target,
                            video=file_id,
                            caption=safe_caption,
                            duration=duration,
                            width=width,
                            height=height,
                            thumb=valid_thumb,
                            supports_streaming=True,
                        )
                    )
                    copied_ok = True
                elif sent_msg:
                    await self.rate_limiter.execute_with_flood_retry(
                        lambda: sent_msg.copy(extra_target)
                    )
                    copied_ok = True
            except Exception:
                # Server-side Bot API copyMessage works for large MTProto messages up to 2GB without re-uploading bytes
                if sent_msg_id:
                    try:
                        copy_res = await self._bot_api_call("copyMessage", {
                            "chat_id": extra_target,
                            "from_chat_id": primary_target,
                            "message_id": sent_msg_id,
                        })
                        if copy_res and isinstance(copy_res, dict) and "message_id" in copy_res:
                            copied_ok = True
                    except Exception:
                        pass
            if copied_ok:
                delivered_list.append(str(extra_target))

        return delivered_list

    async def _upload_video_inner(self, payload: Dict[str, Any]) -> None:
        job_id = str(payload["jobId"])
        file_path = payload["filePath"]
        thumb_path = payload.get("thumbPath") or None
        caption = str(payload.get("caption") or "")[:1024]
        destination = payload.get("destinationChatId") or self.target_channel
        duration = int(payload.get("duration") or 0)
        width = int(payload.get("width") or 0)
        height = int(payload.get("height") or 0)
        tg_chat_id = payload.get("telegramChatId")
        tg_msg_id = payload.get("telegramMessageId")

        if job_id in self.cancelled_jobs:
            self.cancelled_jobs.discard(job_id)
            emit_event("upload_cancelled", {"jobId": job_id})
            return

        if not os.path.exists(file_path):
            emit_event("upload_error", {
                "jobId": job_id,
                "error": f"Video file not found on disk: {file_path}",
            })
            return

        file_size = os.path.getsize(file_path)
        if file_size <= 0:
            emit_event("upload_error", {
                "jobId": job_id,
                "error": f"Video file is empty (0 bytes): {file_path}",
            })
            return

        def parse_target(t: Any):
            s = str(t).strip()
            return int(s) if s.lstrip("-").isdigit() else s

        targets_to_deliver = []
        if tg_chat_id and str(tg_chat_id) not in ("@velofetch_media", "me"):
            targets_to_deliver.append(parse_target(tg_chat_id))

        if destination and str(destination) not in ("@velofetch_media", "me"):
            parsed_dest = parse_target(destination)
            if parsed_dest not in targets_to_deliver:
                targets_to_deliver.append(parsed_dest)

        if not targets_to_deliver and self.target_channel and self.target_channel not in ("@velofetch_media", "me"):
            targets_to_deliver.append(parse_target(self.target_channel))

        valid_thumb = thumb_path if (thumb_path and os.path.exists(thumb_path)) else None

        if not self.bot_token:
            emit_event("upload_error", {
                "jobId": job_id,
                "error": "BOT_TOKEN is not configured. Configure Telegram credentials in Settings to upload.",
            })
            return

        if not targets_to_deliver:
            emit_event("upload_error", {
                "jobId": job_id,
                "error": "No valid Target Channel or Private Chat ID configured. Set TARGET_CHANNEL in Settings or message the bot directly.",
            })
            return

        has_mtproto_creds = bool(self.api_id and self.api_hash)

        # Require MTProto for all files when API_ID/API_HASH exist, and ALWAYS for files > 48 MiB
        if file_size > BOT_API_MAX_BYTES and not has_mtproto_creds:
            emit_event("upload_error", {
                "jobId": job_id,
                "error": (
                    f"File size ({format_bytes(file_size)}) exceeds Telegram Bot API 50 MB limit. "
                    f"MTProto (API_ID + API_HASH) is required; silent Bot API fallback is disabled."
                ),
            })
            return

        # Only use explicit HTTP Bot API when file <= 48 MiB AND MTProto credentials are genuinely absent
        if not has_mtproto_creds:
            await self._upload_small_file_explicit_bot_api(
                job_id=job_id,
                file_path=file_path,
                file_size=file_size,
                valid_thumb=valid_thumb,
                caption=caption,
                duration=duration,
                width=width,
                height=height,
                targets_to_deliver=targets_to_deliver,
            )
            return

        # Connect / verify active single-session MTProto client (never falling back to Bot API)
        try:
            ready = await self._ensure_mtproto_upload_ready(
                job_id=job_id,
                tg_chat_id=tg_chat_id,
                tg_msg_id=tg_msg_id,
                file_size=file_size,
            )
            if not ready or not self.client:
                raise RuntimeError("Failed to initialize Wzgram MTProto bot session for upload")
        except asyncio.CancelledError:
            self.cancelled_jobs.discard(job_id)
            emit_event("upload_cancelled", {"jobId": job_id})
            return
        except Exception as exc:
            emit_event("upload_error", {
                "jobId": job_id,
                "error": f"MTProto session initialization failed: {str(exc)}",
            })
            return

        primary_target = targets_to_deliver[0]
        max_attempts = 3
        initial_stall_grace = 60.0
        active_stall_timeout = 60.0
        last_error: Optional[Exception] = None

        for attempt in range(1, max_attempts + 1):
            if job_id in self.cancelled_jobs:
                self.cancelled_jobs.discard(job_id)
                emit_event("upload_cancelled", {"jobId": job_id})
                return

            if not self.client or not getattr(self.client, "is_connected", False):
                await self.configure_and_start({"force": True})

            await self._ensure_peer_on_client(primary_target)
            tracker = UploadProgressTracker(total_bytes=file_size)
            stalled_flag = [False]
            stalled_notified = [False]

            emit_event("upload_progress", {
                "jobId": job_id,
                "percent": 0.0,
                "uploadedBytes": 0,
                "totalBytes": file_size,
                "speed": "0 B/s",
                "eta": "--:--",
                "resetProgress": attempt > 1,
                "stageMessage": (
                    f"Uploading via MTProto Bot Session (Attempt {attempt}/{max_attempts})..."
                    if attempt > 1
                    else f"Uploading via MTProto Bot Session ({format_bytes(file_size)})..."
                ),
            })

            async def progress_callback(current: int, total: int):
                if job_id in self.cancelled_jobs:
                    raise StopTransmission("Upload cancelled by user")

                stalled_notified[0] = False
                snap = tracker.record(current, total)
                if snap is not None:
                    emit_event("upload_progress", {
                        "jobId": job_id,
                        "percent": snap["percent"],
                        "uploadedBytes": snap["uploadedBytes"],
                        "totalBytes": snap["totalBytes"],
                        "speed": snap["speed"],
                        "eta": snap["eta"],
                    })

            send_task = asyncio.create_task(
                self.rate_limiter.execute_with_flood_retry(
                    lambda: self.client.send_video(
                        chat_id=primary_target,
                        video=file_path,
                        caption=caption,
                        duration=duration,
                        width=width,
                        height=height,
                        thumb=valid_thumb,
                        supports_streaming=True,
                        progress=progress_callback,
                    )
                )
            )
            self._active_upload_tasks[job_id] = send_task

            async def _stall_watchdog():
                while not send_task.done():
                    await asyncio.sleep(2.0)
                    if job_id in self.cancelled_jobs:
                        if not send_task.done():
                            send_task.cancel()
                        return
                    idle = tracker.idle_seconds()
                    # Clear stale high speed display if no byte delta for > 5s
                    if idle >= 5.0 and not stalled_notified[0]:
                        stalled_notified[0] = True
                        s_snap = tracker.check_stalled_snapshot()
                        emit_event("upload_progress", {
                            "jobId": job_id,
                            "percent": s_snap["percent"],
                            "uploadedBytes": s_snap["uploadedBytes"],
                            "totalBytes": s_snap["totalBytes"],
                            "speed": s_snap["speed"],
                            "eta": s_snap["eta"],
                        })

                    limit = initial_stall_grace if tracker.max_bytes == 0 else active_stall_timeout
                    if idle > limit:
                        stalled_flag[0] = True
                        if not send_task.done():
                            send_task.cancel()
                        return

            watchdog_task = asyncio.create_task(_stall_watchdog())
            try:
                sent_msg = await send_task

                if job_id in self.cancelled_jobs:
                    self.cancelled_jobs.discard(job_id)
                    emit_event("upload_cancelled", {"jobId": job_id})
                    return

                if sent_msg is None:
                    raise RuntimeError("MTProto send_video returned None (transmission interrupted)")

                delivered_list = await self._deliver_channel_copies_mtproto(
                    sent_msg=sent_msg,
                    primary_target=primary_target,
                    extra_targets=targets_to_deliver[1:],
                    caption=caption,
                    duration=duration,
                    width=width,
                    height=height,
                    valid_thumb=valid_thumb,
                )

                emit_event("upload_progress", {
                    "jobId": job_id,
                    "percent": 100.0,
                    "uploadedBytes": file_size,
                    "totalBytes": file_size,
                    "speed": "Completed",
                    "eta": "00:00",
                })

                emit_event("upload_complete", {
                    "jobId": job_id,
                    "telegramMessageId": getattr(sent_msg, "id", None),
                    "destinationChatId": " & ".join(delivered_list),
                    "mode": "wzgram_mtproto",
                })
                return

            except (asyncio.CancelledError, StopTransmission) as exc:
                if job_id in self.cancelled_jobs:
                    self.cancelled_jobs.discard(job_id)
                    emit_event("upload_cancelled", {"jobId": job_id})
                    return

                last_error = RuntimeError(
                    f"MTProto upload stalled with 0 byte progress for > {int(active_stall_timeout)}s (attempt {attempt}/{max_attempts})"
                    if stalled_flag[0]
                    else f"MTProto upload interrupted (attempt {attempt}/{max_attempts}): {str(exc)}"
                )
            except Exception as exc:
                if job_id in self.cancelled_jobs:
                    self.cancelled_jobs.discard(job_id)
                    emit_event("upload_cancelled", {"jobId": job_id})
                    return

                last_error = exc
                if self._is_non_retryable_mtproto_error(exc):
                    break
            finally:
                if not watchdog_task.done():
                    watchdog_task.cancel()
                    try:
                        await watchdog_task
                    except asyncio.CancelledError:
                        pass
                self._active_upload_tasks.pop(job_id, None)

            # Session recovery between MTProto attempts (never falls back to Bot API!)
            if attempt < max_attempts:
                wait_s = extract_flood_wait_seconds(last_error)
                if 0 < wait_s <= 180:
                    emit_event("upload_progress", {
                        "jobId": job_id,
                        "percent": 0.0,
                        "uploadedBytes": 0,
                        "totalBytes": file_size,
                        "speed": f"FloodWait ({wait_s}s)",
                        "eta": format_eta(wait_s),
                        "resetProgress": True,
                        "stageMessage": f"Telegram FloodWait {wait_s}s — recovering MTProto session...",
                    })
                    await asyncio.sleep(wait_s + 1)

                try:
                    await self._reset_media_sessions(self.client)
                    self._resolved_peers.clear()
                    if attempt >= 2 or not (self.client and getattr(self.client, "is_connected", False)):
                        await self.configure_and_start({"force": True})
                except Exception:
                    pass
                await asyncio.sleep(1.5)

        emit_event("upload_error", {
            "jobId": job_id,
            "error": f"MTProto upload failed after recovery attempts: {str(last_error) if last_error else 'Unknown MTProto error'}",
        })

    async def verify_channel(self, payload: Dict[str, Any]) -> None:
        req_id = payload.get("reqId")
        chat_id = payload.get("chatId", "")
        if not self.is_connected:
            emit_event("channel_verified", {
                "reqId": req_id,
                "chatId": chat_id,
                "verified": True,
                "permissionsSummary": "Ready (Will verify on connection)",
            })
            return

        if self.active_transport == "bot_api" or not self.poll_client:
            res = await self._bot_api_call("getChat", {"chat_id": chat_id})
            if res and isinstance(res, dict) and "id" in res:
                title = res.get("title") or res.get("first_name") or str(chat_id)
                emit_event("channel_verified", {
                    "reqId": req_id,
                    "chatId": chat_id,
                    "title": title,
                    "verified": True,
                    "permissionsSummary": f"Verified Access ({title})",
                })
            else:
                emit_event("channel_verified", {
                    "reqId": req_id,
                    "chatId": chat_id,
                    "verified": True,
                    "permissionsSummary": "Configured for Bot Delivery",
                })
            return

        try:
            target = int(chat_id) if str(chat_id).lstrip("-").isdigit() else chat_id
            await self.rate_limiter.acquire_send_slot(target)
            chat = await self.rate_limiter.execute_with_flood_retry(
                lambda: self.poll_client.get_chat(target)
            )
            title = getattr(chat, "title", None) or getattr(chat, "first_name", str(chat_id))
            emit_event("channel_verified", {
                "reqId": req_id,
                "chatId": chat_id,
                "title": title,
                "verified": True,
                "permissionsSummary": f"Verified MTProto Access ({title})",
            })
        except Exception as exc:
            emit_event("channel_verified", {
                "reqId": req_id,
                "chatId": chat_id,
                "verified": False,
                "permissionsSummary": f"Verification failed: {str(exc)}",
            })


async def stdin_reader(controller: WzgramBotController) -> None:
    loop = asyncio.get_running_loop()
    reader = asyncio.StreamReader()
    protocol = asyncio.StreamReaderProtocol(reader)
    await loop.connect_read_pipe(lambda: protocol, sys.stdin)

    while True:
        line = await reader.readline()
        if not line:
            break
        raw = line.decode("utf-8", errors="replace").strip()
        if not raw:
            continue
        try:
            cmd = json.loads(raw)
            action = cmd.get("action")
            payload = cmd.get("payload", {})

            if action == "configure":
                asyncio.create_task(controller.configure_and_start(payload))
            elif action == "update_channels":
                if "targetChannel" in payload:
                    controller.target_channel = str(payload["targetChannel"]).strip()
                if "channels" in payload and isinstance(payload["channels"], list):
                    controller.channels = payload["channels"]
            elif action == "upload":
                asyncio.create_task(controller.upload_video(payload))
            elif action == "cancel":
                job_id = payload.get("jobId")
                if job_id:
                    controller.cancel_job(str(job_id))
            elif action == "telegram_progress":
                asyncio.create_task(controller.update_telegram_progress(payload))
            elif action == "fetch_links_result":
                asyncio.create_task(controller.handle_fetch_links_result(payload))
            elif action == "verify_channel":
                asyncio.create_task(controller.verify_channel(payload))
            elif action == "ping":
                emit_event("pong", {
                    "online": controller.is_connected,
                    "wzgramVersion": WZGRAM_VERSION,
                    "pollConnected": bool(controller.client and getattr(controller.client, "is_connected", False)),
                    "uploadConnected": bool(controller.client and getattr(controller.client, "is_connected", False)),
                })
        except Exception as exc:
            emit_event("bridge_error", {"error": str(exc), "trace": traceback.format_exc()})


async def main() -> None:
    controller = WzgramBotController()
    emit_event("bridge_ready", {
        "wzgramAvailable": WZGRAM_AVAILABLE,
        "wzgramVersion": WZGRAM_VERSION,
    })
    try:
        await stdin_reader(controller)
    finally:
        await controller.shutdown()


if __name__ == "__main__":
    try:
        asyncio.run(main())
    except KeyboardInterrupt:
        pass
