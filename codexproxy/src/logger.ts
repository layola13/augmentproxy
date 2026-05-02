import type {
  CodexProxyConfig,
  JsonObject,
  JsonValue,
  RequestLogContext,
  RetainedMessageRecord,
} from "./types.ts";

const RECENT_MESSAGES_LIMIT = 1000;
const RECENT_LOG_LINES_LIMIT = 1000;
const REQUEST_DIR_LIMIT = 1000;
let recentMessagesWriteChain = Promise.resolve();
let runtimeLogWriteChain = Promise.resolve();
let eventLogWriteChain = Promise.resolve();
let requestDirWriteChain = Promise.resolve();

function timestamp(): string {
  return new Date().toISOString();
}

function ensureTrailingNewline(value: string): string {
  return value.endsWith("\n") ? value : `${value}\n`;
}

function scrubSecret(key: string, value: unknown): unknown {
  const lower = key.toLowerCase();
  if (
    lower.includes("authorization") ||
    lower.includes("api-key") ||
    lower.includes("apikey") ||
    lower.includes("token") ||
    lower.includes("secret") ||
    lower.includes("cookie")
  ) {
    if (typeof value === "string") return "<redacted>";
    return value;
  }
  return value;
}

export function redactObject(value: unknown): unknown {
  if (Array.isArray(value)) return value.map((item) => redactObject(item));
  if (!value || typeof value !== "object") return value;
  const output: Record<string, unknown> = {};
  for (const [key, nested] of Object.entries(value as Record<string, unknown>)) {
    output[key] = scrubSecret(key, redactObject(nested));
  }
  return output;
}

export function logLine(
  level: "INFO" | "WARN" | "ERROR",
  message: string,
  meta?: Record<string, unknown>,
): void {
  const suffix = meta ? ` ${JSON.stringify(redactObject(meta))}` : "";
  console.log(`[${timestamp()}] ${level} ${message}${suffix}`);
}

function runtimeLogPath(config: CodexProxyConfig): string {
  return `${config.logDir}/server.log`;
}

function eventsLogPath(config: CodexProxyConfig): string {
  return `${config.logDir}/events.jsonl`;
}

async function trimTextFileToLastLines(path: string, maxLines: number): Promise<void> {
  try {
    const text = await Deno.readTextFile(path);
    const lines = text.split(/\r?\n/).filter((line) => line.length > 0);
    const trimmed = lines.slice(-maxLines);
    await Deno.writeTextFile(path, ensureTrailingNewline(trimmed.join("\n")));
  } catch (error) {
    if (error instanceof Deno.errors.NotFound) return;
    throw error;
  }
}

export async function appendRuntimeLog(
  config: CodexProxyConfig,
  level: "INFO" | "WARN" | "ERROR",
  message: string,
  meta?: Record<string, unknown>,
): Promise<void> {
  runtimeLogWriteChain = runtimeLogWriteChain.then(async () => {
    await ensureLogDir(config);
    const suffix = meta ? ` ${JSON.stringify(redactObject(meta))}` : "";
    const line = `[${timestamp()}] ${level} ${message}${suffix}\n`;
    const path = runtimeLogPath(config);
    await Deno.writeTextFile(path, line, { append: true });
    await trimTextFileToLastLines(path, RECENT_LOG_LINES_LIMIT);
  });
  await runtimeLogWriteChain;
}

export async function ensureLogDir(config: CodexProxyConfig): Promise<void> {
  await Deno.mkdir(config.logDir, { recursive: true });
}

export async function createRequestLogContext(
  config: CodexProxyConfig,
  requestId: string,
): Promise<RequestLogContext> {
  await ensureLogDir(config);
  const requestDir = `${config.logDir}/${requestId}`;
  await Deno.mkdir(requestDir, { recursive: true });
  requestDirWriteChain = requestDirWriteChain.then(async () => {
    const entries: string[] = [];
    for await (const entry of Deno.readDir(config.logDir)) {
      if (!entry.isDirectory || !entry.name.startsWith("req_")) continue;
      entries.push(entry.name);
    }
    entries.sort();
    for (const name of entries.slice(0, Math.max(0, entries.length - REQUEST_DIR_LIMIT))) {
      await Deno.remove(`${config.logDir}/${name}`, { recursive: true });
    }
  });
  await requestDirWriteChain;
  return { requestId, requestDir };
}

export async function appendEventLog(
  config: CodexProxyConfig,
  event: JsonObject,
): Promise<void> {
  eventLogWriteChain = eventLogWriteChain.then(async () => {
    await ensureLogDir(config);
    const path = eventsLogPath(config);
    const payload = {
      ts: timestamp(),
      ...redactObject(event) as Record<string, unknown>,
    };
    await Deno.writeTextFile(path, `${JSON.stringify(payload)}\n`, { append: true });
    await trimTextFileToLastLines(path, RECENT_LOG_LINES_LIMIT);
  });
  await eventLogWriteChain;
}

export async function writeJsonArtifact(
  ctx: RequestLogContext,
  name: string,
  value: unknown,
): Promise<string> {
  const path = `${ctx.requestDir}/${name}`;
  await Deno.writeTextFile(
    path,
    ensureTrailingNewline(JSON.stringify(redactObject(value), null, 2)),
  );
  return path;
}

export async function writeTextArtifact(
  ctx: RequestLogContext,
  name: string,
  value: string,
): Promise<string> {
  const path = `${ctx.requestDir}/${name}`;
  await Deno.writeTextFile(path, ensureTrailingNewline(value));
  return path;
}

export function headersToObject(headers: Headers): JsonObject {
  return Object.fromEntries(headers.entries());
}

function recentMessagesPath(config: CodexProxyConfig): string {
  return `${config.logDir}/recent-messages.json`;
}

async function readRetainedMessages(path: string): Promise<RetainedMessageRecord[]> {
  try {
    const text = await Deno.readTextFile(path);
    const parsed = JSON.parse(text);
    return Array.isArray(parsed) ? parsed as RetainedMessageRecord[] : [];
  } catch (error) {
    if (error instanceof Deno.errors.NotFound) return [];
    throw error;
  }
}

export async function retainRecentMessages(
  config: CodexProxyConfig,
  requestId: string,
  stage: string,
  items: JsonValue[],
): Promise<void> {
  const records: RetainedMessageRecord[] = items.map((item, index) => {
    const record = item && typeof item === "object" && !Array.isArray(item)
      ? item as Record<string, unknown>
      : {};
    return {
      ts: timestamp(),
      requestId,
      stage,
      index,
      role: typeof record.role === "string" ? record.role : undefined,
      item,
    };
  });
  if (records.length === 0) return;

  recentMessagesWriteChain = recentMessagesWriteChain.then(async () => {
    await ensureLogDir(config);
    const path = recentMessagesPath(config);
    const existing = await readRetainedMessages(path);
    const next = [...existing, ...records].slice(-RECENT_MESSAGES_LIMIT);
    await Deno.writeTextFile(
      path,
      ensureTrailingNewline(JSON.stringify(redactObject(next), null, 2)),
    );
  });

  await recentMessagesWriteChain;
}
