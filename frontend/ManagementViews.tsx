import React, { useState } from 'react';
import {
  Radio,
  Plus,
  CheckCircle2,
  ShieldCheck,
  Trash2,
  Star,
  Cpu,
  HardDrive,
  Activity,
  Wifi,
  Terminal,
  Save,
  RefreshCw,
} from 'lucide-react';
import {
  ChannelRecord,
  SystemMetrics,
  LogEntry,
  AppConfig,
  BotConnectionStatus,
} from './types.ts';

// ==================== CHANNELS & CHATS VIEW ====================

interface ChannelsViewProps {
  channels: ChannelRecord[];
  onAddChannel: (data: {
    name: string;
    chatId: string;
    type: 'channel' | 'group' | 'private';
    isDefault: boolean;
  }) => Promise<void>;
  onSetDefault: (id: string) => Promise<void>;
  onVerifyChannel: (id: string) => Promise<void>;
  onDeleteChannel: (id: string) => Promise<void>;
}

export const ChannelsView: React.FC<ChannelsViewProps> = ({
  channels,
  onAddChannel,
  onSetDefault,
  onVerifyChannel,
  onDeleteChannel,
}) => {
  const [name, setName] = useState('');
  const [chatId, setChatId] = useState('');
  const [type, setType] = useState<'channel' | 'group' | 'private'>('channel');
  const [isDefault, setIsDefault] = useState(false);
  const [adding, setAdding] = useState(false);
  const [verifyingId, setVerifyingId] = useState<string | null>(null);

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!name.trim() || !chatId.trim()) return;
    setAdding(true);
    try {
      await onAddChannel({
        name: name.trim(),
        chatId: chatId.trim(),
        type,
        isDefault,
      });
      setName('');
      setChatId('');
      setIsDefault(false);
    } finally {
      setAdding(false);
    }
  };

  return (
    <div className="grid grid-cols-1 lg:grid-cols-3 gap-6">
      {/* Add Channel Form */}
      <div className="bg-[#131722] border border-slate-800/90 rounded-xl p-6 space-y-4 h-fit">
        <div className="flex items-center justify-between">
          <h2 className="text-base font-display font-semibold text-white">
            Add Destination
          </h2>
          <Radio className="w-4 h-4 text-[#3985FF]" />
        </div>
        <p className="text-xs text-slate-400">
          Configure Telegram channels, supergroups, or private chat IDs for Wzgram MTProto uploads and inline bot buttons.
        </p>

        <form onSubmit={handleSubmit} className="space-y-4">
          <div>
            <label className="block text-xs text-slate-300 mb-1">
              Destination Label
            </label>
            <input
              type="text"
              required
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder="e.g. Cinema 4K Archive"
              className="w-full bg-[#090B10] border border-slate-800 focus:border-[#3985FF] rounded-lg px-3.5 py-2 text-xs text-white outline-none"
            />
          </div>

          <div>
            <label className="block text-xs text-slate-300 mb-1">
              Channel @username or Numeric Chat ID
            </label>
            <input
              type="text"
              required
              value={chatId}
              onChange={(e) => setChatId(e.target.value)}
              placeholder="@my_channel or -100192837465"
              className="w-full bg-[#090B10] border border-slate-800 focus:border-[#3985FF] rounded-lg px-3.5 py-2 text-xs font-mono text-white outline-none"
            />
          </div>

          <div>
            <label className="block text-xs text-slate-300 mb-1">
              Destination Type
            </label>
            <select
              value={type}
              onChange={(e) => setType(e.target.value as any)}
              className="w-full bg-[#090B10] border border-slate-800 focus:border-[#3985FF] rounded-lg px-3 py-2 text-xs text-white outline-none"
            >
              <option value="channel">Broadcast Channel</option>
              <option value="group">Supergroup / Topic Chat</option>
              <option value="private">Private Direct Chat</option>
            </select>
          </div>

          <label className="flex items-center gap-2 text-xs text-slate-300 cursor-pointer">
            <input
              type="checkbox"
              checked={isDefault}
              onChange={(e) => setIsDefault(e.target.checked)}
              className="rounded border-slate-700 bg-[#090B10] text-[#3985FF]"
            />
            <span>Set as default upload destination</span>
          </label>

          <button
            type="submit"
            disabled={adding}
            className="w-full py-2.5 px-4 rounded-lg bg-[#3985FF] hover:bg-[#2563EB] disabled:opacity-50 text-white text-xs font-semibold flex items-center justify-center gap-1.5 cursor-pointer"
          >
            <Plus className="w-4 h-4" />
            {adding ? 'Validating & Adding...' : 'Add & Validate Destination'}
          </button>
        </form>
      </div>

      {/* Configured Channels List */}
      <div className="lg:col-span-2 bg-[#131722] border border-slate-800/90 rounded-xl p-6 space-y-4">
        <div>
          <h2 className="text-base font-display font-semibold text-white">
            Configured Channels & Private Chats ({channels.length})
          </h2>
          <p className="text-xs text-slate-400 mt-0.5">
            Synced with Telegram inline destination buttons and web upload selectors
          </p>
        </div>

        <div className="space-y-3">
          {channels.map((ch) => (
            <div
              key={ch.id}
              className="p-4 rounded-lg bg-[#090B10] border border-slate-800/90 flex flex-col sm:flex-row sm:items-center justify-between gap-4"
            >
              <div className="space-y-1 min-w-0">
                <div className="flex items-center gap-2">
                  <span className="text-sm font-semibold text-white truncate">
                    {ch.name}
                  </span>
                  {ch.isDefault && (
                    <span className="text-[11px] font-medium text-[#3985FF] flex items-center gap-1">
                      <Star className="w-3 h-3 fill-current" />
                      Default
                    </span>
                  )}
                </div>
                <div className="text-xs text-slate-400 font-mono">
                  {ch.chatId} <span aria-hidden="true">·</span> {ch.type.toUpperCase()}
                </div>
                <div className="flex items-center gap-1.5 text-xs text-emerald-400">
                  <ShieldCheck className="w-3.5 h-3.5 shrink-0" />
                  <span>{ch.permissionsSummary}</span>
                </div>
              </div>

              <div className="flex items-center gap-2 shrink-0">
                {!ch.isDefault && (
                  <button
                    onClick={() => onSetDefault(ch.id)}
                    className="px-3 py-1.5 rounded-lg bg-slate-800 hover:bg-slate-700 text-slate-200 text-xs font-medium cursor-pointer"
                  >
                    Make Default
                  </button>
                )}

                <button
                  onClick={async () => {
                    setVerifyingId(ch.id);
                    await onVerifyChannel(ch.id);
                    setVerifyingId(null);
                  }}
                  className="px-3 py-1.5 rounded-lg bg-[#3985FF]/15 hover:bg-[#3985FF]/25 text-[#3985FF] text-xs font-medium flex items-center gap-1 cursor-pointer"
                >
                  <RefreshCw
                    className={`w-3.5 h-3.5 ${verifyingId === ch.id ? 'animate-spin' : ''}`}
                  />
                  Verify Permissions
                </button>

                {channels.length > 1 && (
                  <button
                    onClick={() => onDeleteChannel(ch.id)}
                    className="p-1.5 rounded-lg bg-slate-800 hover:bg-rose-500/20 text-slate-400 hover:text-rose-400 transition-colors cursor-pointer"
                  >
                    <Trash2 className="w-4 h-4" />
                  </button>
                )}
              </div>
            </div>
          ))}
        </div>
      </div>
    </div>
  );
};

// ==================== SYSTEM MONITOR VIEW ====================

interface SystemMonitorViewProps {
  metrics: SystemMetrics | null;
  onManualCleanup: (includeFailed: boolean) => Promise<{
    deletedFiles: number;
    freedFormatted: string;
  }>;
}

export const SystemMonitorView: React.FC<SystemMonitorViewProps> = ({
  metrics,
  onManualCleanup,
}) => {
  const [cleaning, setCleaning] = useState(false);
  const [cleanupResult, setCleanupResult] = useState<string | null>(null);

  const handleCleanup = async (includeFailed: boolean) => {
    setCleaning(true);
    try {
      const res = await onManualCleanup(includeFailed);
      setCleanupResult(
        `Cleaned ${res.deletedFiles} files (${res.freedFormatted} reclaimed). Active job files remained locked.`
      );
    } finally {
      setCleaning(false);
    }
  };

  if (!metrics) {
    return (
      <div className="bg-[#131722] border border-slate-800/90 rounded-xl p-8 text-center text-sm text-slate-400">
        Collecting system telemetry...
      </div>
    );
  }

  return (
    <div className="space-y-6">
      {/* Hardware Telemetry Grid */}
      <div className="grid grid-cols-1 md:grid-cols-2 xl:grid-cols-4 gap-4">
        {/* CPU */}
        <div className="bg-[#131722] border border-slate-800/90 rounded-xl p-5 space-y-3">
          <div className="flex items-center justify-between text-xs text-slate-400">
            <span>CPU Load ({metrics.cpuCores} Cores)</span>
            <Cpu className="w-4 h-4 text-[#3985FF]" />
          </div>
          <div className="text-2xl font-display font-bold text-white tabular-nums">
            {metrics.cpuUsagePercent}%
          </div>
          <div className="w-full h-2 bg-slate-800 rounded-full overflow-hidden">
            <div
              className="h-full bg-[#3985FF] transition-all duration-300"
              style={{ width: `${metrics.cpuUsagePercent}%` }}
            />
          </div>
          <div className="text-[11px] text-slate-500 font-mono truncate">
            {metrics.cpuModel}
          </div>
        </div>

        {/* RAM */}
        <div className="bg-[#131722] border border-slate-800/90 rounded-xl p-5 space-y-3">
          <div className="flex items-center justify-between text-xs text-slate-400">
            <span>Memory Usage</span>
            <Activity className="w-4 h-4 text-emerald-400" />
          </div>
          <div className="text-2xl font-display font-bold text-white tabular-nums">
            {metrics.ramUsagePercent}%
          </div>
          <div className="w-full h-2 bg-slate-800 rounded-full overflow-hidden">
            <div
              className="h-full bg-emerald-500 transition-all duration-300"
              style={{ width: `${metrics.ramUsagePercent}%` }}
            />
          </div>
          <div className="text-[11px] text-slate-400 font-mono tabular-nums">
            {metrics.ramUsedFormatted} / {metrics.ramTotalFormatted}
          </div>
        </div>

        {/* Disk Usage */}
        <div className="bg-[#131722] border border-slate-800/90 rounded-xl p-5 space-y-3">
          <div className="flex items-center justify-between text-xs text-slate-400">
            <span>Disk & Media Storage</span>
            <HardDrive className="w-4 h-4 text-[#3985FF]" />
          </div>
          <div className="text-2xl font-display font-bold text-white tabular-nums">
            {metrics.storage.diskPercentUsed}%
          </div>
          <div className="w-full h-2 bg-slate-800 rounded-full overflow-hidden">
            <div
              className="h-full bg-[#3985FF] transition-all duration-300"
              style={{ width: `${metrics.storage.diskPercentUsed}%` }}
            />
          </div>
          <div className="text-[11px] text-slate-400 font-mono tabular-nums">
            Pipeline Vault: {metrics.storage.totalUsedFormatted} ({metrics.storage.fileCount} files)
          </div>
        </div>

        {/* Network Speed */}
        <div className="bg-[#131722] border border-slate-800/90 rounded-xl p-5 space-y-3">
          <div className="flex items-center justify-between text-xs text-slate-400">
            <span>Network Throughput</span>
            <Wifi className="w-4 h-4 text-emerald-400" />
          </div>
          <div className="space-y-1 font-mono tabular-nums">
            <div className="text-sm text-white">
              RX (Down): <span className="text-[#3985FF] font-semibold">{metrics.networkRxSpeed}</span>
            </div>
            <div className="text-sm text-white">
              TX (Up): <span className="text-emerald-400 font-semibold">{metrics.networkTxSpeed}</span>
            </div>
          </div>
          <div className="text-[11px] text-slate-400 font-mono tabular-nums">
            Active Workers: {metrics.activeWorkers} · Queued: {metrics.queuedJobs}
          </div>
        </div>
      </div>

      {/* Storage Management & Manual Cleanup + Binary Versions */}
      <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
        <div className="bg-[#131722] border border-slate-800/90 rounded-xl p-6 space-y-4">
          <h3 className="text-base font-display font-semibold text-white">
            Storage Lifecycle & Manual Cleanup
          </h3>
          <p className="text-xs text-slate-400">
            Downloaded videos are automatically deleted after confirmed Telegram upload. Failed uploads are retained on disk for instant retry. Active job files are locked against deletion.
          </p>

          <div className="grid grid-cols-3 gap-3 text-xs font-mono tabular-nums">
            <div className="p-3 rounded-lg bg-[#090B10] border border-slate-800">
              <div className="text-slate-500 text-[11px]">ACTIVE LOCKED</div>
              <div className="text-base font-semibold text-white mt-0.5">
                {metrics.storage.activeLockedFiles} jobs
              </div>
            </div>
            <div className="p-3 rounded-lg bg-[#090B10] border border-slate-800">
              <div className="text-slate-500 text-[11px]">RETAINED FAILED</div>
              <div className="text-base font-semibold text-amber-400 mt-0.5">
                {metrics.storage.retainedFailedFiles} files
              </div>
            </div>
            <div className="p-3 rounded-lg bg-[#090B10] border border-slate-800">
              <div className="text-slate-500 text-[11px]">TOTAL VAULT</div>
              <div className="text-base font-semibold text-[#3985FF] mt-0.5">
                {metrics.storage.totalUsedFormatted}
              </div>
            </div>
          </div>

          <div className="flex flex-wrap items-center gap-3 pt-2">
            <button
              onClick={() => handleCleanup(false)}
              disabled={cleaning}
              className="px-4 py-2 rounded-lg bg-[#3985FF] hover:bg-[#2563EB] disabled:opacity-50 text-white text-xs font-medium cursor-pointer"
            >
              {cleaning ? 'Cleaning...' : 'Clean Completed & Temp Files'}
            </button>
            <button
              onClick={() => handleCleanup(true)}
              disabled={cleaning}
              className="px-4 py-2 rounded-lg bg-slate-800 hover:bg-rose-500/20 text-slate-300 hover:text-rose-300 text-xs font-medium cursor-pointer"
            >
              Purge All Including Failed Retries
            </button>
          </div>

          {cleanupResult && (
            <div className="text-xs text-emerald-400 font-mono">{cleanupResult}</div>
          )}
        </div>

        <div className="bg-[#131722] border border-slate-800/90 rounded-xl p-6 space-y-4">
          <h3 className="text-base font-display font-semibold text-white">
            Installed Multimedia Runtime Stack
          </h3>
          <div className="space-y-2.5 text-xs font-mono">
            <div className="flex items-center justify-between py-2 border-b border-slate-800/70">
              <span className="text-slate-400">Telegram MTProto Framework</span>
              <span className="text-emerald-400">{metrics.binaries.wzgram}</span>
            </div>
            <div className="flex items-center justify-between py-2 border-b border-slate-800/70">
              <span className="text-slate-400">yt-dlp Stream Extractor</span>
              <span className="text-slate-200">{metrics.binaries.ytDlp}</span>
            </div>
            <div className="flex items-center justify-between py-2 border-b border-slate-800/70">
              <span className="text-slate-400">aria2c Accelerated Downloader</span>
              <span className="text-slate-200">{metrics.binaries.aria2c}</span>
            </div>
            <div className="flex items-center justify-between py-2 border-b border-slate-800/70">
              <span className="text-slate-400">FFmpeg Frame Engine</span>
              <span className="text-slate-200 truncate max-w-[260px]">{metrics.binaries.ffmpeg}</span>
            </div>
            <div className="flex items-center justify-between py-2">
              <span className="text-slate-400">FFprobe Stream Analyzer</span>
              <span className="text-slate-200 truncate max-w-[260px]">{metrics.binaries.ffprobe}</span>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
};

// ==================== LOGS VIEW ====================

interface LogsViewProps {
  logs: LogEntry[];
  onClearLogs: () => Promise<void>;
}

export const LogsView: React.FC<LogsViewProps> = ({ logs, onClearLogs }) => {
  const [sourceFilter, setSourceFilter] = useState<string>('ALL');

  const filtered = logs.filter((l) =>
    sourceFilter === 'ALL' ? true : l.source === sourceFilter
  );

  return (
    <div className="space-y-4">
      <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-4 bg-[#131722] border border-slate-800/90 rounded-xl p-5">
        <div className="flex items-center gap-2.5">
          <Terminal className="w-5 h-5 text-[#3985FF]" />
          <div>
            <h2 className="text-base font-display font-semibold text-white">
              Structured System & Pipeline Logs
            </h2>
            <p className="text-xs text-slate-400">
              Real-time event stream from Node.js queue, Python Wzgram, yt-dlp, aria2c, and FFmpeg
            </p>
          </div>
        </div>

        <div className="flex items-center gap-2">
          <select
            value={sourceFilter}
            onChange={(e) => setSourceFilter(e.target.value)}
            className="bg-[#090B10] border border-slate-800 rounded-lg px-3 py-1.5 text-xs text-slate-200 outline-none"
          >
            <option value="ALL">All Subsystems</option>
            <option value="TELEGRAM">TELEGRAM (Wzgram)</option>
            <option value="DOWNLOADER">DOWNLOADER (yt-dlp/aria2c)</option>
            <option value="MEDIA">MEDIA (FFprobe/FFmpeg)</option>
            <option value="STORAGE">STORAGE</option>
            <option value="SYSTEM">SYSTEM</option>
          </select>

          <button
            onClick={onClearLogs}
            className="px-3 py-1.5 rounded-lg bg-slate-800 hover:bg-slate-700 text-xs text-slate-300 font-medium cursor-pointer"
          >
            Clear Logs
          </button>
        </div>
      </div>

      <div className="bg-[#090B10] border border-slate-800/90 rounded-xl p-4 font-mono text-xs h-[540px] overflow-y-auto space-y-1.5">
        {filtered.length === 0 ? (
          <div className="text-slate-500 py-8 text-center">No log entries recorded yet.</div>
        ) : (
          filtered.map((entry) => (
            <div
              key={entry.id}
              className="py-1.5 px-2 rounded hover:bg-[#131722] flex flex-col sm:flex-row sm:items-baseline gap-1 sm:gap-3 border-b border-slate-900"
            >
              <span className="text-slate-500 tabular-nums shrink-0">
                {new Date(entry.timestamp).toLocaleTimeString()}
              </span>
              <span
                className={`w-14 shrink-0 font-semibold ${
                  entry.level === 'ERROR'
                    ? 'text-rose-400'
                    : entry.level === 'WARN'
                    ? 'text-amber-400'
                    : 'text-emerald-400'
                }`}
              >
                [{entry.level}]
              </span>
              <span className="text-[#3985FF] w-24 shrink-0">[{entry.source}]</span>
              <span className="text-slate-200 break-all">
                {entry.message}
                {entry.details && (
                  <span className="text-slate-400 ml-2">— {entry.details}</span>
                )}
              </span>
            </div>
          ))
        )}
      </div>
    </div>
  );
};

// ==================== SETTINGS VIEW ====================

interface SettingsViewProps {
  settings: AppConfig;
  botStatus: BotConnectionStatus;
  onSaveSettings: (updated: Partial<AppConfig>) => Promise<void>;
}

export const SettingsView: React.FC<SettingsViewProps> = ({
  settings,
  botStatus,
  onSaveSettings,
}) => {
  const [form, setForm] = useState<AppConfig>(settings);
  const [saving, setSaving] = useState(false);
  const [savedBanner, setSavedBanner] = useState(false);

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setSaving(true);
    setSavedBanner(false);
    try {
      await onSaveSettings(form);
      setSavedBanner(true);
      setTimeout(() => setSavedBanner(false), 4000);
    } finally {
      setSaving(false);
    }
  };

  return (
    <form onSubmit={handleSubmit} className="max-w-5xl mx-auto space-y-6">
      <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-4 bg-[#131722] border border-slate-800/90 rounded-xl p-5">
        <div>
          <h2 className="text-base font-display font-semibold text-white">
            System & Wzgram MTProto Configuration
          </h2>
          <p className="text-xs text-slate-400 mt-0.5">
            Configure Telegram credentials, aria2c multi-connection acceleration, FFmpeg thumbnail parameters, and storage cleanup rules.
          </p>
        </div>

        <button
          type="submit"
          disabled={saving}
          className="px-5 py-2.5 rounded-lg bg-[#3985FF] hover:bg-[#2563EB] disabled:opacity-50 text-white text-xs font-semibold flex items-center gap-2 whitespace-nowrap shrink-0 cursor-pointer"
        >
          <Save className="w-4 h-4" />
          {saving ? 'Applying Configuration...' : 'Save & Sync Wzgram'}
        </button>
      </div>

      {savedBanner && (
        <div className="p-3.5 rounded-xl bg-emerald-500/15 border border-emerald-500/30 text-xs text-emerald-300 flex items-center gap-2">
          <CheckCircle2 className="w-4 h-4 text-emerald-400 shrink-0" />
          <span>Configuration saved and synchronized with the Python Wzgram worker.</span>
        </div>
      )}

      <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
        {/* Telegram Wzgram Credentials */}
        <div className="bg-[#131722] border border-slate-800/90 rounded-xl p-6 space-y-4">
          <h3 className="text-sm font-display font-semibold text-white">
            1. Telegram Bot (Wzgram MTProto)
          </h3>
          <p className="text-xs text-slate-400">
            Status: <span className="text-slate-200">{botStatus.message}</span>
          </p>

          <div>
            <label className="block text-xs text-slate-300 mb-1">
              BOT_TOKEN (@BotFather)
            </label>
            <input
              type="password"
              value={form.botToken}
              onChange={(e) => setForm({ ...form, botToken: e.target.value })}
              placeholder="123456789:AAH..."
              className="w-full bg-[#090B10] border border-slate-800 focus:border-[#3985FF] rounded-lg px-3.5 py-2 text-xs font-mono text-white outline-none"
            />
          </div>

          <div className="grid grid-cols-2 gap-3">
            <div>
              <label className="block text-xs text-slate-300 mb-1">
                API_ID (my.telegram.org)
              </label>
              <input
                type="text"
                value={form.apiId}
                onChange={(e) => setForm({ ...form, apiId: e.target.value })}
                placeholder="20401234"
                className="w-full bg-[#090B10] border border-slate-800 focus:border-[#3985FF] rounded-lg px-3.5 py-2 text-xs font-mono text-white outline-none"
              />
            </div>
            <div>
              <label className="block text-xs text-slate-300 mb-1">
                API_HASH (my.telegram.org)
              </label>
              <input
                type="password"
                value={form.apiHash}
                onChange={(e) => setForm({ ...form, apiHash: e.target.value })}
                placeholder="b18441a1ff607e10a989891a..."
                className="w-full bg-[#090B10] border border-slate-800 focus:border-[#3985FF] rounded-lg px-3.5 py-2 text-xs font-mono text-white outline-none"
              />
            </div>
          </div>

          <div>
            <label className="block text-xs text-slate-300 mb-1">
              TARGET_CHANNEL (Default Channel / Chat ID)
            </label>
            <input
              type="text"
              value={form.targetChannel}
              onChange={(e) => setForm({ ...form, targetChannel: e.target.value })}
              placeholder="@velofetch_media or -100123456789"
              className="w-full bg-[#090B10] border border-slate-800 focus:border-[#3985FF] rounded-lg px-3.5 py-2 text-xs font-mono text-white outline-none"
            />
          </div>
        </div>

        {/* Download & aria2c Configuration */}
        <div className="bg-[#131722] border border-slate-800/90 rounded-xl p-6 space-y-4">
          <h3 className="text-sm font-display font-semibold text-white">
            2. yt-dlp & aria2c Acceleration
          </h3>

          <div className="grid grid-cols-2 gap-3">
            <div>
              <label className="block text-xs text-slate-300 mb-1">
                Max Concurrent Jobs
              </label>
              <input
                type="number"
                min={1}
                max={10}
                value={form.maxConcurrentJobs}
                onChange={(e) =>
                  setForm({ ...form, maxConcurrentJobs: Number(e.target.value) })
                }
                className="w-full bg-[#090B10] border border-slate-800 focus:border-[#3985FF] rounded-lg px-3.5 py-2 text-xs font-mono text-white outline-none"
              />
            </div>

            <div>
              <label className="block text-xs text-slate-300 mb-1">
                aria2c Max Connections (-x)
              </label>
              <input
                type="number"
                min={1}
                max={16}
                value={form.aria2cConnections}
                onChange={(e) =>
                  setForm({ ...form, aria2cConnections: Number(e.target.value) })
                }
                className="w-full bg-[#090B10] border border-slate-800 focus:border-[#3985FF] rounded-lg px-3.5 py-2 text-xs font-mono text-white outline-none"
              />
            </div>
          </div>

          <div className="grid grid-cols-2 gap-3">
            <div>
              <label className="block text-xs text-slate-300 mb-1">
                aria2c Split Segments (-s)
              </label>
              <input
                type="number"
                min={1}
                max={16}
                value={form.aria2cSplit}
                onChange={(e) => setForm({ ...form, aria2cSplit: Number(e.target.value) })}
                className="w-full bg-[#090B10] border border-slate-800 focus:border-[#3985FF] rounded-lg px-3.5 py-2 text-xs font-mono text-white outline-none"
              />
            </div>

            <div>
              <label className="block text-xs text-slate-300 mb-1">
                Minimum Split Size (-k)
              </label>
              <input
                type="text"
                value={form.minSplitSize}
                onChange={(e) => setForm({ ...form, minSplitSize: e.target.value })}
                className="w-full bg-[#090B10] border border-slate-800 focus:border-[#3985FF] rounded-lg px-3.5 py-2 text-xs font-mono text-white outline-none"
              />
            </div>
          </div>

          <div className="pt-2 space-y-2">
            <label className="flex items-center gap-2.5 text-xs text-slate-300 cursor-pointer">
              <input
                type="checkbox"
                checked={form.autoCleanupAfterUpload}
                onChange={(e) =>
                  setForm({ ...form, autoCleanupAfterUpload: e.target.checked })
                }
                className="rounded border-slate-700 bg-[#090B10] text-[#3985FF]"
              />
              <span>
                Automatically delete source video & temp files after confirmed Telegram upload
              </span>
            </label>

            <label className="flex items-center gap-2.5 text-xs text-slate-300 cursor-pointer">
              <input
                type="checkbox"
                checked={form.retainFailedFiles}
                onChange={(e) => setForm({ ...form, retainFailedFiles: e.target.checked })}
                className="rounded border-slate-700 bg-[#090B10] text-[#3985FF]"
              />
              <span>Retain downloaded files on disk when an upload fails for 1-click retry</span>
            </label>
          </div>
        </div>

        {/* FFmpeg Thumbnail & Caption Template */}
        <div className="lg:col-span-2 bg-[#131722] border border-slate-800/90 rounded-xl p-6 space-y-4">
          <h3 className="text-sm font-display font-semibold text-white">
            3. FFmpeg Thumbnail & Automatic Metadata Caption Template
          </h3>

          <div className="grid grid-cols-1 sm:grid-cols-3 gap-4">
            <div>
              <label className="block text-xs text-slate-300 mb-1">
                Default Thumbnail Timestamp
              </label>
              <input
                type="text"
                value={form.thumbnailTimestamp}
                onChange={(e) =>
                  setForm({ ...form, thumbnailTimestamp: e.target.value })
                }
                className="w-full bg-[#090B10] border border-slate-800 focus:border-[#3985FF] rounded-lg px-3.5 py-2 text-xs font-mono text-white outline-none"
              />
            </div>
            <div>
              <label className="block text-xs text-slate-300 mb-1">
                Thumbnail Max Width (px)
              </label>
              <input
                type="number"
                value={form.thumbnailWidth}
                onChange={(e) =>
                  setForm({ ...form, thumbnailWidth: Number(e.target.value) })
                }
                className="w-full bg-[#090B10] border border-slate-800 focus:border-[#3985FF] rounded-lg px-3.5 py-2 text-xs font-mono text-white outline-none"
              />
            </div>
            <div>
              <label className="block text-xs text-slate-300 mb-1">
                JPEG Compression Quality (1-100)
              </label>
              <input
                type="number"
                min={30}
                max={100}
                value={form.thumbnailQuality}
                onChange={(e) =>
                  setForm({ ...form, thumbnailQuality: Number(e.target.value) })
                }
                className="w-full bg-[#090B10] border border-slate-800 focus:border-[#3985FF] rounded-lg px-3.5 py-2 text-xs font-mono text-white outline-none"
              />
            </div>
          </div>

          <div>
            <label className="block text-xs text-slate-300 mb-1">
              Caption Metadata Template (Variables: <code className="text-[#3985FF]">{'{title}'}</code>,{' '}
              <code className="text-[#3985FF]">{'{resolution}'}</code>,{' '}
              <code className="text-[#3985FF]">{'{width}'}</code>,{' '}
              <code className="text-[#3985FF]">{'{height}'}</code>,{' '}
              <code className="text-[#3985FF]">{'{duration_formatted}'}</code>,{' '}
              <code className="text-[#3985FF]">{'{video_codec}'}</code>,{' '}
              <code className="text-[#3985FF]">{'{audio_codec}'}</code>,{' '}
              <code className="text-[#3985FF]">{'{file_size_formatted}'}</code>)
            </label>
            <textarea
              rows={4}
              value={form.captionTemplate}
              onChange={(e) => setForm({ ...form, captionTemplate: e.target.value })}
              className="w-full bg-[#090B10] border border-slate-800 focus:border-[#3985FF] rounded-lg p-3 text-xs font-mono text-slate-200 outline-none"
            />
          </div>
        </div>
      </div>
    </form>
  );
};
