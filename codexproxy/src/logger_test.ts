import { assertEquals } from "jsr:@std/assert";

import { appendEventLog, appendRuntimeLog, createRequestLogContext, retainRecentMessages } from "./logger.ts";
import type { CodexProxyConfig, JsonObject, RetainedMessageRecord } from "./types.ts";

function makeConfig(logDir: string): CodexProxyConfig {
  return {
    port: 8878,
    codexUpstream: {
      url: "https://example-codex.com/v1/responses",
      apiKey: "sk-codex",
    },
    enableCompactModel: true,
    liteUpstream: {
      url: "https://example-lite.com/v1/responses",
      apiKey: "sk-lite",
    },
    liteModel: "gpt-lite",
    autoModels: {
      defaultModel: "gpt-default",
      codeModel: "gpt-code",
      planModel: "gpt-plan",
      docModel: "gpt-doc",
    },
    proxyApiKey: "sk-proxy",
    codexRoot: "/tmp/codex",
    logDir,
    heartbeatMs: 5000,
    requestTimeoutMs: 1000,
    localPruneMinTokens: 180000,
    keepRecentUserMessages: 6,
    keepRecentItems: 80,
    keepRecentFunctionCallPairs: 2,
    keepRecentReasoningItems: 2,
    keepFunctionCallName: false,
    oldToolOutputPreviewChars: 480,
    oldFunctionArgumentsPreviewChars: 240,
    dropOldReasoning: true,
  };
}

function message(role: string, text: string): JsonObject {
  return {
    type: "message",
    role,
    content: [{ type: "input_text", text }],
  };
}

Deno.test({
  name: "retainRecentMessages keeps only the last 1000 messages",
  permissions: {
    read: true,
    write: true,
  },
  async fn() {
    const logDir = await Deno.makeTempDir();
    const config = makeConfig(logDir);

    for (let index = 0; index < 1005; index += 1) {
      await retainRecentMessages(config, `req_${index}`, "final_input", [
        message("user", `message_${index}`),
      ]);
    }

    const text = await Deno.readTextFile(`${logDir}/recent-messages.json`);
    const parsed = JSON.parse(text) as RetainedMessageRecord[];

    assertEquals(parsed.length, 1000);
    assertEquals(parsed[0].requestId, "req_5");
    assertEquals(parsed[999].requestId, "req_1004");
  },
});

Deno.test({
  name: "appendRuntimeLog keeps only the last 1000 lines",
  permissions: {
    read: true,
    write: true,
  },
  async fn() {
    const logDir = await Deno.makeTempDir();
    const config = makeConfig(logDir);

    for (let index = 0; index < 1005; index += 1) {
      await appendRuntimeLog(config, "INFO", `line_${index}`);
    }

    const text = await Deno.readTextFile(`${logDir}/server.log`);
    const lines = text.split(/\r?\n/).filter(Boolean);
    assertEquals(lines.length, 1000);
    assertEquals(lines[0].includes("line_5"), true);
    assertEquals(lines[999].includes("line_1004"), true);
  },
});

Deno.test({
  name: "appendEventLog keeps only the last 1000 lines",
  permissions: {
    read: true,
    write: true,
  },
  async fn() {
    const logDir = await Deno.makeTempDir();
    const config = makeConfig(logDir);

    for (let index = 0; index < 1005; index += 1) {
      await appendEventLog(config, { requestId: `req_${index}`, stage: "test", n: index });
    }

    const text = await Deno.readTextFile(`${logDir}/events.jsonl`);
    const lines = text.split(/\r?\n/).filter(Boolean);
    assertEquals(lines.length, 1000);
    assertEquals(lines[0].includes("\"req_5\""), true);
    assertEquals(lines[999].includes("\"req_1004\""), true);
  },
});

Deno.test({
  name: "createRequestLogContext keeps only the last 1000 request directories",
  permissions: {
    read: true,
    write: true,
  },
  async fn() {
    const logDir = await Deno.makeTempDir();
    const config = makeConfig(logDir);

    for (let index = 0; index < 1005; index += 1) {
      await createRequestLogContext(config, `req_${String(index).padStart(4, "0")}`);
    }

    const names: string[] = [];
    for await (const entry of Deno.readDir(logDir)) {
      if (entry.isDirectory) names.push(entry.name);
    }
    names.sort();
    assertEquals(names.length, 1000);
    assertEquals(names[0], "req_0005");
    assertEquals(names[999], "req_1004");
  },
});
