import { assertEquals, assertStringIncludes } from "jsr:@std/assert";

import {
  applyRemoteCompactSummary,
  buildRemoteCompactPayload,
  buildSummaryMessage,
  optimizeRequestInput,
} from "./history-pruning.ts";
import {
  buildContinuationGuardInstruction,
  chooseAutoModel,
  compactEndpointUrl,
  extractResponseText,
  isCompactEndpointPath,
  isContinuationRequestText,
  resolveRequestedModel,
  resolveReturnedContentType,
  rewriteCodexInstructions,
  sanitizeStalledContinuationHistory,
  shouldCompressContext,
  shouldRetryContinuationTurn,
} from "./server.ts";
import {
  buildContextTokenPayload,
  countContextTokens,
  extractMessageItems,
} from "./token-metrics.ts";
import type {
  AutoModelConfig,
  CodexPromptAssets,
  JsonObject,
  UpstreamTurn,
} from "./types.ts";

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

Deno.test("compact endpoint helpers follow Codex /compact routing", () => {
  assertEquals(isCompactEndpointPath("/v1/responses/compact"), true);
  assertEquals(isCompactEndpointPath("/responses/compact"), true);
  assertEquals(isCompactEndpointPath("/v1/responses"), false);
  assertEquals(
    compactEndpointUrl("https://example.com/v1/responses"),
    "https://example.com/v1/responses/compact",
  );
});

Deno.test("optimizeRequestInput only drops old tool history and leaves other items untouched", () => {
  const longCode = Array.from({ length: 30 }, (_, index) => `line_${index + 1}`)
    .join("\n");
  const input = [
    message(
      "user",
      `Requirement A must stay literal.\n\`\`\`ts\n${longCode}\n\`\`\``,
    ),
    message("assistant", "older reply"),
    {
      type: "reasoning",
      encrypted_content: "old reasoning 1",
    },
    {
      type: "function_call",
      call_id: "call_1",
      name: "shell",
      arguments: '{"cmd":"ls -la"}',
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
      arguments: '{"cmd":"ls -la"}',
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
      arguments: '{"cmd":"pwd"}',
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

  assertEquals(optimized.stats.droppedFunctionCallCount, 1);
  assertEquals(optimized.stats.droppedFunctionCallOutputCount, 1);
  assertEquals(optimized.stats.droppedReasoningCount, 0);
  assertEquals(optimized.stats.compactedPinnedUserCodeBlockCount, 0);
  assertEquals(optimized.localInput.length, 12);

  const firstUser = optimized.localInput[0] as JsonObject;
  const firstText =
    ((firstUser.content as JsonObject[])[0].text ?? "") as string;
  assertEquals(
    firstText,
    `Requirement A must stay literal.\n\`\`\`ts\n${longCode}\n\`\`\``,
  );

  const callIds = optimized.localInput
    .filter((item) => (item as JsonObject).type === "function_call")
    .map((item) => (item as JsonObject).call_id);
  assertEquals(callIds, ["call_2", "call_3"]);
  assertEquals(
    optimized.localInput.some((item) =>
      (item as JsonObject).type === "reasoning" &&
      (item as JsonObject).encrypted_content === "old reasoning 1"
    ),
    true,
  );

  const remotePayload = buildRemoteCompactPayload(optimized.prefixSegments);
  assertEquals(remotePayload.pinnedContext, "");
  assertStringIncludes(
    remotePayload.compressibleHistory,
    "TOOL CALL shell:",
  );
  assertEquals(
    remotePayload.compressibleHistory.includes(
      "Requirement A must stay literal.",
    ),
    false,
  );
  assertEquals(
    remotePayload.compressibleHistory.includes("old reasoning 1"),
    false,
  );

  const summaryMessage = buildSummaryMessage("SUMMARY_PREFIX", "summary text");
  assertEquals(
    (summaryMessage.content as JsonObject[])[0].text,
    "SUMMARY_PREFIX\nsummary text",
  );
});

Deno.test("optimizeRequestInput can keep summarized old function call names", () => {
  const input = [
    message("user", "Requirement A"),
    {
      type: "function_call",
      call_id: "call_1",
      namespace: "unrealmcp",
      name: "importbpy",
      arguments:
        '{"asset_path":"/Game/A","target":"/Game/B","options":{"overwrite":true}}',
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
      arguments: '{"cmd":"rg foo","timeout":1000}',
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
      arguments: '{"cmd":"pwd"}',
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
  const summaryText =
    ((summary?.content as JsonObject[])[0].text ?? "") as string;
  assertStringIncludes(
    summaryText,
    "unrealmcp.importbpy(asset_path, target, options)",
  );
  assertStringIncludes(summaryText, "exec_command(cmd, timeout)");
  assertEquals((summary?.content as JsonObject[])[0].type ?? "", "output_text");
});

Deno.test("optimizeRequestInput never compresses update_plan history", () => {
  const updatePlanArguments =
    '{"explanation":"keep finished todo history","plan":[{"step":"Inspect logs","status":"completed"},{"step":"Patch proxy compression","status":"completed"},{"step":"Verify upstream request","status":"in_progress"}]}';
  const updatePlanOutput =
    "plan updated successfully with completed todo items preserved for downstream continuation";
  const input = [
    message("user", "Initial requirement"),
    {
      type: "function_call",
      call_id: "plan_1",
      name: "update_plan",
      arguments: updatePlanArguments,
    },
    {
      type: "function_call_output",
      call_id: "plan_1",
      output: updatePlanOutput,
    },
    {
      type: "function_call",
      call_id: "call_1",
      name: "exec_command",
      arguments: '{"cmd":"rg old context","yield_time_ms":1000}',
    },
    {
      type: "function_call_output",
      call_id: "call_1",
      output: "old command output that should be dropped from history",
    },
    {
      type: "function_call",
      call_id: "call_2",
      name: "exec_command",
      arguments: '{"cmd":"tail -n 20 logs/events.jsonl"}',
    },
    {
      type: "function_call_output",
      call_id: "call_2",
      output: "latest command output",
    },
    message("user", "Most recent user input"),
  ];

  const optimized = optimizeRequestInput(input, {
    keepRecentUserMessages: 1,
    keepRecentItems: 2,
    keepRecentFunctionCallPairs: 1,
    keepRecentReasoningItems: 1,
    keepFunctionCallName: true,
    oldToolOutputPreviewChars: 24,
    oldFunctionArgumentsPreviewChars: 24,
    dropOldReasoning: true,
  });

  const preservedPlanCall = optimized.localInput.find((item) =>
    (item as JsonObject).type === "function_call" &&
    (item as JsonObject).call_id === "plan_1"
  ) as JsonObject | undefined;
  const preservedPlanOutput = optimized.localInput.find((item) =>
    (item as JsonObject).type === "function_call_output" &&
    (item as JsonObject).call_id === "plan_1"
  ) as JsonObject | undefined;
  const summary = optimized.localInput.find((item) =>
    (item as JsonObject).type === "message" &&
    (item as JsonObject).role === "assistant" &&
    JSON.stringify(item).includes("historical function calls summary")
  ) as JsonObject | undefined;

  assertEquals(preservedPlanCall?.arguments, updatePlanArguments);
  assertEquals(preservedPlanOutput?.output, updatePlanOutput);
  assertEquals(
    optimized.localInput.some((item) =>
      (item as JsonObject).type === "function_call" &&
      (item as JsonObject).call_id === "call_1"
    ),
    false,
  );
  assertEquals(Boolean(summary), true);
  const summaryText =
    ((summary?.content as JsonObject[])[0].text ?? "") as string;
  assertEquals(summaryText.includes("update_plan"), false);
  assertStringIncludes(summaryText, "exec_command(cmd, yield_time_ms)");

  const remotePayload = buildRemoteCompactPayload(optimized.prefixSegments);
  assertEquals(remotePayload.compressibleHistory.includes("update_plan"), false);
  assertEquals(
    remotePayload.compressibleHistory.includes("tail -n 20 logs/events.jsonl"),
    false,
  );
  assertStringIncludes(
    remotePayload.compressibleHistory,
    "rg old context",
  );
});

Deno.test("applyRemoteCompactSummary replaces only dropped tool history slot", () => {
  const input = [
    message("user", "Requirement A"),
    message("assistant", "Keep this assistant context"),
    {
      type: "function_call",
      call_id: "call_1",
      name: "exec_command",
      arguments: '{"cmd":"rg foo","timeout":1000}',
    },
    {
      type: "function_call_output",
      call_id: "call_1",
      output: "old output 1",
    },
    {
      type: "reasoning",
      encrypted_content: "reasoning should stay verbatim",
    },
    {
      type: "function_call",
      call_id: "call_2",
      name: "exec_command",
      arguments: '{"cmd":"pwd"}',
    },
    {
      type: "function_call_output",
      call_id: "call_2",
      output: "latest output",
    },
    message("user", "recent user input"),
  ];

  const optimized = optimizeRequestInput(input, {
    keepRecentUserMessages: 1,
    keepRecentItems: 2,
    keepRecentFunctionCallPairs: 1,
    keepRecentReasoningItems: 2,
    keepFunctionCallName: false,
    oldToolOutputPreviewChars: 40,
    oldFunctionArgumentsPreviewChars: 20,
    dropOldReasoning: true,
  });

  const finalInput = applyRemoteCompactSummary(
    optimized,
    buildSummaryMessage("SUMMARY_PREFIX", "tool history summary"),
  );

  assertEquals((finalInput[0] as JsonObject).role, "user");
  assertEquals((finalInput[1] as JsonObject).role, "assistant");
  assertEquals(
    (((finalInput[2] as JsonObject).content as JsonObject[])[0].text ?? "") as string,
    "SUMMARY_PREFIX\ntool history summary",
  );
  assertEquals((finalInput[3] as JsonObject).type, "reasoning");
  assertEquals((finalInput[4] as JsonObject).call_id, "call_2");
  assertEquals(
    finalInput.some((item) => (item as JsonObject).call_id === "call_1"),
    false,
  );
});

Deno.test("buildContinuationGuardInstruction activates for continue with unfinished update_plan", () => {
  const input = [
    message("assistant", "Investigating current assets"),
    {
      type: "function_call",
      call_id: "plan_1",
      name: "update_plan",
      arguments:
        '{"plan":[{"step":"Compare ABP graph semantics","status":"in_progress"},{"step":"Compare CBP mesh bindings","status":"pending"}]}',
    },
    {
      type: "function_call_output",
      call_id: "plan_1",
      output: "plan updated",
    },
    message("user", "继续，注意，todolist不清空，禁止停"),
  ];

  const guard = buildContinuationGuardInstruction(input);

  assertEquals(Boolean(guard), true);
  assertStringIncludes(guard ?? "", "Compare ABP graph semantics");
  assertStringIncludes(
    guard ?? "",
    "Do not end the turn after a commentary-only assistant message.",
  );
});

Deno.test("buildContinuationGuardInstruction skips non-continuation and completed plans", () => {
  const completedPlanInput = [
    {
      type: "function_call",
      call_id: "plan_done",
      name: "update_plan",
      arguments:
        '{"plan":[{"step":"Collect evidence","status":"completed"},{"step":"Summarize result","status":"completed"}]}',
    },
    message("user", "继续"),
  ];

  const nonContinuationInput = [
    {
      type: "function_call",
      call_id: "plan_active",
      name: "update_plan",
      arguments:
        '{"plan":[{"step":"Collect evidence","status":"in_progress"},{"step":"Summarize result","status":"pending"}]}',
    },
    message("user", "请解释一下当前状态"),
  ];

  assertEquals(
    buildContinuationGuardInstruction(completedPlanInput),
    undefined,
  );
  assertEquals(
    buildContinuationGuardInstruction(nonContinuationInput),
    undefined,
  );
  assertEquals(isContinuationRequestText("resume from the current step"), true);
  assertEquals(isContinuationRequestText("请解释一下当前状态"), false);
});

Deno.test("sanitizeStalledContinuationHistory drops trailing empty continuation turns", () => {
  const input = [
    message("user", "Initial task"),
    message("assistant", "I will inspect the repo."),
    {
      type: "function_call",
      call_id: "call_real",
      name: "exec_command",
      arguments: '{"cmd":"pwd"}',
    },
    {
      type: "function_call_output",
      call_id: "call_real",
      output: "/workspace",
    },
    message("user", "继续"),
    {
      type: "reasoning",
      encrypted_content: "r1",
    },
    {
      type: "message",
      role: "assistant",
      phase: "commentary",
      content: [{
        type: "output_text",
        text: "I will compare the next files.",
      }],
    },
    message("user", "为什么停了？"),
    {
      type: "reasoning",
      encrypted_content: "r2",
    },
    message("user", "继续，注意，todolist不清空，禁止停"),
  ];

  const sanitized = sanitizeStalledContinuationHistory(input);
  const texts = sanitized.input
    .filter((item) => (item as JsonObject).type === "message")
    .map((item) =>
      (((item as JsonObject).content as JsonObject[] | undefined)?.[0]?.text ??
        "") as string
    );

  assertEquals(sanitized.removedTurnCount, 2);
  assertEquals(sanitized.removedItemCount, 3);
  assertEquals(texts.includes("I will compare the next files."), false);
  assertEquals(texts.includes("继续，注意，todolist不清空，禁止停"), true);
});

Deno.test("sanitizeStalledContinuationHistory skips user-only gaps and environment context", () => {
  const input = [
    message("user", "Initial task"),
    {
      type: "function_call",
      call_id: "call_real",
      name: "exec_command",
      arguments: '{"cmd":"pwd"}',
    },
    {
      type: "function_call_output",
      call_id: "call_real",
      output: "/workspace",
    },
    {
      type: "reasoning",
      encrypted_content: "stalled-r1",
    },
    {
      type: "message",
      role: "assistant",
      phase: "commentary",
      content: [{ type: "output_text", text: "I will call the tool next." }],
    },
    message("user", "继续，注意，todolist不清空，禁止停"),
    {
      type: "reasoning",
      encrypted_content: "stalled-r2",
    },
    message("user", "为什么停了？"),
    {
      type: "reasoning",
      encrypted_content: "stalled-r3",
    },
    {
      type: "message",
      role: "assistant",
      phase: "commentary",
      content: [{
        type: "output_text",
        text: "Now I will inspect live state.",
      }],
    },
    message(
      "user",
      "<environment_context>\n  <shell>powershell</shell>\n</environment_context>",
    ),
    message("user", "继续，注意，todolist不清空，禁止停"),
  ];

  const sanitized = sanitizeStalledContinuationHistory(input);
  const serialized = JSON.stringify(sanitized.input);

  assertEquals(sanitized.removedTurnCount, 3);
  assertEquals(sanitized.removedItemCount, 5);
  assertEquals(serialized.includes("I will call the tool next."), false);
  assertEquals(serialized.includes("Now I will inspect live state."), false);
  assertEquals(serialized.includes("<environment_context>"), true);
  assertEquals(serialized.includes("为什么停了？"), true);
});

Deno.test("sanitizeStalledContinuationHistory keeps turns with real tool progress", () => {
  const input = [
    message("user", "Initial task"),
    message("user", "继续"),
    {
      type: "function_call",
      call_id: "call_real",
      name: "exec_command",
      arguments: '{"cmd":"ls"}',
    },
    {
      type: "function_call_output",
      call_id: "call_real",
      output: "file1",
    },
    message("user", "继续"),
  ];

  const sanitized = sanitizeStalledContinuationHistory(input);
  assertEquals(sanitized.removedTurnCount, 0);
  assertEquals(sanitized.input.length, input.length);
});

function makeTurn(items: JsonObject[]): UpstreamTurn {
  return {
    events: [
      ...items.map((item) => ({
        type: "response.output_item.done",
        data: { item },
      })),
      {
        type: "response.completed",
        data: {
          response: {
            status: "completed",
          },
        },
      },
    ],
    responseId: "resp_test",
    usage: {},
    rawSse: "",
    status: 200,
  };
}

Deno.test("shouldRetryContinuationTurn retries reasoning-only completions", () => {
  const turn = makeTurn([{
    id: "rs_1",
    type: "reasoning",
    summary: [],
  }]);

  assertEquals(shouldRetryContinuationTurn(turn), true);
});

Deno.test("shouldRetryContinuationTurn retries commentary-only completions", () => {
  const turn = makeTurn([{
    id: "msg_1",
    type: "message",
    role: "assistant",
    phase: "commentary",
    content: [{ type: "output_text", text: "I will continue." }],
  }]);

  assertEquals(shouldRetryContinuationTurn(turn), true);
});

Deno.test("shouldRetryContinuationTurn keeps real tool-progress completions", () => {
  const turn = makeTurn([{
    id: "fc_1",
    type: "function_call",
    call_id: "call_1",
    name: "exec_command",
    arguments: '{"cmd":"pwd"}',
  }]);

  assertEquals(shouldRetryContinuationTurn(turn), false);
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
      {
        input: [
          message("user", "Fix src/server.ts compile error and patch the code"),
        ],
      },
      AUTO_MODELS,
    ),
    { model: "gpt-code", reason: "code_signal" },
  );

  assertEquals(
    chooseAutoModel(
      {
        input: [
          message("user", "Give me an architecture plan for this feature"),
        ],
      },
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

Deno.test("shouldCompressContext respects the local prune threshold", () => {
  assertEquals(shouldCompressContext(179999, 180000), false);
  assertEquals(shouldCompressContext(180000, 180000), true);
  assertEquals(shouldCompressContext(240000, 180000), true);
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
