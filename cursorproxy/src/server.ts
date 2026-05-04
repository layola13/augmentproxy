import { Buffer } from "node:buffer";
import { existsSync, readFileSync } from "node:fs";
import http from "node:http";
import http2 from "node:http2";
import { dirname, resolve } from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

type LogLevel = "debug" | "info" | "warn" | "error";

type ProtoField =
  | { no: number; wire: 0; value: number }
  | { no: number; wire: 1; value: Buffer }
  | { no: number; wire: 2; value: Buffer }
  | { no: number; wire: 5; value: Buffer };

type ProtoBytesField = Extract<ProtoField, { wire: 2 }>;

type ConnectFrame = {
  flags: number;
  message: Buffer;
};

type OpenAIChatResponse = {
  choices?: Array<{
    message?: {
      content?: unknown;
    };
  }>;
};

type OpenAIStreamChunk = {
  choices?: Array<{
    delta?: {
      content?: unknown;
    };
    message?: {
      content?: unknown;
    };
    text?: unknown;
  }>;
};

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(__dirname, "..");
const REPO_ROOT = resolve(ROOT, "..");

function loadDotEnv(path: string): void {
  if (!existsSync(path)) return;

  const text = readFileSync(path, "utf8");
  for (const rawLine of text.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith("#")) continue;

    const eq = line.indexOf("=");
    if (eq <= 0) continue;

    const key = line.slice(0, eq).trim();
    let value = line.slice(eq + 1).trim();
    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1);
    }

    if (!process.env[key]) process.env[key] = value;
  }
}

loadDotEnv(resolve(ROOT, ".env"));
loadDotEnv(resolve(REPO_ROOT, "proxy", ".env"));

function env(name: string, fallback = ""): string {
  const value = process.env[name];
  return value && value.trim() ? value.trim() : fallback;
}

function envNumber(name: string, fallback: number): number {
  const value = Number(env(name));
  return Number.isFinite(value) && value > 0 ? value : fallback;
}

function normalizeBaseUrl(value: string): string {
  return value.replace(/\/+$/, "") || "https://api.openai.com";
}

const config = {
  apiHost: env("CURSOR_PROXY_HOST", "127.0.0.1"),
  apiPort: envNumber("CURSOR_PROXY_PORT", 8777),
  agentHost: env("CURSOR_AGENT_HOST", "127.0.0.1"),
  agentPort: envNumber("CURSOR_AGENT_PORT", 8778),
  openaiBaseUrl: normalizeBaseUrl(
    env("OPENAI_BASE_URL", "https://api.openai.com/v1"),
  ),
  openaiApiKey: env("OPENAI_API_KEY"),
  openaiModel: env("OPENAI_MODEL", "gpt-4o-mini"),
  openaiUserAgent: env("OPENAI_USER_AGENT", "cursorproxy"),
  logLevel: env("CURSORPROXY_LOG_LEVEL", "info").toLowerCase() as LogLevel,
};

if (!config.openaiApiKey) {
  throw new Error(
    "OPENAI_API_KEY is required. Put it in cursorproxy/.env or proxy/.env.",
  );
}

function log(
  level: LogLevel,
  message: string,
  data?: Record<string, unknown>,
): void {
  const order: Record<LogLevel, number> = {
    debug: 10,
    info: 20,
    warn: 30,
    error: 40,
  };
  if ((order[level] ?? 20) < (order[config.logLevel] ?? 20)) return;

  const suffix = data === undefined ? "" : ` ${JSON.stringify(data)}`;
  console.error(
    `[${new Date().toISOString()}] ${level.toUpperCase()} ${message}${suffix}`,
  );
}

function base64UrlJson(value: Record<string, unknown>): string {
  return Buffer.from(JSON.stringify(value)).toString("base64url");
}

function fakeJwt(): string {
  const now = Math.floor(Date.now() / 1000);
  return [
    base64UrlJson({ alg: "none", typ: "JWT" }),
    base64UrlJson({
      sub: "cursorproxy-local-user",
      email: "proxy@example.local",
      exp: now + 24 * 60 * 60,
      iat: now,
    }),
    "sig",
  ].join(".");
}

function jsonResponse(
  res: http.ServerResponse,
  status: number,
  body: Record<string, unknown>,
): void {
  const bytes = Buffer.from(JSON.stringify(body));
  res.writeHead(status, {
    "content-type": "application/json",
    "content-length": bytes.length,
  });
  res.end(bytes);
}

function protoResponse(
  res: http.ServerResponse,
  body: Buffer = Buffer.alloc(0),
): void {
  res.writeHead(200, {
    "content-type": "application/proto",
    "content-length": body.length,
  });
  res.end(body);
}

function readRequestBody(req: http.IncomingMessage): Promise<Buffer> {
  return new Promise((resolveBody, reject) => {
    const chunks: Buffer[] = [];
    req.on("data", (chunk: Buffer | string) => {
      chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
    });
    req.on("end", () => resolveBody(Buffer.concat(chunks)));
    req.on("error", reject);
  });
}

function encodeVarint(value: number | bigint): Buffer {
  let n = BigInt(value);
  const out: number[] = [];
  while (n >= 0x80n) {
    out.push(Number((n & 0x7fn) | 0x80n));
    n >>= 7n;
  }
  out.push(Number(n));
  return Buffer.from(out);
}

function fieldTag(fieldNumber: number, wireType: number): Buffer {
  return encodeVarint((BigInt(fieldNumber) << 3n) | BigInt(wireType));
}

function fieldString(fieldNumber: number, value: string): Buffer {
  const bytes = Buffer.from(value, "utf8");
  return Buffer.concat([
    fieldTag(fieldNumber, 2),
    encodeVarint(bytes.length),
    bytes,
  ]);
}

function fieldBytes(fieldNumber: number, bytes: Buffer): Buffer {
  return Buffer.concat([
    fieldTag(fieldNumber, 2),
    encodeVarint(bytes.length),
    bytes,
  ]);
}

function fieldMessage(fieldNumber: number, message: Buffer): Buffer {
  return fieldBytes(fieldNumber, message);
}

function modelDetails(): Buffer {
  return Buffer.concat([
    fieldString(1, config.openaiModel),
    fieldString(3, config.openaiModel),
    fieldString(4, config.openaiModel),
    fieldString(5, config.openaiModel),
    fieldString(6, "auto"),
  ]);
}

function usableModelsResponse(): Buffer {
  return fieldMessage(1, modelDetails());
}

function defaultModelResponse(): Buffer {
  return fieldMessage(1, modelDetails());
}

function frameConnect(message: Buffer, flags = 0): Buffer {
  const header = Buffer.alloc(5);
  header[0] = flags;
  header.writeUInt32BE(message.length, 1);
  return Buffer.concat([header, message]);
}

function readVarint(buffer: Buffer, offset: number): [number, number] {
  let result = 0n;
  let shift = 0n;
  let index = offset;
  while (index < buffer.length) {
    const byte = buffer[index++];
    result |= BigInt(byte & 0x7f) << shift;
    if ((byte & 0x80) === 0) return [Number(result), index];
    shift += 7n;
  }
  throw new Error("truncated varint");
}

function decodeProtoFields(buffer: Buffer): ProtoField[] {
  const fields: ProtoField[] = [];
  let offset = 0;
  while (offset < buffer.length) {
    const [tag, next] = readVarint(buffer, offset);
    offset = next;
    const no = tag >> 3;
    const wire = tag & 7;

    if (wire === 0) {
      const [value, after] = readVarint(buffer, offset);
      fields.push({ no, wire, value });
      offset = after;
    } else if (wire === 1) {
      fields.push({ no, wire, value: buffer.subarray(offset, offset + 8) });
      offset += 8;
    } else if (wire === 2) {
      const [length, afterLength] = readVarint(buffer, offset);
      offset = afterLength;
      fields.push({
        no,
        wire,
        value: buffer.subarray(offset, offset + length),
      });
      offset += length;
    } else if (wire === 5) {
      fields.push({ no, wire, value: buffer.subarray(offset, offset + 4) });
      offset += 4;
    } else {
      throw new Error(`unsupported wire type ${wire}`);
    }
  }
  return fields;
}

function stringFromBytes(bytes: Buffer): string {
  try {
    const text = Buffer.from(bytes).toString("utf8");
    return /[\u0000-\u0008\u000e-\u001f]/.test(text) ? "" : text;
  } catch {
    return "";
  }
}

function nestedMessage(buffer: Buffer, path: number[]): Buffer | undefined {
  let current = buffer;
  for (const no of path) {
    const field = decodeProtoFields(current).find((
      item,
    ): item is ProtoBytesField => item.no === no && item.wire === 2);
    if (!field) return undefined;
    current = field.value;
  }
  return current;
}

function extractPromptFromAgentClientMessage(message: Buffer): string {
  const runRequest = nestedMessage(message, [1]);
  if (!runRequest) return "";

  const direct = nestedMessage(runRequest, [2, 1, 1]);
  if (direct) {
    const userFields = decodeProtoFields(direct);
    const textField = userFields.find((item): item is ProtoBytesField =>
      item.no === 1 && item.wire === 2
    );
    if (textField) {
      const text = stringFromBytes(textField.value).trim();
      if (text) return text;
    }

    const richTextField = userFields.find((item): item is ProtoBytesField =>
      item.no === 8 && item.wire === 2
    );
    if (richTextField) {
      const text = stringFromBytes(richTextField.value).trim();
      if (text) return text;
    }
  }

  const candidates: string[] = [];
  collectUtf8Strings(runRequest, candidates, 0);
  return candidates
    .map((value) => value.trim())
    .filter((value) => value.length > 0)
    .sort((a, b) => b.length - a.length)[0] ?? "";
}

function collectUtf8Strings(
  buffer: Buffer,
  output: string[],
  depth: number,
): void {
  if (depth > 8) return;

  let fields: ProtoField[] = [];
  try {
    fields = decodeProtoFields(buffer);
  } catch {
    return;
  }

  for (const field of fields) {
    if (field.wire !== 2) continue;

    const text = stringFromBytes(field.value);
    if (text && /[A-Za-z0-9\u4e00-\u9fff]/.test(text)) output.push(text);
    collectUtf8Strings(field.value, output, depth + 1);
  }
}

function parseConnectFrames(buffer: Buffer): ConnectFrame[] {
  const frames: ConnectFrame[] = [];
  let offset = 0;
  while (offset + 5 <= buffer.length) {
    const flags = buffer[offset];
    const length = buffer.readUInt32BE(offset + 1);
    offset += 5;
    if (offset + length > buffer.length) break;
    frames.push({ flags, message: buffer.subarray(offset, offset + length) });
    offset += length;
  }
  return frames;
}

function agentTextDelta(text: string): Buffer {
  const textDeltaUpdate = fieldString(1, text);
  const interactionUpdate = fieldMessage(1, textDeltaUpdate);
  return fieldMessage(1, interactionUpdate);
}

function agentTurnEnded(): Buffer {
  const interactionUpdate = fieldMessage(14, Buffer.alloc(0));
  return fieldMessage(1, interactionUpdate);
}

async function handleAgentRunBody(
  body: Buffer,
  writeFrame: (frame: Buffer) => void,
  isClosed: () => boolean,
): Promise<void> {
  const frames = parseConnectFrames(body);
  const prompt = frames
    .map((frame) => extractPromptFromAgentClientMessage(frame.message))
    .find(Boolean) ?? "";
  log("info", "agent prompt", { chars: prompt.length });

  let wroteDelta = false;
  const answer = await streamOpenAI(
    prompt,
    (delta) => {
      if (isClosed() || !delta) return;
      wroteDelta = true;
      writeFrame(frameConnect(agentTextDelta(delta)));
    },
    AbortSignal.timeout(120_000),
  );

  if (isClosed()) {
    log("warn", "agent stream closed before upstream finished");
    return;
  }

  if (!wroteDelta) {
    writeFrame(frameConnect(agentTextDelta(answer)));
  }
  writeFrame(frameConnect(agentTurnEnded()));
}

function extractOpenAIContent(chunk: OpenAIStreamChunk): string {
  const choice = chunk.choices?.[0];
  const content = choice?.delta?.content ?? choice?.message?.content ??
    choice?.text;
  return typeof content === "string" ? content : "";
}

async function streamOpenAI(
  prompt: string,
  onDelta: (delta: string) => void,
  signal: AbortSignal,
): Promise<string> {
  const response = await fetch(`${config.openaiBaseUrl}/chat/completions`, {
    method: "POST",
    signal,
    headers: {
      "content-type": "application/json",
      "authorization": `Bearer ${config.openaiApiKey}`,
      "user-agent": config.openaiUserAgent,
    },
    body: JSON.stringify({
      model: config.openaiModel,
      messages: [
        {
          role: "system",
          content:
            "You are Cursor Agent running through a local compatibility proxy. Answer directly and concisely unless the user asks for detail.",
        },
        { role: "user", content: prompt || "Continue." },
      ],
      stream: true,
    }),
  });

  if (!response.ok) {
    const text = await response.text().catch(() => "");
    throw new Error(
      `OpenAI upstream ${response.status}: ${text.slice(0, 500)}`,
    );
  }

  const contentType = response.headers.get("content-type") ?? "";
  if (!contentType.includes("text/event-stream")) {
    const body = await response.json() as OpenAIChatResponse;
    const content = body?.choices?.[0]?.message?.content;
    const text = typeof content === "string" && content.trim()
      ? content
      : "(empty response)";
    onDelta(text);
    return text;
  }

  if (!response.body) {
    onDelta("(empty response)");
    return "(empty response)";
  }

  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  let fullText = "";

  const handleLine = (line: string): boolean => {
    const trimmed = line.trimEnd();
    if (!trimmed.startsWith("data:")) return false;

    const data = trimmed.slice("data:".length).trim();
    if (!data) return false;
    if (data === "[DONE]") return true;

    try {
      const chunk = JSON.parse(data) as OpenAIStreamChunk;
      const delta = extractOpenAIContent(chunk);
      if (delta) {
        fullText += delta;
        onDelta(delta);
      }
    } catch {
      log("debug", "ignored non-json stream chunk", {
        data: data.slice(0, 120),
      });
    }
    return false;
  };

  while (true) {
    const { value, done } = await reader.read();
    if (value) {
      buffer += decoder.decode(value, { stream: !done });
    }

    let newline = buffer.indexOf("\n");
    while (newline >= 0) {
      const line = buffer.slice(0, newline);
      buffer = buffer.slice(newline + 1);
      if (handleLine(line)) return fullText || "(empty response)";
      newline = buffer.indexOf("\n");
    }

    if (done) break;
  }

  if (buffer && handleLine(buffer)) return fullText || "(empty response)";
  return fullText || "(empty response)";
}

async function handleApiRequest(
  req: http.IncomingMessage,
  res: http.ServerResponse,
): Promise<void> {
  const url = new URL(
    req.url ?? "/",
    `http://${req.headers.host ?? "localhost"}`,
  );
  const body = await readRequestBody(req);
  log("debug", "api request", {
    method: req.method,
    path: url.pathname,
    bytes: body.length,
  });

  if (
    req.method === "GET" &&
    (url.pathname === "/health" || url.pathname === "/ping")
  ) {
    jsonResponse(res, 200, { ok: true });
    return;
  }

  if (req.method !== "POST") {
    jsonResponse(res, 404, { error: "not_found", path: url.pathname });
    return;
  }

  if (url.pathname === "/auth/exchange_user_api_key") {
    jsonResponse(res, 200, {
      accessToken: fakeJwt(),
      refreshToken: "cursorproxy-refresh-token",
    });
    return;
  }

  if (
    url.pathname.endsWith("/TrackEvents") ||
    url.pathname.endsWith("/Batch") ||
    url.pathname.endsWith("/SubmitLogs")
  ) {
    jsonResponse(res, 200, { ok: true });
    return;
  }

  if (url.pathname.endsWith("/BootstrapStatsig")) {
    jsonResponse(res, 200, { config: {} });
    return;
  }

  if (url.pathname.endsWith("/GetUsableModels")) {
    protoResponse(res, usableModelsResponse());
    return;
  }

  if (url.pathname.endsWith("/GetDefaultModelForCli")) {
    protoResponse(res, defaultModelResponse());
    return;
  }

  if (
    url.pathname.endsWith("/Run") ||
    url.pathname.endsWith("/RunSSE")
  ) {
    let clientGone = false;
    req.on("aborted", () => {
      clientGone = true;
    });
    res.on("error", () => {
      clientGone = true;
    });

    res.writeHead(200, {
      "content-type": "application/connect+proto",
      "connect-protocol-version": "1",
    });

    try {
      await handleAgentRunBody(
        body,
        (frame) => {
          if (clientGone || res.destroyed) return;
          try {
            res.write(frame);
          } catch {
            clientGone = true;
          }
        },
        () => clientGone || res.destroyed,
      );
    } finally {
      if (!clientGone && !res.destroyed && !res.writableEnded) {
        res.end();
      }
    }
    return;
  }

  if (
    url.pathname.startsWith("/aiserver.v1.") ||
    url.pathname.startsWith("/agent.v1.")
  ) {
    protoResponse(res);
    return;
  }

  jsonResponse(res, 404, { error: "not_found", path: url.pathname });
}

function startApiServer(): void {
  const server = http.createServer((req, res) => {
    handleApiRequest(req, res).catch((error: unknown) => {
      const message = error instanceof Error ? error.message : String(error);
      log("error", "api error", { error: message });
      jsonResponse(res, 500, { error: "cursorproxy_error", message });
    });
  });

  server.listen(config.apiPort, config.apiHost, () => {
    console.log(
      `Cursor proxy API listening on http://${config.apiHost}:${config.apiPort}`,
    );
  });
}

function startAgentServer(): void {
  const server = http2.createServer();
  server.on("stream", (stream, headers) => {
    const path = String(headers[":path"] ?? "/");
    const chunks: Buffer[] = [];
    let clientGone = false;
    let responded = false;

    stream.on("aborted", () => {
      clientGone = true;
    });
    stream.on("error", () => {
      clientGone = true;
    });
    stream.on("data", (chunk: Buffer | string) => {
      chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
    });
    stream.on("end", async () => {
      const body = Buffer.concat(chunks);
      log("debug", "agent request", {
        path,
        bytes: body.length,
        contentType: headers["content-type"],
      });

      try {
        const respondConnect = (): void => {
          if (responded || clientGone || stream.destroyed) return;
          stream.respond({
            ":status": 200,
            "content-type": "application/connect+proto",
            "connect-protocol-version": "1",
          });
          responded = true;
        };

        if (path.endsWith("/Run") || path.endsWith("/RunSSE")) {
          respondConnect();
          await handleAgentRunBody(
            body,
            (frame) => {
              if (clientGone || stream.destroyed) return;
              try {
                stream.write(frame);
              } catch {
                clientGone = true;
              }
            },
            () => clientGone || stream.destroyed,
          );
          if (!clientGone && !stream.destroyed) stream.end();
          return;
        }

        if (clientGone || stream.destroyed) return;
        stream.respond({
          ":status": 200,
          "content-type": "application/proto",
          "content-length": "0",
        });
        stream.end(Buffer.alloc(0));
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        log("error", "agent error", { error: message });
        if (clientGone || stream.destroyed) return;

        if (!responded) {
          stream.respond({
            ":status": 200,
            "content-type": "application/connect+proto",
            "connect-protocol-version": "1",
          });
          responded = true;
        }
        stream.end(Buffer.concat([
          frameConnect(agentTextDelta(`cursorproxy error: ${message}`)),
          frameConnect(agentTurnEnded()),
        ]));
      }
    });
  });

  server.listen(config.agentPort, config.agentHost, () => {
    console.log(
      `Cursor proxy AgentService listening on h2c http://${config.agentHost}:${config.agentPort}`,
    );
  });
}

console.log(`OpenAI upstream: ${config.openaiBaseUrl}`);
console.log(`OpenAI model: ${config.openaiModel}`);
startApiServer();
startAgentServer();
