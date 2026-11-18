import React from 'react';
import {
  LayoutDashboard,
  PlusCircle,
  Link2,
  Activity,
  Film,
  History,
  Radio,
  Cpu,
  Terminal,
  Settings,
  ChevronLeft,
  ChevronRight,
  Zap,
  X,
  Bot,
  ShieldCheck,
} from 'lucide-react';
import { NavSection, BotConnectionStatus } from './types.ts';

interface SidebarProps {
  activeSection: NavSection;
  onSelectSection: (section: NavSection) => void;
  collapsed: boolean;
  onToggleCollapse: () => void;
  mobileOpen: boolean;
  onCloseMobile: () => void;
  botStatus: BotConnectionStatus;
  activeJobCount: number;
}

interface NavItem {
  id: NavSection;
  label: string;
  icon: React.ComponentType<{ className?: string }>;
  group: 'WORKSPACE' | 'MANAGEMENT';
  count?: number;
}

export const Sidebar: React.FC<SidebarProps> = ({
  activeSection,
  onSelectSection,
  collapsed,
  onToggleCollapse,
  mobileOpen,
  onCloseMobile,
  botStatus,
  activeJobCount,
}) => {
  const navItems: NavItem[] = [
    { id: 'dashboard', label: 'Dashboard', icon: LayoutDashboard, group: 'WORKSPACE' },
    { id: 'new-download', label: 'New Download', icon: PlusCircle, group: 'WORKSPACE' },
    { id: 'fetch-links', label: 'Fetch Links', icon: Link2, group: 'WORKSPACE' },
    { id: 'active-jobs', label: 'Active Jobs', icon: Activity, group: 'WORKSPACE', count: activeJobCount },
    { id: 'media-library', label: 'Media Library', icon: Film, group: 'WORKSPACE' },
    { id: 'upload-history', label: 'Upload History', icon: History, group: 'WORKSPACE' },
    { id: 'channels', label: 'Channels & Chats', icon: Radio, group: 'MANAGEMENT' },
    { id: 'system-monitor', label: 'System Monitor', icon: Cpu, group: 'MANAGEMENT' },
    { id: 'logs', label: 'Logs', icon: Terminal, group: 'MANAGEMENT' },
    { id: 'settings', label: 'Settings', icon: Settings, group: 'MANAGEMENT' },
  ];

  const renderGroup = (groupName: 'WORKSPACE' | 'MANAGEMENT') => {
    const items = navItems.filter((i) => i.group === groupName);
    return (
      <div className="mb-6">
        {!collapsed && (
          <div className="px-3 mb-2 text-[11px] font-medium tracking-wider text-slate-500 select-none">
            {groupName === 'WORKSPACE' ? 'Workspace' : 'Management'}
          </div>
        )}
        <div className="space-y-1">
          {items.map((item) => {
            const Icon = item.icon;
            const isActive = activeSection === item.id;
            return (
              <div key={item.id} className="relative group">
                <button
                  onClick={() => {
                    onSelectSection(item.id);
                    onCloseMobile();
                  }}
                  className={`w-full flex items-center ${
                    collapsed ? 'justify-center px-2' : 'justify-between px-3'
                  } py-2.5 rounded-lg text-sm font-medium transition-colors duration-150 whitespace-nowrap shrink-0 ${
                    isActive
                      ? 'bg-[#3985FF]/15 text-[#3985FF] border border-[#3985FF]/30'
                      : 'text-slate-400 hover:text-slate-100 hover:bg-[#131722] border border-transparent'
                  }`}
                >
                  <div className="flex items-center gap-3 min-w-0">
                    <Icon
                      className={`w-4 h-4 shrink-0 ${
                        isActive ? 'text-[#3985FF]' : 'text-slate-400 group-hover:text-slate-200'
                      }`}
                    />
                    {!collapsed && <span className="truncate">{item.label}</span>}
                  </div>
                  {!collapsed && item.count !== undefined && item.count > 0 && (
                    <span className="font-mono text-xs tabular-nums text-[#3985FF] font-semibold">
                      {item.count}
                    </span>
                  )}
                </button>

                {/* Tooltip when collapsed */}
                {collapsed && (
                  <div className="pointer-events-none opacity-0 group-hover:opacity-100 transition-opacity duration-150 fixed left-[76px] z-50 px-2.5 py-1.5 rounded-md bg-[#131722] border border-slate-800 text-xs font-medium text-slate-100 shadow-lg whitespace-nowrap">
                    {item.label}
                    {item.count ? ` (${item.count})` : ''}
                  </div>
                )}
              </div>
            );
          })}
        </div>
      </div>
    );
  };

  const sidebarContent = (
    <div className="flex flex-col h-full bg-[#0B0F19] border-r border-slate-800/80 select-none">
      {/* Brand Header */}
      <div
        className={`h-16 flex items-center ${
          collapsed ? 'justify-center px-2' : 'justify-between px-4'
        } border-b border-slate-800/80 shrink-0`}
      >
        <div className="flex items-center gap-2.5 min-w-0">
          <div className="w-8 h-8 rounded-lg bg-[#3985FF] flex items-center justify-center text-white shrink-0 shadow-sm">
            <Zap className="w-4 h-4 fill-current" />
          </div>
          {!collapsed && (
            <span className="font-display font-bold text-base tracking-tight text-white truncate">
              VeloFetch
            </span>
          )}
        </div>

        {/* Desktop Collapse Toggle */}
        <button
          onClick={onToggleCollapse}
          title={collapsed ? 'Expand sidebar' : 'Collapse sidebar'}
          className="hidden lg:flex items-center justify-center w-7 h-7 rounded-md text-slate-400 hover:text-white hover:bg-[#131722] transition-colors"
        >
          {collapsed ? <ChevronRight className="w-4 h-4" /> : <ChevronLeft className="w-4 h-4" />}
        </button>

        {/* Mobile Drawer Close */}
        <button
          onClick={onCloseMobile}
          className="lg:hidden flex items-center justify-center w-7 h-7 rounded-md text-slate-400 hover:text-white"
        >
          <X className="w-4 h-4" />
        </button>
      </div>

      {/* Scrollable Navigation */}
      <div className="flex-1 overflow-y-auto px-3 py-5">
        {renderGroup('WORKSPACE')}
        {renderGroup('MANAGEMENT')}
      </div>

      {/* Telegram Bot Online/Offline Indicator */}
      <div className="px-3 py-3 border-t border-slate-800/80">
        <button
          onClick={() => onSelectSection('settings')}
          title={botStatus.message}
          className={`w-full flex items-center ${
            collapsed ? 'justify-center p-2' : 'justify-between px-3 py-2.5'
          } rounded-lg bg-[#131722] border border-slate-800/90 hover:border-slate-700 transition-colors text-left`}
        >
          <div className="flex items-center gap-2.5 min-w-0">
            <Bot
              className={`w-4 h-4 shrink-0 ${
                botStatus.online ? 'text-emerald-400' : 'text-[#3985FF]'
              }`}
            />
            {!collapsed && (
              <div className="min-w-0">
                <div className="text-xs font-medium text-slate-200 truncate">
                  {botStatus.online
                    ? `@${botStatus.botInfo?.username || 'velofetch_bot'}`
                    : 'Wzgram Standby'}
                </div>
                <div className="text-[11px] text-slate-400 truncate">
                  {botStatus.online ? 'MTProto Polling Active' : `Wzgram v${botStatus.wzgramVersion}`}
                </div>
              </div>
            )}
          </div>
          {!collapsed && (
            <span
              className={`text-[11px] font-mono font-medium shrink-0 ${
                botStatus.online ? 'text-emerald-400' : 'text-amber-400'
              }`}
            >
              {botStatus.online ? 'Online' : 'Ready'}
            </span>
          )}
        </button>
      </div>

      {/* Administrator Profile Section */}
      <div className="p-3 border-t border-slate-800/80">
        <div
          className={`flex items-center ${
            collapsed ? 'justify-center' : 'gap-3 px-2 py-1.5'
          }`}
        >
          <div className="w-8 h-8 rounded-lg bg-slate-800 border border-slate-700 flex items-center justify-center text-xs font-semibold text-slate-200 shrink-0">
            VF
          </div>
          {!collapsed && (
            <div className="min-w-0 flex-1">
              <div className="flex items-center gap-1.5">
                <span className="text-xs font-semibold text-slate-200 truncate">
                  System Administrator
                </span>
                <ShieldCheck className="w-3.5 h-3.5 text-[#3985FF] shrink-0" />
              </div>
              <div className="text-[11px] text-slate-500 truncate">
                telebottg7@gmail.com
              </div>
            </div>
          )}
        </div>
      </div>
    </div>
  );

  return (
    <>
      {/* Fixed Desktop Sidebar */}
      <aside
        className={`hidden lg:block fixed top-0 left-0 bottom-0 z-30 transition-all duration-200 ${
          collapsed ? 'w-[72px]' : 'w-[256px]'
        }`}
      >
        {sidebarContent}
      </aside>

      {/* Responsive Mobile Drawer */}
      {mobileOpen && (
        <div className="lg:hidden fixed inset-0 z-50 flex">
          <div
            className="fixed inset-0 bg-black/70 backdrop-blur-xs"
            onClick={onCloseMobile}
          />
          <aside className="relative w-[264px] max-w-[80vw] h-full z-10">
            {sidebarContent}
          </aside>
        </div>
      )}
    </>
  );
};
