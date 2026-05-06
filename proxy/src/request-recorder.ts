import type { JsonValue, RequestContext, ProxyConfig } from "./types.ts";

const SENSITIVE_KEYS = [
  "authorization",
  "access_token",
  "accesstoken",
  "api_key",
  "apikey",
  "apiKey",
  "token",
  "secret",
  "password",
  "client_secret",
];

function isSensitive(key: string): boolean {
  const lower = key.toLowerCase();
  return SENSITIVE_KEYS.some((sensitive) => lower.includes(sensitive.toLowerCase()));
}

export function redact(value: JsonValue, depth = 0): JsonValue {
  // Hard limit on recursion depth to prevent event loop blocking
  if (depth > 5) return "[NESTED_OBJECT_TRUNCATED]";
  
  if (Array.isArray(value)) {
    if (value.length > 20) return `[ARRAY_TOO_LARGE: ${value.length} items]`;
    return value.map(item => redact(item, depth + 1));
  }
  if (value && typeof value === "object") {
    const output: Record<string, JsonValue> = {};
    const keys = Object.keys(value);
    // If object has too many keys, it's likely a massive payload
    if (keys.length > 50) return `[OBJECT_TOO_LARGE: ${keys.length} keys]`;
    
    for (const [key, nested] of Object.entries(value)) {
      const lowerKey = key.toLowerCase();
      if (
        lowerKey === "chat_history" || 
        lowerKey === "nodes" || 
        lowerKey === "messages" ||
        lowerKey === "file_content" ||
        lowerKey === "input"
      ) {
         output[key] = "[SKIPPED_FOR_PERFORMANCE]";
         continue;
      }
      output[key] = isSensitive(key) ? "[REDACTED]" : redact(nested, depth + 1);
    }
    return output;
  }
  return value;
}

function headersToObject(headers: Headers): Record<string, string> {
  const output: Record<string, string> = {};
  for (const [key, value] of headers.entries()) {
    output[key] = isSensitive(key) ? "[REDACTED]" : value;
  }
  return output;
}

function safePath(path: string): string {
  const cleaned = path.replace(/^\/+/, "").replace(/[^a-zA-Z0-9._-]+/g, "_");
  return cleaned || "root";
}

function dateParts(date: Date): { day: string; stamp: string } {
  const iso = date.toISOString();
  return { day: iso.slice(0, 10), stamp: iso.replace(/[:.]/g, "-") };
}

export async function recordRequest(
  config: ProxyConfig,
  ctx: RequestContext,
  responseKind: string,
): Promise<void> {
  // Completely disable recording if log level is silent or info (too much data)
  if (config.logLevel === "silent") return;

  try {
    const now = new Date();
    const { day, stamp } = dateParts(now);
    const dir = `${config.requestLogDir}/${day}`;
    await Deno.mkdir(dir, { recursive: true });
    const file = `${dir}/${stamp}-${ctx.method}-${safePath(ctx.path)}.json`;
    const query: Record<string, string> = {};
    for (const [key, value] of ctx.url.searchParams.entries()) query[key] = value;

    // Use a size threshold to avoid processing massive requests
    // JSON.stringify on a 5MB string is slow, but redact on a 5MB object is SLOWER.
    let bodyPreview: JsonValue = undefined;
    if (ctx.body !== undefined) {
      // If the raw body string is too large, don't even try to redact it
      const bodyStr = JSON.stringify(ctx.body);
      if (bodyStr.length > 50_000) {
        bodyPreview = `[BODY_TOO_LARGE: ${bodyStr.length} bytes, skipping for performance]`;
      } else {
        bodyPreview = redact(ctx.body);
      }
    }

    const payload = {
      requestId: ctx.requestId,
      timestamp: now.toISOString(),
      method: ctx.method,
      path: ctx.path,
      query,
      headers: headersToObject(ctx.headers),
      body: bodyPreview,
      responseKind,
    };
    
    // Use non-blocking write
    Deno.writeTextFile(file, JSON.stringify(payload, null, 2)).catch(() => {});
  } catch (_e) {
    // Ignore logging errors to prevent proxy crashes
  }
}
