#!/usr/bin/env bash
# Delete the deployed agent-host-cc container(s) under Apple's native
# `container` CLI — and optionally the named workspace volume and/or the image.
# Mirrors scripts/delete-docker.sh.
#
# Behaviour:
#   1. Stop any running containers from ${IMAGE_NAME}:${IMAGE_TAG}.
#   2. Delete ALL containers (running + stopped) from the same image.
#   3. If WITH_VOLUME=1, remove the named workspace volume (data is lost).
#   4. If WITH_IMAGE=1, remove the image as well.
#
# Usage:
#   ./scripts/delete-apple-container.sh                  # remove containers of agent-host-cc:dev
#   ./scripts/delete-apple-container.sh v1.2.0           # remove containers of agent-host-cc:v1.2.0
#   ALL_TAGS=1 ./scripts/delete-apple-container.sh       # any tag of agent-host-cc
#   WITH_VOLUME=1 ./scripts/delete-apple-container.sh    # also delete the workspace volume
#   WITH_IMAGE=1  ./scripts/delete-apple-container.sh    # also delete the image
#   FORCE=1 ./scripts/delete-apple-container.sh          # use `kill` instead of graceful stop
#
# Environment overrides:
#   IMAGE_NAME    image repository name      (default: agent-host-cc)
#   IMAGE_TAG     image tag                  (default: $1 or "dev")
#   VOLUME_NAME   workspace named volume     (default: agent-host-cc-workspace — must match run-apple-container.sh)
#   ALL_TAGS      "1" → any tag of IMAGE_NAME (default: unset)
#   WITH_VOLUME   "1" → also `container volume delete` (default: unset)
#   WITH_IMAGE    "1" → also `container image delete`  (default: unset)
#   FORCE         "1" → `container kill` before delete (default: unset)

set -euo pipefail

cd "$(dirname "$0")/.."

IMAGE_NAME="${IMAGE_NAME:-agent-host-cc}"
IMAGE_TAG="${IMAGE_TAG:-${1:-dev}}"
VOLUME_NAME="${VOLUME_NAME:-agent-host-cc-workspace}"
ALL_TAGS="${ALL_TAGS:-}"
WITH_VOLUME="${WITH_VOLUME:-}"
WITH_IMAGE="${WITH_IMAGE:-}"
FORCE="${FORCE:-}"

if ! command -v container >/dev/null 2>&1; then
  echo "ERROR: 'container' CLI not found in PATH." >&2
  echo "Install: https://github.com/apple/container — or use scripts/delete-docker.sh instead." >&2
  exit 127
fi

if ! container system status >/dev/null 2>&1; then
  echo "Apple container system service is not running — nothing to delete."
  exit 0
fi

# Build the IMAGE column matcher for `container ls` (header + rows). The IMAGE
# column carries the tag, e.g. `agent-host-cc:dev`.
if [[ "${ALL_TAGS}" == "1" ]]; then
  match="^${IMAGE_NAME}(:|$)"
  desc="${IMAGE_NAME}:* (any tag)"
else
  match="^${IMAGE_NAME}:${IMAGE_TAG}$"
  desc="${IMAGE_NAME}:${IMAGE_TAG}"
fi

# --- 1. Collect ids of running and all containers ----------------------------
RUNNING=()
while IFS= read -r line; do
  [[ -n "${line}" ]] && RUNNING+=("${line}")
done < <(
  container ls 2>/dev/null \
    | awk -v m="${match}" 'NR>1 && $5 == "running" && $2 ~ m { print $1 }'
)

ALL=()
while IFS= read -r line; do
  [[ -n "${line}" ]] && ALL+=("${line}")
done < <(
  container ls -a 2>/dev/null \
    | awk -v m="${match}" 'NR>1 && $2 ~ m { print $1 }'
)

if [[ ${#ALL[@]} -eq 0 ]]; then
  echo "No containers (running or stopped) from ${desc}."
else
  echo "Found ${#ALL[@]} container(s) from ${desc}:"
  container ls -a 2>/dev/null \
    | awk -v m="${match}" 'NR==1 || ($2 ~ m)'
  echo

  if [[ ${#RUNNING[@]} -gt 0 ]]; then
    if [[ "${FORCE}" == "1" ]]; then
      for id in "${RUNNING[@]}"; do
        echo ">>> container kill ${id}"
        container kill "${id}" || true
      done
    else
      for id in "${RUNNING[@]}"; do
        echo ">>> container stop ${id}"
        container stop "${id}" || true
      done
    fi
  fi

  for id in "${ALL[@]}"; do
    echo ">>> container delete ${id}"
    container delete "${id}" || true
  done
  echo "Removed ${#ALL[@]} container(s)."
fi

# --- 2. Optionally delete the named volume -----------------------------------
if [[ "${WITH_VOLUME}" == "1" ]]; then
  if container volume inspect "${VOLUME_NAME}" >/dev/null 2>&1; then
    echo
    echo ">>> container volume delete ${VOLUME_NAME}"
    container volume delete "${VOLUME_NAME}" || {
      echo "WARN: volume removal failed — likely still in use by another container." >&2
    }
  else
    echo
    echo "Volume '${VOLUME_NAME}' does not exist — nothing to remove."
  fi
fi

# --- 3. Optionally delete the image ------------------------------------------
if [[ "${WITH_IMAGE}" == "1" ]]; then
  if [[ "${ALL_TAGS}" == "1" ]]; then
    echo
    echo "WITH_IMAGE=1 with ALL_TAGS=1 is not supported (pick a specific tag)." >&2
    exit 4
  fi
  if container image inspect "${IMAGE_NAME}:${IMAGE_TAG}" >/dev/null 2>&1; then
    echo
    echo ">>> container image delete ${IMAGE_NAME}:${IMAGE_TAG}"
    container image delete "${IMAGE_NAME}:${IMAGE_TAG}" || true
  else
    echo
    echo "Image '${IMAGE_NAME}:${IMAGE_TAG}' does not exist — nothing to remove."
  fi
fi
