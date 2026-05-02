import type {
  CodexPromptAssets,
  JsonObject,
  PromptVariantName,
  PromptVariantSet,
} from "./types.ts";

const PERSONALITY_PLACEHOLDER = "{{ personality }}";

type ModelMessagesVariables = {
  personality_default?: string;
  personality_pragmatic?: string;
  personality_friendly?: string;
};

type ModelRecord = {
  slug?: string;
  model_messages?: {
    instructions_template?: string;
    instructions_variables?: ModelMessagesVariables;
  };
};

function compactPersonality(name: PromptVariantName): string {
  if (name === "pragmatic") {
    return [
      "# Personality",
      "You are a deeply pragmatic software engineer.",
      "- Prefer clear, defensible decisions and explicit tradeoffs.",
      "- Keep communication concise, direct, and respectful.",
      "- Push toward the smallest change that safely completes the task.",
    ].join("\n");
  }
  if (name === "friendly") {
    return [
      "# Personality",
      "You are a warm, steady collaborator.",
      "- Keep the user informed without condescension.",
      "- Explain clearly and unblock quickly.",
      "- Stay supportive while still being technically rigorous.",
    ].join("\n");
  }
  return [
    "# Personality",
    "You are curious, warm, proactive, and grounded.",
    "- Ask clarifying questions only when they change the implementation.",
    "- Once you have enough context, act decisively and keep going.",
    "- Maintain a real point of view without turning the interaction into performance.",
  ].join("\n");
}

function compactInstructionsVariant(name: PromptVariantName): string {
  return [
    "You are Codex, a coding agent based on GPT-5. You and the user share one workspace, and your job is to collaborate until the goal is genuinely handled.",
    "",
    compactPersonality(name),
    "",
    "# General",
    "- Read the codebase before making assumptions.",
    "- Prefer `rg` and `rg --files` for search.",
    "- Parallelize independent reads with `multi_tool_use.parallel`.",
    "",
    "## Engineering judgment",
    "- Prefer existing repo patterns, helpers, and ownership boundaries.",
    "- Keep changes scoped; avoid unrelated refactors and metadata churn.",
    "- Add abstractions only when they clearly reduce real complexity.",
    "- Scale verification to blast radius and user-facing risk.",
    "",
    "## Editing constraints",
    "- Default to ASCII unless the file already needs Unicode.",
    "- Use `apply_patch` for manual edits.",
    "- Do not revert user changes unless explicitly asked.",
    "- Avoid destructive git commands unless explicitly requested.",
    "",
    "## Autonomy",
    "- Persist until the task is handled end to end when feasible.",
    "- If the user asked for implementation, do the work instead of stopping at a proposal.",
    "- Resolve blockers yourself before handing them back.",
    "",
    "## Working with the user",
    "- Keep progress updates short, concrete, and frequent while working.",
    "- Final answers should be concise, high-signal, and focused on outcome, verification, and real risks.",
    "- Use markdown only when it improves scanability.",
  ].join("\n");
}

function renderInstructions(template: string, personalityText: string): string {
  return template.replace(PERSONALITY_PLACEHOLDER, personalityText);
}

function promptVariants(template: string, variables: ModelMessagesVariables): PromptVariantSet {
  return {
    default: renderInstructions(template, variables.personality_default ?? ""),
    pragmatic: renderInstructions(
      template,
      variables.personality_pragmatic ?? variables.personality_default ?? "",
    ),
    friendly: renderInstructions(
      template,
      variables.personality_friendly ?? variables.personality_default ?? "",
    ),
  };
}

let cachedAssets: CodexPromptAssets | undefined;

export async function loadCodexPromptAssets(codexRoot: string): Promise<CodexPromptAssets> {
  if (cachedAssets?.codexRoot === codexRoot) return cachedAssets;

  const modelsJsonPath = `${codexRoot}/codex-rs/models-manager/models.json`;
  const modelsText = await Deno.readTextFile(modelsJsonPath);
  const parsed = JSON.parse(modelsText) as JsonObject;
  const models = Array.isArray(parsed.models) ? parsed.models as ModelRecord[] : [];
  const gpt55 = models.find((model) => model?.slug === "gpt-5.5");
  if (!gpt55?.model_messages?.instructions_template) {
    throw new Error(`Failed to load gpt-5.5 instructions_template from ${modelsJsonPath}`);
  }

  const compactPromptPath = `${codexRoot}/codex-rs/core/templates/compact/prompt.md`;
  const summaryPrefixPath = `${codexRoot}/codex-rs/core/templates/compact/summary_prefix.md`;
  const compactPrompt = await Deno.readTextFile(compactPromptPath);
  const summaryPrefix = await Deno.readTextFile(summaryPrefixPath);
  const template = gpt55.model_messages.instructions_template;
  const variables = gpt55.model_messages.instructions_variables ?? {};

  cachedAssets = {
    codexRoot,
    fullVariants: promptVariants(template, variables),
    compactVariants: {
      default: compactInstructionsVariant("default"),
      pragmatic: compactInstructionsVariant("pragmatic"),
      friendly: compactInstructionsVariant("friendly"),
    },
    compactPrompt,
    summaryPrefix,
  };
  return cachedAssets;
}
