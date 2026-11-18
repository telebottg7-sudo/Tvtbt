import fs from 'fs';
import path from 'path';
import { LOGS_DIR, ensureDirectories } from '../config/index.ts';

export type LogLevel = 'INFO' | 'WARN' | 'ERROR' | 'DEBUG';
export type LogSource = 'SYSTEM' | 'DOWNLOADER' | 'MEDIA' | 'TELEGRAM' | 'STORAGE' | 'API';

export interface LogEntry {
  id: string;
  timestamp: string;
  level: LogLevel;
  source: LogSource;
  message: string;
  details?: string;
}

type LogListener = (entry: LogEntry) => void;

class LoggerService {
  private logFilePath: string;
  private listeners: Set<LogListener> = new Set();
  private recentLogs: LogEntry[] = [];
  private maxRecent = 300;

  constructor() {
    ensureDirectories();
    this.logFilePath = path.join(LOGS_DIR, 'velofetch.log');
  }

  public onLog(listener: LogListener): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  public log(level: LogLevel, source: LogSource, message: string, details?: string): LogEntry {
    const entry: LogEntry = {
      id: `${Date.now()}-${Math.random().toString(36).substring(2, 7)}`,
      timestamp: new Date().toISOString(),
      level,
      source,
      message,
      details,
    };

    this.recentLogs.unshift(entry);
    if (this.recentLogs.length > this.maxRecent) {
      this.recentLogs.pop();
    }

    const line = `[${entry.timestamp}] [${entry.level}] [${entry.source}] ${entry.message}${entry.details ? ' | ' + entry.details : ''}\n`;
    try {
      fs.appendFileSync(this.logFilePath, line, 'utf8');
    } catch {
      // Ignore file write errors
    }

    for (const listener of this.listeners) {
      try {
        listener(entry);
      } catch {
        // Ignore listener errors
      }
    }

    return entry;
  }

  public info(source: LogSource, message: string, details?: string) {
    return this.log('INFO', source, message, details);
  }

  public warn(source: LogSource, message: string, details?: string) {
    return this.log('WARN', source, message, details);
  }

  public error(source: LogSource, message: string, details?: string) {
    return this.log('ERROR', source, message, details);
  }

  public debug(source: LogSource, message: string, details?: string) {
    return this.log('DEBUG', source, message, details);
  }

  public getRecentLogs(limit = 150): LogEntry[] {
    return this.recentLogs.slice(0, limit);
  }

  public clearLogs(): void {
    this.recentLogs = [];
    try {
      fs.writeFileSync(this.logFilePath, '', 'utf8');
    } catch {
      // Ignore
    }
  }
}

export const logger = new LoggerService();
