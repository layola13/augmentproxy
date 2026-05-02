import {
  assertEquals,
  assertStringIncludes,
} from "jsr:@std/assert";

import {
  buildRemoteCompactPayload,
  buildSummaryMessage,
  optimizeRequestInput,
} from "./history-pruning.ts";
import {
  chooseAutoModel,
  extractResponseText,
  resolveReturnedContentType,
  resolveRequestedModel,
  rewriteCodexInstructions,
} from "./server.ts";
import { buildContextTokenPayload, countContextTokens, extractMessageItems } from "./token-metrics.ts";
import type { AutoModelConfig, CodexPromptAssets, JsonObject } from "./types.ts";

function message(role: string, text: string): JsonObject {
  return {
    type: "message",
    role,
    content: [{ type: "input_text", text }],
  };
}

const AUTO_MODELS: AutoModelConfig = {
  defaultModel: "gpt-default",
  codeModel: "gpt-code",
  planModel: "gpt-plan",
  docModel: "gpt-doc",
};

Deno.test("rewriteCodexInstructions swaps matched gpt-5.5 prefix and preserves tail", () => {
  const assets: CodexPromptAssets = {
    codexRoot: "/tmp/codex",
    fullVariants: {
      default: "FULL_DEFAULT",
      pragmatic: "FULL_PRAGMATIC",
      friendly: "FULL_FRIENDLY",
    },
    compactVariants: {
      default: "COMPACT_DEFAULT",
      pragmatic: "COMPACT_PRAGMATIC",
      friendly: "COMPACT_FRIENDLY",
    },
    compactPrompt: "COMPACT_PROMPT",
    summaryPrefix: "SUMMARY_PREFIX",
  };

  const rewritten = rewriteCodexInstructions(
    "FULL_PRAGMATIC\n\nAdditional instructions",
    assets,
  );

  assertEquals(rewritten.matched, true);
  assertEquals(rewritten.variant, "pragmatic");
  assertEquals(
    rewritten.instructions,
    "COMPACT_PRAGMATIC\n\nAdditional instructions",
  );
});

Deno.test("optimizeRequestInput preserves tool history structure and excludes user text from remote compact", () => {
  const longCode = Array.from({ length: 30 }, (_, index) => `line_${index + 1}`).join("\n");
  const input = [
    message("user", `Requirement A must stay literal.\n\`\`\`ts\n${longCode}\n\`\`\``),
    message("assistant", "older reply"),
    {
      type: "reasoning",
      encrypted_content: "old reasoning 1",
    },
    {
      type: "function_call",
      call_id: "call_1",
      name: "shell",
      arguments: "{\"cmd\":\"ls -la\"}",
    },
    {
      type: "function_call_output",
      call_id: "call_1",
      output: "same output 1",
    },
    {
      type: "reasoning",
      encrypted_content: "old reasoning 2",
    },
    {
      type: "function_call",
      call_id: "call_2",
      name: "shell",
      arguments: "{\"cmd\":\"ls -la\"}",
    },
    {
      type: "function_call_output",
      call_id: "call_2",
      output: "same output 2",
    },
    {
      type: "reasoning",
      encrypted_content: "keep reasoning 1",
    },
    {
      type: "function_call",
      call_id: "call_3",
      name: "shell",
      arguments: "{\"cmd\":\"pwd\"}",
    },
    {
      type: "function_call_output",
      call_id: "call_3",
      output: "same output 3",
    },
    {
      type: "reasoning",
      encrypted_content: "keep reasoning 2",
    },
    message("assistant", "recent assistant reply"),
    message("user", "recent user input"),
  ];

  const optimized = optimizeRequestInput(input, {
    keepRecentUserMessages: 1,
    keepRecentItems: 2,
    keepRecentFunctionCallPairs: 2,
    keepRecentReasoningItems: 2,
    keepFunctionCallName: false,
    oldToolOutputPreviewChars: 40,
    oldFunctionArgumentsPreviewChars: 20,
    dropOldReasoning: true,
  });

  assertEquals(optimized.stats.dedupedFunctionCallCount, 0);
  assertEquals(optimized.stats.dedupedFunctionCallOutputCount, 0);
  assertEquals(optimized.stats.droppedFunctionCallCount, 1);
  assertEquals(optimized.stats.droppedFunctionCallOutputCount, 1);
  assertEquals(optimized.stats.droppedReasoningCount, 2);
  assertEquals(optimized.stats.compactedPinnedUserCodeBlockCount, 1);
  assertEquals(optimized.localInput.length, 10);

  const firstUser = optimized.localInput[0] as JsonObject;
  const firstText = ((firstUser.content as JsonObject[])[0].text ?? "") as string;
  assertStringIncludes(firstText, "Requirement A must stay literal.");
  assertStringIncludes(firstText, "[codexproxy compressed code block;");

  const callIds = optimized.localInput
    .filter((item) => (item as JsonObject).type === "function_call")
    .map((item) => (item as JsonObject).call_id);
  assertEquals(callIds, ["call_2", "call_3"]);

  const remotePayload = buildRemoteCompactPayload(optimized.prefixSegments);
  assertStringIncludes(remotePayload.pinnedContext, "Requirement A must stay literal.");
  assertStringIncludes(remotePayload.pinnedContext, "TOOL CALL shell:");
  assertEquals(remotePayload.compressibleHistory.includes("TOOL CALL shell:"), false);
  assertEquals(remotePayload.compressibleHistory.includes("Requirement A must stay literal."), false);

  const summaryMessage = buildSummaryMessage("SUMMARY_PREFIX", "summary text");
  assertEquals((summaryMessage.content as JsonObject[])[0].text, "SUMMARY_PREFIX\nsummary text");
});

Deno.test("optimizeRequestInput can keep summarized old function call names", () => {
  const input = [
    message("user", "Requirement A"),
    {
      type: "function_call",
      call_id: "call_1",
      namespace: "unrealmcp",
      name: "importbpy",
      arguments: "{\"asset_path\":\"/Game/A\",\"target\":\"/Game/B\",\"options\":{\"overwrite\":true}}",
    },
    {
      type: "function_call_output",
      call_id: "call_1",
      output: "old output 1",
    },
    {
      type: "function_call",
      call_id: "call_2",
      name: "exec_command",
      arguments: "{\"cmd\":\"rg foo\",\"timeout\":1000}",
    },
    {
      type: "function_call_output",
      call_id: "call_2",
      output: "old output 2",
    },
    {
      type: "function_call",
      call_id: "call_3",
      name: "exec_command",
      arguments: "{\"cmd\":\"pwd\"}",
    },
    {
      type: "function_call_output",
      call_id: "call_3",
      output: "latest output",
    },
    message("user", "recent user input"),
  ];

  const optimized = optimizeRequestInput(input, {
    keepRecentUserMessages: 1,
    keepRecentItems: 2,
    keepRecentFunctionCallPairs: 1,
    keepRecentReasoningItems: 2,
    keepFunctionCallName: true,
    oldToolOutputPreviewChars: 40,
    oldFunctionArgumentsPreviewChars: 20,
    dropOldReasoning: true,
  });

  const summary = optimized.localInput.find((item) =>
    (item as JsonObject).type === "message" &&
    (item as JsonObject).role === "assistant" &&
    JSON.stringify(item).includes("historical function calls summary")
  ) as JsonObject | undefined;

  assertEquals(Boolean(summary), true);
  assertEquals(summary?.phase, "commentary");
  const summaryText = ((summary?.content as JsonObject[])[0].text ?? "") as string;
  assertStringIncludes(summaryText, "unrealmcp.importbpy(asset_path, target, options)");
  assertStringIncludes(summaryText, "exec_command(cmd, timeout)");
  assertEquals(((summary?.content as JsonObject[])[0].type ?? ""), "output_text");
});

Deno.test("extractResponseText reads both standard output_text and compaction output", () => {
  assertEquals(
    extractResponseText({
      output_text: "plain text",
    }),
    "plain text",
  );

  assertEquals(
    extractResponseText({
      output: [{
        type: "compaction",
        encrypted_content: "summary from compaction",
      }],
    }),
    "summary from compaction",
  );
});

Deno.test("chooseAutoModel prefers doc then code then plan then default", () => {
  assertEquals(
    chooseAutoModel(
      { input: [message("user", "Read the SDK docs and README for this API")] },
      AUTO_MODELS,
    ),
    { model: "gpt-doc", reason: "doc_signal" },
  );

  assertEquals(
    chooseAutoModel(
      { input: [message("user", "Fix src/server.ts compile error and patch the code")] },
      AUTO_MODELS,
    ),
    { model: "gpt-code", reason: "code_signal" },
  );

  assertEquals(
    chooseAutoModel(
      { input: [message("user", "Give me an architecture plan for this feature")] },
      AUTO_MODELS,
    ),
    { model: "gpt-plan", reason: "plan_signal" },
  );

  assertEquals(
    chooseAutoModel(
      { input: [message("user", "Hello there")] },
      AUTO_MODELS,
    ),
    { model: "gpt-default", reason: "default" },
  );
});

Deno.test("resolveRequestedModel keeps explicit model and routes auto", () => {
  assertEquals(
    resolveRequestedModel(
      { model: "gpt-5.5", input: [message("user", "anything")] },
      AUTO_MODELS,
    ),
    { model: "gpt-5.5", source: "client", reason: "client_model" },
  );

  assertEquals(
    resolveRequestedModel(
      { model: "auto", input: [message("user", "Open the docs for this SDK")] },
      AUTO_MODELS,
    ),
    { model: "gpt-doc", source: "auto", reason: "doc_signal" },
  );
});

Deno.test("countContextTokens drops after context pruning", () => {
  const before = {
    instructions: "FULL INSTRUCTIONS",
    input: [
      message("user", "very long request " + "a".repeat(400)),
      message("assistant", "older reply " + "b".repeat(400)),
      {
        type: "function_call_output",
        output: "tool output " + "c".repeat(400),
      },
    ],
    tools: [{ type: "function", name: "shell" }],
  } satisfies JsonObject;

  const after = {
    ...before,
    input: [message("user", "very long request " + "a".repeat(120))],
  } satisfies JsonObject;

  const beforeTokens = countContextTokens(buildContextTokenPayload(before));
  const afterTokens = countContextTokens(buildContextTokenPayload(after));

  assertEquals(beforeTokens > afterTokens, true);
});

Deno.test("extractMessageItems keeps only message items", () => {
  const items = extractMessageItems([
    message("user", "one"),
    { type: "function_call", name: "shell", arguments: "{}" },
    message("assistant", "two"),
  ]);

  assertEquals(items.length, 2);
  assertEquals((items[0] as JsonObject).role, "user");
  assertEquals((items[1] as JsonObject).role, "assistant");
});

Deno.test("resolveReturnedContentType normalizes fake event-stream error body to json", () => {
  const headers = new Headers({
    "content-type": "text/event-stream",
  });

  assertEquals(
    resolveReturnedContentType(
      headers,
      '{"error":{"message":"模型 gpt-5.4 当前不可用","code":"get_channel_failed"}}',
    ),
    "application/json; charset=utf-8",
  );
});

Deno.test("resolveReturnedContentType preserves real sse body", () => {
  const headers = new Headers({
    "content-type": "text/event-stream",
  });

  assertEquals(
    resolveReturnedContentType(
      headers,
      'event: response.created\ndata: {"type":"response.created"}\n\n',
    ),
    "text/event-stream; charset=utf-8",
  );
});
