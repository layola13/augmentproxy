#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
LOG_DIR="${ROOT_DIR}/../logs"
PID_FILE="${LOG_DIR}/codexproxy.pid"
STDOUT_LOG="${LOG_DIR}/codexproxy.stdout.log"
DEFAULT_PORT=8878

read_env_value() {
  local key="$1"
  local fallback="$2"
  local env_file="${ROOT_DIR}/.env"
  if [[ ! -f "${env_file}" ]]; then
    printf '%s\n' "${fallback}"
    return 0
  fi

  local value
  value="$(awk -F= -v key="${key}" '
    $0 ~ "^[[:space:]]*" key "=" {
      sub(/^[^=]*=/, "", $0)
      gsub(/^[[:space:]]+|[[:space:]]+$/, "", $0)
      gsub(/^"|"$/, "", $0)
      gsub(/^'\''|'\''$/, "", $0)
      print $0
      exit
    }
  ' "${env_file}")"

  if [[ -n "${value}" ]]; then
    printf '%s\n' "${value}"
  else
    printf '%s\n' "${fallback}"
  fi
}

PORT="$(read_env_value "PROXY_PORT" "${DEFAULT_PORT}")"

is_project_proxy_pid() {
  local pid="$1"
  [[ -n "${pid}" ]] || return 1
  [[ -d "/proc/${pid}" ]] || return 1

  local cwd
  cwd="$(readlink "/proc/${pid}/cwd" 2>/dev/null || true)"
  [[ "${cwd}" == "${ROOT_DIR}" ]] || return 1

  local cmdline
  cmdline="$(tr '\0' ' ' < "/proc/${pid}/cmdline" 2>/dev/null || true)"
  [[ "${cmdline}" == *"src/server.ts"* || "${cmdline}" == *"deno task start"* ]] || return 1
}

stop_pid() {
  local pid="$1"
  if ! is_project_proxy_pid "${pid}"; then
    return 0
  fi

  kill "${pid}" 2>/dev/null || true
  for _ in {1..50}; do
    if ! kill -0 "${pid}" 2>/dev/null; then
      return 0
    fi
    sleep 0.1
  done

  kill -9 "${pid}" 2>/dev/null || true
}

collect_existing_pids() {
  declare -A seen=()

  if [[ -f "${PID_FILE}" ]]; then
    local pid_from_file
    pid_from_file="$(tr -d '[:space:]' < "${PID_FILE}" || true)"
    if [[ -n "${pid_from_file}" ]]; then
      seen["${pid_from_file}"]=1
    fi
  fi

  while IFS= read -r pid; do
    [[ -n "${pid}" ]] || continue
    seen["${pid}"]=1
  done < <(pgrep -f "deno run --allow-net --allow-env --allow-read --allow-write src/server.ts" || true)

  while IFS= read -r pid; do
    [[ -n "${pid}" ]] || continue
    seen["${pid}"]=1
  done < <(pgrep -f "deno task start" || true)

  while IFS= read -r pid; do
    [[ -n "${pid}" ]] || continue
    seen["${pid}"]=1
  done < <(lsof -t -iTCP:"${PORT}" -sTCP:LISTEN 2>/dev/null || true)

  for pid in "${!seen[@]}"; do
    printf '%s\n' "${pid}"
  done
}

mkdir -p "${LOG_DIR}"

while IFS= read -r pid; do
  [[ -n "${pid}" ]] || continue
  stop_pid "${pid}"
done < <(collect_existing_pids)

rm -f "${PID_FILE}"
: > "${STDOUT_LOG}"

cd "${ROOT_DIR}"
if command -v setsid >/dev/null 2>&1; then
  setsid bash -lc '
    cd "'"${ROOT_DIR}"'"
    exec deno run --allow-net --allow-env --allow-read --allow-write src/server.ts
  ' >> "${STDOUT_LOG}" 2>&1 < /dev/null &
  NEW_PID=$!
else
  nohup deno run --allow-net --allow-env --allow-read --allow-write src/server.ts >> "${STDOUT_LOG}" 2>&1 < /dev/null &
  NEW_PID=$!
fi
echo "${NEW_PID}" > "${PID_FILE}"

for _ in {1..40}; do
  if ! kill -0 "${NEW_PID}" 2>/dev/null; then
    break
  fi

  if command -v curl >/dev/null 2>&1; then
    if curl -fsS "http://127.0.0.1:${PORT}/health" >/dev/null 2>&1; then
      printf 'codexproxy started pid=%s port=%s log=%s\n' "${NEW_PID}" "${PORT}" "${STDOUT_LOG}"
      exit 0
    fi
  elif lsof -nP -iTCP:"${PORT}" -sTCP:LISTEN >/dev/null 2>&1; then
    printf 'codexproxy started pid=%s port=%s log=%s\n' "${NEW_PID}" "${PORT}" "${STDOUT_LOG}"
    exit 0
  fi

  sleep 0.5
done

printf 'codexproxy failed to start. recent log:\n' >&2
tail -n 40 "${STDOUT_LOG}" >&2 || true
exit 1
