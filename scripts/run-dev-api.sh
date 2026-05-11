#!/usr/bin/env bash
# Run agent-host-cc locally (no container) with tsx watch + .env loaded.
#
# Why this exists:
#   `npm run dev` invokes `tsx watch src/index.ts`, which does NOT auto-load
#   .env. The container-run scripts pass --env-file to docker/container; this
#   script does the equivalent for native macOS/Linux runs by sourcing the env
#   file into the child process. The no-fallback rule still holds — loadConfig
#   still throws on any missing required variable.
#
# Usage:
#   ./scripts/run-dev.sh                         # source .env, run on :8092, workspace under ./.local-workspace
#   LISTEN_PORT=9000 ./scripts/run-dev.sh        # override port
#   WORKSPACE_DIR=/tmp/ah ./scripts/run-dev.sh   # override workspace
#   ENV_FILE=.env.test ./scripts/run-dev.sh      # source a different env file
#
# Environment overrides (all optional except ENV_FILE which must exist):
#   ENV_FILE       path to env file               (default: .env)
#   WORKSPACE_DIR  per-chat workspace root        (default: $PWD/.local-workspace
#                  — the container default /workspace does not exist on the host)
#   LISTEN_PORT    HTTP port                       (default: 8092
#                  — avoids the 8000/8091 collisions with running containers)

set -euo pipefail

cd "$(dirname "$0")/.."

ENV_FILE="${ENV_FILE:-.env}"
if [[ ! -f "${ENV_FILE}" ]]; then
  echo "ERROR: env-file '${ENV_FILE}' not found." >&2
  echo "       Create one from .env.example: cp .env.example .env && chmod 600 .env" >&2
  exit 2
fi

# Auto-export every assignment in the env file. `set -a` makes plain KEY=value
# lines behave as if each was prefixed with `export`, so `source` propagates
# the values into the child process (npm run dev → tsx → node). Comments and
# blank lines in .env are honoured by the shell's own parser.
set -a
# shellcheck disable=SC1090
source "${ENV_FILE}"
set +a

# Dev-time overrides applied AFTER sourcing so .env values win when set there.
# These are launcher-level conveniences only; the application itself still
# treats every required config var as mandatory (no in-code fallbacks).
export WORKSPACE_DIR="${WORKSPACE_DIR:-$PWD/.local-workspace}"
export LISTEN_PORT="${LISTEN_PORT:-8092}"
mkdir -p "${WORKSPACE_DIR}"

# Fail fast if the critical secret didn't make it through — gives a clearer
# message than the ConfigurationError stack trace from src/config.ts.
if [[ -z "${AGENT_HOST_API_KEY:-}" ]]; then
  echo "ERROR: AGENT_HOST_API_KEY not set after sourcing '${ENV_FILE}'." >&2
  echo "       Check the file's AGENT_HOST_API_KEY=... line is uncommented and non-empty." >&2
  exit 3
fi

echo ">>> env loaded from ${ENV_FILE}"
echo ">>> WORKSPACE_DIR=${WORKSPACE_DIR}"
echo ">>> LISTEN_PORT=${LISTEN_PORT}"
echo ">>> launching: npm run dev"

exec npm run dev
