/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

import React, { useEffect, useState, useRef, useCallback } from 'react';
import { Menu, PlusCircle } from 'lucide-react';
import {
  NavSection,
  JobRecord,
  ChannelRecord,
  UploadHistoryRecord,
  SystemMetrics,
  BotConnectionStatus,
  AppConfig,
  LogEntry,
} from '../frontend/types.ts';
import { Sidebar } from '../frontend/Sidebar.tsx';
import { DashboardView } from '../frontend/DashboardView.tsx';
import { NewDownloadView } from '../frontend/NewDownloadView.tsx';
import { FetchLinksView } from '../frontend/FetchLinksView.tsx';
import { ActiveJobsView } from '../frontend/ActiveJobsView.tsx';
import { MediaLibraryView, UploadHistoryView } from '../frontend/MediaAndHistoryViews.tsx';
import {
  ChannelsView,
  SystemMonitorView,
  LogsView,
  SettingsView,
} from '../frontend/ManagementViews.tsx';

const SECTION_TITLES: Record<NavSection, string> = {
  dashboard: 'Workspace / Dashboard',
  'new-download': 'Workspace / New Download',
  'fetch-links': 'Workspace / Fetch Direct Links',
  'active-jobs': 'Workspace / Active Jobs',
  'media-library': 'Workspace / Media Library',
  'upload-history': 'Workspace / Upload History',
  channels: 'Management / Channels & Chats',
  'system-monitor': 'Management / System Monitor',
  logs: 'Management / Logs',
  settings: 'Management / Settings',
};

export default function App() {
  const [activeSection, setActiveSection] = useState<NavSection>('dashboard');
  const [sidebarCollapsed, setSidebarCollapsed] = useState<boolean>(() => {
    try {
      return localStorage.getItem('velofetch_sidebar_collapsed') === 'true';
    } catch {
      return false;
    }
  });
  const [mobileDrawerOpen, setMobileDrawerOpen] = useState(false);

  const [jobs, setJobs] = useState<JobRecord[]>([]);
  const [channels, setChannels] = useState<ChannelRecord[]>([]);
  const [history, setHistory] = useState<UploadHistoryRecord[]>([]);
  const [metrics, setMetrics] = useState<SystemMetrics | null>(null);
  const [logs, setLogs] = useState<LogEntry[]>([]);
  const [botStatus, setBotStatus] = useState<BotConnectionStatus>({
    online: false,
    mode: 'connecting',
    wzgramVersion: '3.1.7',
    message: 'Connecting to Wzgram MTProto worker...',
  });
  const [settings, setSettings] = useState<AppConfig>({
    botToken: '',
    apiId: '',
    apiHash: '',
    targetChannel: '',
    maxConcurrentJobs: 3,
    aria2cConnections: 16,
    aria2cSplit: 16,
    minSplitSize: '1M',
    defaultQuality: 'best',
    thumbnailTimestamp: '00:00:02',
    thumbnailWidth: 640,
    thumbnailQuality: 85,
    captionTemplate: '',
    autoCleanupAfterUpload: true,
    retainFailedFiles: true,
    maxStorageGb: 25,
  });

  const wsRef = useRef<WebSocket | null>(null);

  const toggleSidebarCollapse = () => {
    setSidebarCollapsed((prev) => {
      const next = !prev;
      try {
        localStorage.setItem('velofetch_sidebar_collapsed', String(next));
      } catch {
        // Ignore
      }
      return next;
    });
  };

  // Fetch initial state via HTTP fallback and connect WebSocket for live sync
  const fetchFullState = useCallback(async () => {
    try {
      const res = await fetch('/api/state');
      if (!res.ok) return;
      const data = await res.json();
      if (Array.isArray(data.jobs)) setJobs(data.jobs.filter((j: any) => j && j.id));
      if (Array.isArray(data.channels)) setChannels(data.channels.filter((c: any) => c && c.id));
      if (Array.isArray(data.history)) setHistory(data.history.filter((h: any) => h && h.id));
      if (data.settings) setSettings(data.settings);
      if (data.botStatus) setBotStatus(data.botStatus);
      if (data.metrics) setMetrics(data.metrics);
      if (Array.isArray(data.logs)) setLogs(data.logs.filter((l: any) => l && l.id));
    } catch {
      // Ignore transient errors
    }
  }, []);

  useEffect(() => {
    fetchFullState();

    let reconnectTimer: ReturnType<typeof setTimeout>;
    const connectWs = () => {
      const proto = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
      const wsUrl = `${proto}//${window.location.host}/ws`;
      const ws = new WebSocket(wsUrl);
      wsRef.current = ws;

      ws.onmessage = (event) => {
        try {
          const msg = JSON.parse(event.data);
          const { type, data } = msg;

          switch (type) {
            case 'init':
              if (!data) break;
              if (Array.isArray(data.jobs)) setJobs(data.jobs.filter((j: any) => j && j.id));
              if (Array.isArray(data.channels)) setChannels(data.channels.filter((c: any) => c && c.id));
              if (Array.isArray(data.history)) setHistory(data.history.filter((h: any) => h && h.id));
              if (data.settings) setSettings(data.settings);
              if (data.botStatus) setBotStatus(data.botStatus);
              if (data.metrics) setMetrics(data.metrics);
              if (Array.isArray(data.logs)) setLogs(data.logs.filter((l: any) => l && l.id));
              break;

            case 'job:created':
              if (!data || !data.id) break;
              setJobs((prev) => {
                const clean = prev.filter((j) => j && j.id);
                if (clean.some((j) => j.id === data.id)) return clean;
                return [data, ...clean];
              });
              break;

            case 'job:updated':
              if (!data || !data.id) break;
              setJobs((prev) => {
                const clean = prev.filter((j) => j && j.id);
                const exists = clean.some((j) => j.id === data.id);
                if (!exists) return [data, ...clean];
                return clean.map((j) => (j.id === data.id ? data : j));
              });
              break;

            case 'job:deleted':
              if (!data || !data.id) break;
              setJobs((prev) => prev.filter((j) => j && j.id && j.id !== data.id));
              break;

            case 'history:updated':
              if (Array.isArray(data)) setHistory(data.filter((h: any) => h && h.id));
              break;

            case 'channels:updated':
              if (Array.isArray(data)) setChannels(data.filter((c: any) => c && c.id));
              break;

            case 'settings:updated':
              if (data) setSettings(data);
              break;

            case 'bot:status':
              if (data) setBotStatus(data);
              break;

            case 'system:metrics':
              if (data) setMetrics(data);
              break;

            case 'log:entry':
              if (!data || !data.id) break;
              setLogs((prev) => {
                const clean = prev.filter((l) => l && l.id);
                if (clean.some((l) => l.id === data.id)) return clean;
                return [data, ...clean.slice(0, 199)];
              });
              break;

            case 'logs:cleared':
              setLogs([]);
              break;
          }
        } catch {
          // Ignore malformed WS message
        }
      };

      ws.onclose = () => {
        reconnectTimer = setTimeout(connectWs, 2500);
      };
    };

    connectWs();

    return () => {
      clearTimeout(reconnectTimer);
      wsRef.current?.close();
    };
  }, [fetchFullState]);

  // Action Handlers
  const handleQuickSubmit = async (url: string, destinationId: string, quality: string) => {
    const res = await fetch('/api/jobs', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        url,
        destinationId,
        quality,
        formatId: quality,
        useAutoCaption: true,
      }),
    });
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || 'Failed to enqueue job');
  };

  const handleStartJob = async (payload: any) => {
    const res = await fetch('/api/jobs', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    });
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || 'Failed to start job');
  };

  const handleCancelJob = async (id: string) => {
    await fetch(`/api/jobs/${id}/cancel`, { method: 'POST' });
  };

  const handleRetryJob = async (id: string) => {
    await fetch(`/api/jobs/${id}/retry`, { method: 'POST' });
  };

  const handleDeleteJob = async (id: string) => {
    await fetch(`/api/jobs/${id}`, { method: 'DELETE' });
  };

  const handleAddChannel = async (payload: {
    name: string;
    chatId: string;
    type: 'channel' | 'group' | 'private';
    isDefault: boolean;
  }) => {
    const res = await fetch('/api/channels', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    });
    if (res.ok) {
      const updated = await res.json();
      setChannels(updated);
    }
  };

  const handleSetDefaultChannel = async (id: string) => {
    const res = await fetch(`/api/channels/${id}/default`, { method: 'POST' });
    if (res.ok) {
      setChannels(await res.json());
    }
  };

  const handleVerifyChannel = async (id: string) => {
    const res = await fetch(`/api/channels/${id}/verify`, { method: 'POST' });
    if (res.ok) {
      const data = await res.json();
      if (data.channels) setChannels(data.channels);
    }
  };

  const handleDeleteChannel = async (id: string) => {
    const res = await fetch(`/api/channels/${id}`, { method: 'DELETE' });
    if (res.ok) {
      setChannels(await res.json());
    }
  };

  const handleManualCleanup = async (includeFailed: boolean) => {
    const res = await fetch('/api/storage/cleanup', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ includeFailed }),
    });
    return await res.json();
  };

  const handleClearLogs = async () => {
    await fetch('/api/logs', { method: 'DELETE' });
  };

  const handleSaveSettings = async (updated: Partial<AppConfig>) => {
    const res = await fetch('/api/settings', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(updated),
    });
    if (res.ok) {
      setSettings(await res.json());
    }
  };

  const activeJobCount = jobs.filter(
    (j) => j && ['queued', 'extracting', 'downloading', 'processing_media', 'uploading'].includes(j.status)
  ).length;

  return (
    <div className="min-h-screen bg-[#090B10] text-slate-100 flex">
      {/* Fixed Collapsible Left Sidebar */}
      <Sidebar
        activeSection={activeSection}
        onSelectSection={setActiveSection}
        collapsed={sidebarCollapsed}
        onToggleCollapse={toggleSidebarCollapse}
        mobileOpen={mobileDrawerOpen}
        onCloseMobile={() => setMobileDrawerOpen(false)}
        botStatus={botStatus}
        activeJobCount={activeJobCount}
      />

      {/* Main Content Area */}
      <div
        className={`flex-1 flex flex-col min-w-0 transition-all duration-200 ${
          sidebarCollapsed ? 'lg:pl-[72px]' : 'lg:pl-[256px]'
        }`}
      >
        {/* Top Bar Contract: Zone 1 Breadcrumb — Zone 2 Quick Nav — Zone 3 Primary Action */}
        <header className="sticky top-0 z-20 h-16 bg-[#090B10]/90 backdrop-blur-md border-b border-slate-800/80 px-6 flex items-center justify-between gap-8">
          <div className="flex items-center gap-3 min-w-0">
            <button
              onClick={() => setMobileDrawerOpen(true)}
              className="lg:hidden p-2 rounded-lg bg-[#131722] border border-slate-800 text-slate-300 hover:text-white"
            >
              <Menu className="w-4 h-4" />
            </button>
            <span className="font-display font-semibold text-sm sm:text-base text-white whitespace-nowrap shrink-0">
              {SECTION_TITLES[activeSection]}
            </span>
          </div>

          <nav className="hidden md:flex items-center gap-6 text-xs font-medium text-slate-400">
            <button
              onClick={() => setActiveSection('dashboard')}
              className={`hover:text-white transition-colors whitespace-nowrap shrink-0 cursor-pointer ${
                activeSection === 'dashboard' ? 'text-white underline underline-offset-4' : ''
              }`}
            >
              Overview
            </button>
            <button
              onClick={() => setActiveSection('active-jobs')}
              className={`hover:text-white transition-colors whitespace-nowrap shrink-0 cursor-pointer ${
                activeSection === 'active-jobs' ? 'text-white underline underline-offset-4' : ''
              }`}
            >
              Queue ({activeJobCount})
            </button>
            <button
              onClick={() => setActiveSection('media-library')}
              className={`hover:text-white transition-colors whitespace-nowrap shrink-0 cursor-pointer ${
                activeSection === 'media-library' ? 'text-white underline underline-offset-4' : ''
              }`}
            >
              Media Library
            </button>
            <button
              onClick={() => setActiveSection('system-monitor')}
              className={`hover:text-white transition-colors whitespace-nowrap shrink-0 cursor-pointer ${
                activeSection === 'system-monitor' ? 'text-white underline underline-offset-4' : ''
              }`}
            >
              System Monitor
            </button>
          </nav>

          <div className="flex items-center shrink-0">
            <button
              onClick={() => setActiveSection('new-download')}
              className="px-4 py-2 rounded-lg bg-[#3985FF] hover:bg-[#2563EB] text-white text-xs font-semibold transition-colors flex items-center gap-1.5 whitespace-nowrap shrink-0 cursor-pointer"
            >
              <PlusCircle className="w-3.5 h-3.5" />
              New Download
            </button>
          </div>
        </header>

        {/* Scrollable Viewport Content */}
        <main className="flex-1 p-6 max-w-[1440px] w-full mx-auto">
          {activeSection === 'dashboard' && (
            <DashboardView
              jobs={jobs}
              channels={channels}
              metrics={metrics}
              botStatus={botStatus}
              onQuickSubmit={handleQuickSubmit}
              onCancelJob={handleCancelJob}
              onRetryJob={handleRetryJob}
              onNavigate={setActiveSection}
            />
          )}

          {activeSection === 'new-download' && (
            <NewDownloadView
              channels={channels}
              settings={settings}
              onStartJob={handleStartJob}
              onNavigate={setActiveSection}
            />
          )}

          {activeSection === 'fetch-links' && (
            <FetchLinksView
              channels={channels}
              onStartJob={handleStartJob}
              onNavigate={setActiveSection}
            />
          )}

          {activeSection === 'active-jobs' && (
            <ActiveJobsView
              jobs={jobs}
              onCancelJob={handleCancelJob}
              onRetryJob={handleRetryJob}
              onDeleteJob={handleDeleteJob}
              onNavigate={setActiveSection}
            />
          )}

          {activeSection === 'media-library' && (
            <MediaLibraryView jobs={jobs} onRetryJob={handleRetryJob} />
          )}

          {activeSection === 'upload-history' && (
            <UploadHistoryView history={history} onRetryJob={handleRetryJob} />
          )}

          {activeSection === 'channels' && (
            <ChannelsView
              channels={channels}
              onAddChannel={handleAddChannel}
              onSetDefault={handleSetDefaultChannel}
              onVerifyChannel={handleVerifyChannel}
              onDeleteChannel={handleDeleteChannel}
            />
          )}

          {activeSection === 'system-monitor' && (
            <SystemMonitorView
              metrics={metrics}
              onManualCleanup={handleManualCleanup}
            />
          )}

          {activeSection === 'logs' && (
            <LogsView logs={logs} onClearLogs={handleClearLogs} />
          )}

          {activeSection === 'settings' && (
            <SettingsView
              settings={settings}
              botStatus={botStatus}
              onSaveSettings={handleSaveSettings}
            />
          )}
        </main>
      </div>
    </div>
  );
}
