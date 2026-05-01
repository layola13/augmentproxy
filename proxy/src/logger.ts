import type { ProxyConfig } from "./types.ts";

const levels: Record<string, number> = {
  silent: 0,
  error: 1,
  warn: 2,
  info: 3,
  debug: 4,
};

function enabled(config: ProxyConfig, level: keyof typeof levels): boolean {
  return (levels[config.logLevel] ?? levels.info) >= levels[level];
}

function line(level: string, message: string, meta?: Record<string, unknown>): void {
  const suffix = meta ? ` ${JSON.stringify(meta)}` : "";
  console.log(`[${new Date().toISOString()}] ${level.toUpperCase()} ${message}${suffix}`);
}

export function logInfo(config: ProxyConfig, message: string, meta?: Record<string, unknown>): void {
  if (enabled(config, "info")) line("info", message, meta);
}

export function logWarn(config: ProxyConfig, message: string, meta?: Record<string, unknown>): void {
  if (enabled(config, "warn")) line("warn", message, meta);
}

export function logError(config: ProxyConfig, message: string, meta?: Record<string, unknown>): void {
  if (enabled(config, "error")) line("error", message, meta);
}

export function logDebug(config: ProxyConfig, message: string, meta?: Record<string, unknown>): void {
  if (enabled(config, "debug")) line("debug", message, meta);
}
