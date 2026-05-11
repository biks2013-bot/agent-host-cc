#!/usr/bin/env bash
# Run the agent-host-cc container with Docker.
#
# Usage:
#   ./scripts/run-docker.sh                           # foreground, port 8000, named volume, .env
#   ./scripts/run-docker.sh v1.2.0                    # run a specific tag
#   DETACH=1 ./scripts/run-docker.sh                  # run in background, print container id
#
# Environment overrides:
#   IMAGE_NAME    image repository name      (default: agent-host-cc)
#   IMAGE_TAG     image tag                  (default: $1 or "dev")
#   ENV_FILE      env-file path              (default: ./.env — must exist; no fallback)
#   HOST_PORT     host port to publish       (default: 8091)
#   CONTAINER_PORT container listen port      (default: 8000 — must match LISTEN_PORT in env)
#   VOLUME_NAME   workspace named volume     (default: agent-host-cc-workspace)
#   CONTAINER_NAME --name value              (default: agent-host-cc; pass empty to let Docker auto-name)
#   CLAUDE_DIR    host path mounted at /home/node/.claude (default: $HOME/.claude;
#                 pass empty to skip the mount entirely)
#   CLAUDE_MODE   "ro" or "rw"               (default: rw)
#   DETACH        "1" → -d, else -it foreground (default: unset → foreground)
#   EXTRA_ARGS    extra args appended to docker run (default: empty)
#   REBUILD       "1" → run build-docker.sh ${IMAGE_TAG} before running (default: unset)
#   NO_BUILD      "1" → never auto-build, fail if image missing (default: unset; default behaviour is to auto-build when the image is absent)

set -euo pipefail

cd "$(dirname "$0")/.."

# discover_claude_extra_mounts <claude-dir>
# Emits one absolute host directory per line — each directory must be bind-mounted
# at the same path inside the container so absolute symlinks in ${claude-dir}
# (e.g. ~/.claude/settings.json -> /Users/.../claude-workdocs/.claude/settings.json)
# can resolve from inside the container. Only walks the top level of ${claude-dir};
# nested symlinks aren't auto-detected (keep the surface area small and the helper
# fast). Targets that point back inside ${claude-dir} are skipped because the main
# ${CLAUDE_DIR}:/home/node/.claude mount already covers them.
discover_claude_extra_mounts() {
  local base="$1" link target parent
  [[ -d "${base}" ]] || return 0
  while IFS= read -r link; do
    target=$(readlink "${link}") || continue
    [[ -z "${target}" ]] && continue
    if [[ "${target}" != /* ]]; then
      target="$(cd "$(dirname "${link}")" 2>/dev/null && cd "$(dirname "${target}")" 2>/dev/null && pwd)/$(basename "${target}")"
    fi
    case "${target}" in "${base}"/*|"${base}") continue ;; esac
    parent="$(dirname "${target}")"
    [[ -d "${parent}" ]] && printf '%s\n' "${parent}"
  done < <(find "${base}" -maxdepth 1 -type l 2>/dev/null) | sort -u
}

IMAGE_NAME="${IMAGE_NAME:-agent-host-cc}"
IMAGE_TAG="${IMAGE_TAG:-${1:-dev}}"
ENV_FILE="${ENV_FILE:-.env}"
HOST_PORT="${HOST_PORT:-8091}"
CONTAINER_PORT="${CONTAINER_PORT:-8000}"
VOLUME_NAME="${VOLUME_NAME:-agent-host-cc-workspace}"
CONTAINER_NAME="${CONTAINER_NAME-agent-host-cc}"
CLAUDE_DIR="${CLAUDE_DIR-${HOME}/.claude}"
CLAUDE_MODE="${CLAUDE_MODE:-rw}"
DETACH="${DETACH:-}"
EXTRA_ARGS="${EXTRA_ARGS:-}"
REBUILD="${REBUILD:-}"
NO_BUILD="${NO_BUILD:-}"

if ! command -v docker >/dev/null 2>&1; then
  echo "ERROR: docker not found in PATH." >&2
  exit 127
fi
if ! docker info >/dev/null 2>&1; then
  echo "ERROR: docker daemon is not running." >&2
  exit 1
fi
if [[ ! -f "${ENV_FILE}" ]]; then
  echo "ERROR: env-file '${ENV_FILE}' not found." >&2
  echo "Create one from .env.example: cp .env.example .env && chmod 600 .env" >&2
  exit 2
fi
# Auto-build whenever the image is missing, or when REBUILD=1 forces a refresh
# after a source change. NO_BUILD=1 disables this to support pre-built images.
need_build=0
if ! docker image inspect "${IMAGE_NAME}:${IMAGE_TAG}" >/dev/null 2>&1; then
  need_build=1
elif [[ "${REBUILD}" == "1" ]]; then
  need_build=1
fi
if [[ "${need_build}" == "1" ]]; then
  if [[ "${NO_BUILD}" == "1" ]]; then
    echo "ERROR: image ${IMAGE_NAME}:${IMAGE_TAG} not present and NO_BUILD=1." >&2
    exit 3
  fi
  echo ">>> building ${IMAGE_NAME}:${IMAGE_TAG} (source change or first run)"
  IMAGE_NAME="${IMAGE_NAME}" bash "$(dirname "$0")/build-docker.sh" "${IMAGE_TAG}"
fi

# Reclaim the container name if a previous run left one behind. Docker rejects
# `--name X` if a container called X already exists in any state (running,
# stopped, created). `docker rm -f` handles both gracefully.
if [[ -n "${CONTAINER_NAME}" ]] && docker container inspect "${CONTAINER_NAME}" >/dev/null 2>&1; then
  echo ">>> removing existing container '${CONTAINER_NAME}' to reclaim the name"
  docker rm -f "${CONTAINER_NAME}" >/dev/null
fi

ARGS=(run --rm)
if [[ "${DETACH}" == "1" ]]; then
  ARGS+=(-d)
else
  ARGS+=(-it)
fi
ARGS+=(--env-file "${ENV_FILE}")
ARGS+=(-p "${HOST_PORT}:${CONTAINER_PORT}")
ARGS+=(-v "${VOLUME_NAME}:/workspace")
if [[ -n "${CLAUDE_DIR}" ]]; then
  if [[ ! -d "${CLAUDE_DIR}" ]]; then
    echo "ERROR: CLAUDE_DIR '${CLAUDE_DIR}' does not exist or is not a directory." >&2
    echo "       Pass CLAUDE_DIR= (empty) to skip mounting ~/.claude." >&2
    exit 4
  fi
  if [[ "${CLAUDE_MODE}" != "ro" && "${CLAUDE_MODE}" != "rw" ]]; then
    echo "ERROR: CLAUDE_MODE must be 'ro' or 'rw' (got '${CLAUDE_MODE}')." >&2
    exit 5
  fi
  ARGS+=(-v "${CLAUDE_DIR}:/home/node/.claude:${CLAUDE_MODE}")
  # Resolve absolute-path symlinks in ${CLAUDE_DIR} (e.g. settings.json,
  # skills, agents → /Users/.../claude-workdocs/.claude/...) by bind-mounting
  # each target's parent at the same absolute path inside the container. Without
  # this, all such symlinks dangle inside Alpine and the SDK silently sees an
  # empty user-level config.
  while IFS= read -r extra_mount; do
    [[ -z "${extra_mount}" ]] && continue
    echo ">>> auto-mounting symlink target: ${extra_mount}"
    ARGS+=(-v "${extra_mount}:${extra_mount}:${CLAUDE_MODE}")
  done < <(discover_claude_extra_mounts "${CLAUDE_DIR}")
fi
[[ -n "${CONTAINER_NAME}" ]] && ARGS+=(--name "${CONTAINER_NAME}")
# shellcheck disable=SC2206
[[ -n "${EXTRA_ARGS}" ]] && ARGS+=(${EXTRA_ARGS})
ARGS+=("${IMAGE_NAME}:${IMAGE_TAG}")

echo ">>> docker ${ARGS[*]}"
docker "${ARGS[@]}"
