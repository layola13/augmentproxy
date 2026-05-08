function assertEquals(actual: unknown, expected: unknown): void {
  if (JSON.stringify(actual) !== JSON.stringify(expected)) {
    throw new Error(
      `Assertion failed\nactual: ${JSON.stringify(actual)}\nexpected: ${
        JSON.stringify(expected)
      }`,
    );
  }
}

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message);
}

function fileUrlPath(relative: string): string {
  const url = new URL(relative, import.meta.url);
  let path = decodeURIComponent(url.pathname);
  if (Deno.build.os === "windows" && path.startsWith("/")) {
    path = path.slice(1);
  }
  return path;
}

function repoRootPath(): string {
  return fileUrlPath("../../");
}

function installScriptPath(): string {
  return fileUrlPath("../../install_agents.sh");
}

Deno.test("install_agents.sh copies agent templates and merges feature-config", async () => {
  const augmentHome = await Deno.makeTempDir({
    prefix: "augmentproxy-install-agents-",
  });
  const configPath = `${augmentHome}/feature-config.json`;

  try {
    await Deno.writeTextFile(
      configPath,
      JSON.stringify(
        {
          existingSetting: true,
          subagentModes: {
            explore: "manual",
            custom: "keep-me",
          },
        },
        null,
        2,
      ) + "\n",
    );

    const command = new Deno.Command("bash", {
      args: [installScriptPath()],
      cwd: repoRootPath(),
      env: { AUGMENT_HOME: augmentHome },
      stdout: "piped",
      stderr: "piped",
    });
    const output = await command.output();
    if (output.code !== 0) {
      throw new Error(new TextDecoder().decode(output.stderr));
    }

    const agentsDir = `${augmentHome}/agents`;
    const expectedFiles = [
      "askexpert.md",
      "code.md",
      "docs.md",
      "judge.md",
      "validate.md",
    ];
    for (const fileName of expectedFiles) {
      const sourceContent = await Deno.readTextFile(
        `${repoRootPath()}proxy/agents/${fileName}`,
      );
      const installedContent = await Deno.readTextFile(
        `${agentsDir}/${fileName}`,
      );
      assertEquals(installedContent, sourceContent);
    }

    const config = JSON.parse(await Deno.readTextFile(configPath)) as Record<
      string,
      unknown
    >;
    assertEquals(config.existingSetting, true);
    const subagentModes = config.subagentModes as Record<string, unknown>;
    assert(subagentModes && typeof subagentModes === "object", "missing modes");
    assertEquals(subagentModes.explore, "auto");
    assertEquals(subagentModes.plan, "auto");
    assertEquals(subagentModes.code, "auto");
    assertEquals(subagentModes.validate, "auto");
    assertEquals(subagentModes.judge, "auto");
    assertEquals(subagentModes.askexpert, "auto");
    assertEquals(subagentModes.docs, "auto");
    assertEquals(subagentModes.research, "auto");
    assertEquals(subagentModes.custom, "keep-me");
  } finally {
    await Deno.remove(augmentHome, { recursive: true }).catch(() => undefined);
  }
});
