#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
SOURCE_DIR="$ROOT_DIR/proxy/agents"

if [[ ! -d "$SOURCE_DIR" ]]; then
  echo "Agent template directory not found: $SOURCE_DIR" >&2
  exit 1
fi

select_json_runtime() {
  if command -v python3 >/dev/null 2>&1; then
    printf 'python3\n'
    return 0
  fi
  if command -v python >/dev/null 2>&1; then
    printf 'python\n'
    return 0
  fi
  if command -v node >/dev/null 2>&1; then
    printf 'node\n'
    return 0
  fi
  return 1
}

resolve_augment_home() {
  if [[ -n "${AUGMENT_HOME:-}" ]]; then
    printf '%s\n' "$AUGMENT_HOME"
    return 0
  fi
  if [[ -n "${HOME:-}" ]]; then
    printf '%s/.augment\n' "$HOME"
    return 0
  fi
  if [[ -n "${USERPROFILE:-}" ]]; then
    printf '%s/.augment\n' "$USERPROFILE"
    return 0
  fi
  if [[ -n "${HOMEDRIVE:-}" || -n "${HOMEPATH:-}" ]]; then
    printf '%s%s/.augment\n' "${HOMEDRIVE:-}" "${HOMEPATH:-}"
    return 0
  fi

  local runtime
  runtime="$(select_json_runtime)" || {
    echo "Could not resolve AUGMENT_HOME and no python/node runtime is available." >&2
    exit 1
  }

  if [[ "$runtime" == "node" ]]; then
    "$runtime" -e 'const os = require("os"); process.stdout.write(os.homedir() + "/.augment\n");'
    return 0
  fi

  "$runtime" - <<'PY'
from pathlib import Path
print(Path.home() / ".augment")
PY
}

merge_feature_config() {
  local runtime="$1"
  local config_path="$2"

  if [[ "$runtime" == "node" ]]; then
    "$runtime" - "$config_path" <<'NODE'
const fs = require("fs");
const path = require("path");

const configPath = process.argv[2];
const desiredModes = {
  explore: "auto",
  plan: "auto",
  code: "auto",
  validate: "auto",
  judge: "auto",
  askexpert: "auto",
  docs: "auto",
  research: "auto",
};

let data = {};
if (fs.existsSync(configPath)) {
  try {
    data = JSON.parse(fs.readFileSync(configPath, "utf8"));
  } catch {
    const backupPath = `${configPath}.bak-${Date.now()}`;
    fs.renameSync(configPath, backupPath);
    console.error(`Backed up invalid feature-config.json to ${backupPath}`);
    data = {};
  }
}
if (!data || typeof data !== "object" || Array.isArray(data)) {
  data = {};
}
const currentModes =
  data.subagentModes &&
    typeof data.subagentModes === "object" &&
    !Array.isArray(data.subagentModes)
    ? data.subagentModes
    : {};
data.subagentModes = { ...currentModes, ...desiredModes };
fs.mkdirSync(path.dirname(configPath), { recursive: true });
fs.writeFileSync(configPath, `${JSON.stringify(data, null, 2)}\n`);
NODE
    return 0
  fi

  "$runtime" - "$config_path" <<'PY'
import json
import sys
import time
from pathlib import Path

config_path = Path(sys.argv[1])
desired_modes = {
    "explore": "auto",
    "plan": "auto",
    "code": "auto",
    "validate": "auto",
    "judge": "auto",
    "askexpert": "auto",
    "docs": "auto",
    "research": "auto",
}

data = {}
if config_path.exists():
    try:
        loaded = json.loads(config_path.read_text(encoding="utf-8"))
    except Exception:
        backup_path = config_path.with_name(
            f"{config_path.name}.bak-{int(time.time() * 1000)}"
        )
        config_path.rename(backup_path)
        print(
            f"Backed up invalid feature-config.json to {backup_path}",
            file=sys.stderr,
        )
        loaded = {}
    if isinstance(loaded, dict):
        data = loaded

current_modes = data.get("subagentModes")
if not isinstance(current_modes, dict):
    current_modes = {}
current_modes.update(desired_modes)
data["subagentModes"] = current_modes

config_path.parent.mkdir(parents=True, exist_ok=True)
config_path.write_text(
    json.dumps(data, indent=2, ensure_ascii=False) + "\n",
    encoding="utf-8",
)
PY
}

JSON_RUNTIME="$(select_json_runtime)" || {
  echo "This script requires python3, python, or node." >&2
  exit 1
}

AUGMENT_DIR="$(resolve_augment_home)"
TARGET_AGENTS_DIR="$AUGMENT_DIR/agents"
TARGET_CONFIG="$AUGMENT_DIR/feature-config.json"

mkdir -p "$TARGET_AGENTS_DIR"

shopt -s nullglob
agent_files=("$SOURCE_DIR"/*.md)
shopt -u nullglob

if [[ ${#agent_files[@]} -eq 0 ]]; then
  echo "No agent template files found in $SOURCE_DIR" >&2
  exit 1
fi

installed_names=()
for source_file in "${agent_files[@]}"; do
  target_file="$TARGET_AGENTS_DIR/$(basename "$source_file")"
  cp -f "$source_file" "$target_file"
  installed_names+=("$(basename "$source_file")")
done

merge_feature_config "$JSON_RUNTIME" "$TARGET_CONFIG"

echo "Installed agent templates to: $TARGET_AGENTS_DIR"
printf 'Installed files:\n'
printf '  - %s\n' "${installed_names[@]}"
echo "Updated feature config: $TARGET_CONFIG"
echo "Restart Auggie and run /agents to confirm code / validate / judge / askexpert / docs are available."
