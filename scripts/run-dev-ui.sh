#!/usr/bin/env bash
# Run the chat-ui sub-application locally in dev mode.
#
# Topology (see chat-ui/vite.config.ts and project-design.md §14):
#   - Vite SPA dev server   on 127.0.0.1:5173  ← THIS is the URL to open
#   - Fastify API/profile   on 127.0.0.1:5174  ← internal; Vite proxies /api/*
#   - Profiles file:        ~/.agent-host-cc/chat-ui/profiles.json
#
# Why a launcher script:
#   chat-ui/package.json's `dev` already exports CHAT_UI_PORT=5174 and runs
#   Vite + Fastify together via `concurrently`. This wrapper adds:
#     - optional chat-ui/.env sourcing for per-developer overrides
#     - a clear startup banner with the URL the operator must follow
#     - sanity checks (chat-ui dir present, node_modules installed)
#   The chat-ui process does NOT need the agent-host-cc API key — connection
#   info (baseUrl + apiKey) is stored per-profile in profiles.json, NOT in env.
#
# Usage:
#   ./scripts/run-dev-ui.sh                          # default ports, optional chat-ui/.env
#   CHAT_UI_PORT=6000 ./scripts/run-dev-ui.sh        # override Fastify port
#   ENV_FILE=.env.dev ./scripts/run-dev-ui.sh        # source a different env file
#   LOG_LEVEL=debug ./scripts/run-dev-ui.sh          # verbose logs
#
# Environment overrides (all optional):
#   ENV_FILE                 path to env file under chat-ui/   (default: .env, sourced only if it exists)
#   CHAT_UI_PORT             Fastify port                       (default: 5174)
#   CHAT_UI_PROFILES_PATH    profiles.json override             (default: ~/.agent-host-cc/chat-ui/profiles.json)
#   CHAT_UI_SERVE_STATIC     "true"/"false"                     (default: heuristic — false in dev)
#   LOG_LEVEL                pino log level                      (default: info)
#
# Note: the Vite port (5173) is hard-coded in chat-ui/vite.config.ts with
# `strictPort: true`. To change it, edit vite.config.ts — env override is
# intentionally not exposed because the Fastify proxy target is paired with it.

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
ROOT_DIR="$(cd "${SCRIPT_DIR}/.." && pwd)"
UI_DIR="${ROOT_DIR}/chat-ui"

if [[ ! -d "${UI_DIR}" ]]; then
  echo "ERROR: chat-ui directory not found at '${UI_DIR}'." >&2
  echo "       This script expects the chat-ui sub-application beside scripts/." >&2
  exit 2
fi

cd "${UI_DIR}"

if [[ ! -d "node_modules" ]]; then
  echo "ERROR: chat-ui/node_modules is missing." >&2
  echo "       Install dependencies first:  (cd chat-ui && npm install)" >&2
  exit 3
fi

if ! command -v npm >/dev/null 2>&1; then
  echo "ERROR: npm not found in PATH." >&2
  exit 127
fi

# Optional .env sourcing — chat-ui has no required env vars, so an absent file
# is fine. When present, `set -a` makes plain KEY=value lines behave as if each
# had `export` prefixed, so the values reach Vite, tsx, and Fastify children.
ENV_FILE="${ENV_FILE:-.env}"
ENV_SOURCED="<none — launcher defaults only>"
if [[ -f "${ENV_FILE}" ]]; then
  set -a
  # shellcheck disable=SC1090
  source "${ENV_FILE}"
  set +a
  ENV_SOURCED="${UI_DIR}/${ENV_FILE}"
fi

# Launcher-level defaults applied AFTER sourcing so .env values win when set
# there. Kept in sync with the `dev` npm-script's inline CHAT_UI_PORT=5174
# (chat-ui/package.json) so the launcher and the package script behave the
# same regardless of which entry-point an operator uses.
export CHAT_UI_PORT="${CHAT_UI_PORT:-5174}"
export LOG_LEVEL="${LOG_LEVEL:-info}"

# Vite port is fixed by chat-ui/vite.config.ts (strictPort: true, port: 5173).
# The Fastify server's CORS / proxy assumptions depend on this pairing, so we
# advertise the value rather than try to make it configurable from the shell.
VITE_PORT="5173"
VITE_URL="http://localhost:${VITE_PORT}"
API_URL="http://127.0.0.1:${CHAT_UI_PORT}"
PROFILES_PATH="${CHAT_UI_PROFILES_PATH:-${HOME}/.agent-host-cc/chat-ui/profiles.json}"

bar="══════════════════════════════════════════════════════════════════════════════"
sub="──────────────────────────────────────────────────────────────────────────────"

cat <<BANNER
${bar}
 agent-host-cc — chat UI (dev)
${sub}
 → Open in browser:  ${VITE_URL}            ← THE URL TO FOLLOW
   Internal API:     ${API_URL}            (Fastify; proxied by Vite /api/*)
${sub}
 Environment
   ENV_FILE sourced:     ${ENV_SOURCED}
   CHAT_UI_PORT:         ${CHAT_UI_PORT}                        (Fastify bind port)
   VITE_PORT (fixed):    ${VITE_PORT}                        (from vite.config.ts strictPort)
   LOG_LEVEL:            ${LOG_LEVEL}
   CHAT_UI_PROFILES_PATH:${CHAT_UI_PROFILES_PATH:+ ${CHAT_UI_PROFILES_PATH}}${CHAT_UI_PROFILES_PATH:-  <default> ${PROFILES_PATH}}
   CHAT_UI_SERVE_STATIC: ${CHAT_UI_SERVE_STATIC:-<unset — auto in dev>}
${sub}
 Connectivity reminders
   1. The chat-ui has NO agent-host API key in env by design — connection
      details (baseUrl + bearer token) live per-profile in profiles.json.
   2. To actually chat, the agent-host-cc API must be reachable from this
      machine. Start it locally with:    ./scripts/run-dev.sh
      or via the container:              ./scripts/run-apple-container.sh
   3. Open ${VITE_URL} → Manage profiles → set baseUrl / apiKey / model.
${bar}
BANNER

exec npm run dev
