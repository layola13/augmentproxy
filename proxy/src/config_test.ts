import { getExpertChannel, loadConfig } from "./config.ts";
import type { JsonObject } from "./types.ts";

function assertEquals(actual: unknown, expected: unknown): void {
  if (JSON.stringify(actual) !== JSON.stringify(expected)) {
    throw new Error(
      `Assertion failed\nactual: ${JSON.stringify(actual)}\nexpected: ${
        JSON.stringify(expected)
      }`,
    );
  }
}

async function withEnv(
  values: Record<string, string | undefined>,
  run: () => Promise<void> | void,
): Promise<void> {
  const previous: Record<string, string | undefined> = {};
  for (const key of Object.keys(values)) {
    previous[key] = Deno.env.get(key);
    const value = values[key];
    if (value === undefined) Deno.env.delete(key);
    else Deno.env.set(key, value);
  }
  try {
    await run();
  } finally {
    for (const [key, value] of Object.entries(previous)) {
      if (value === undefined) Deno.env.delete(key);
      else Deno.env.set(key, value);
    }
  }
}

Deno.test("loadConfig reads expert_provider from TOML", async () => {
  const path = await Deno.makeTempFile({ suffix: ".toml" });
  await Deno.writeTextFile(
    path,
    `
model_provider = "main"
expert_provider = "expert"

[model_providers.main]
base_url = "https://main.example.test/v1"
api_keys = ["main-key"]
model = "main-model"

[model_providers.expert]
base_url = "https://expert.example.test/v1"
api_keys = ["expert-key"]
model = "expert-model"

[model_mapping]
"logical" = "mapped"
`,
  );
  try {
    await withEnv(
      {
        PROXY_CONFIG_FILE: path,
        SWITCH_API: "OPENAI",
        OPENAI_API_KEY: undefined,
        OPENAI_API_KEYS_FILE: undefined,
        ACTIVE_CHANNEL: undefined,
        EXPERT_CHANNEL: undefined,
      },
      () => {
        const config = loadConfig();
        const expert = getExpertChannel(config);
        assertEquals(config.activeChannel, "main");
        assertEquals(config.expertChannel, "expert");
        assertEquals(config.modelMapping.logical, "mapped");
        assertEquals(expert?.baseUrl, "https://expert.example.test/v1");
        assertEquals(expert?.apiKeys, ["expert-key"]);
        assertEquals(expert?.model, "expert-model");
      },
    );
  } finally {
    await Deno.remove(path);
  }
});

Deno.test("EXPERT_CHANNEL env is used when TOML omits expert_provider", async () => {
  const path = await Deno.makeTempFile({ suffix: ".toml" });
  await Deno.writeTextFile(
    path,
    `
model_provider = "main"

[model_providers.main]
base_url = "https://main.example.test/v1"
api_keys = ["main-key"]
model = "main-model"

[model_providers.expert_env]
base_url = "https://expert-env.example.test/v1"
api_keys = ["expert-env-key"]
model = "expert-env-model"
`,
  );
  try {
    await withEnv(
      {
        PROXY_CONFIG_FILE: path,
        SWITCH_API: "OPENAI",
        EXPERT_CHANNEL: "expert_env",
        OPENAI_API_KEY: undefined,
        OPENAI_API_KEYS_FILE: undefined,
        ACTIVE_CHANNEL: undefined,
      },
      () => {
        const config = loadConfig();
        const expert = getExpertChannel(config);
        assertEquals(config.expertChannel, "expert_env");
        assertEquals(expert?.baseUrl, "https://expert-env.example.test/v1");
      },
    );
  } finally {
    await Deno.remove(path);
  }
});
