#!/usr/bin/env bash
# Delete the deployed agent-host-cc Docker container(s) — and optionally the
# named workspace volume and/or the image — produced by scripts/run-docker.sh.
#
# Behaviour:
#   1. Stop any running containers from ${IMAGE_NAME}:${IMAGE_TAG}.
#   2. Remove ALL containers (running + stopped) from the same image.
#   3. If WITH_VOLUME=1, remove the named workspace volume (data is lost).
#   4. If WITH_IMAGE=1, remove the image as well.
#
# Usage:
#   ./scripts/delete-docker.sh                           # remove containers of agent-host-cc:dev
#   ./scripts/delete-docker.sh v1.2.0                    # remove containers of agent-host-cc:v1.2.0
#   ALL_TAGS=1 ./scripts/delete-docker.sh                # any tag of agent-host-cc
#   WITH_VOLUME=1 ./scripts/delete-docker.sh             # also delete the workspace volume
#   WITH_IMAGE=1  ./scripts/delete-docker.sh             # also delete the image
#   FORCE=1 ./scripts/delete-docker.sh                   # use `kill` + `rm -f` instead of graceful stop
#
# Environment overrides:
#   IMAGE_NAME    image repository name      (default: agent-host-cc)
#   IMAGE_TAG     image tag                  (default: $1 or "dev")
#   VOLUME_NAME   workspace named volume     (default: agent-host-cc-workspace — must match run-docker.sh)
#   TIMEOUT       seconds for graceful stop  (default: 10)
#   ALL_TAGS      "1" → any tag of IMAGE_NAME (default: unset)
#   WITH_VOLUME   "1" → also `docker volume rm` (default: unset)
#   WITH_IMAGE    "1" → also `docker image rm` (default: unset)
#   FORCE         "1" → kill + rm -f         (default: unset)

set -euo pipefail

cd "$(dirname "$0")/.."

IMAGE_NAME="${IMAGE_NAME:-agent-host-cc}"
IMAGE_TAG="${IMAGE_TAG:-${1:-dev}}"
VOLUME_NAME="${VOLUME_NAME:-agent-host-cc-workspace}"
TIMEOUT="${TIMEOUT:-10}"
ALL_TAGS="${ALL_TAGS:-}"
WITH_VOLUME="${WITH_VOLUME:-}"
WITH_IMAGE="${WITH_IMAGE:-}"
FORCE="${FORCE:-}"

if ! command -v docker >/dev/null 2>&1; then
  echo "ERROR: docker not found in PATH." >&2
  exit 127
fi
if ! docker info >/dev/null 2>&1; then
  echo "ERROR: docker daemon is not running." >&2
  exit 1
fi

if [[ "${ALL_TAGS}" == "1" ]]; then
  filter="ancestor=${IMAGE_NAME}"
  desc="${IMAGE_NAME}:* (any tag)"
else
  filter="ancestor=${IMAGE_NAME}:${IMAGE_TAG}"
  desc="${IMAGE_NAME}:${IMAGE_TAG}"
fi

# --- 1. Collect running container ids -----------------------------------------
RUNNING=()
while IFS= read -r line; do
  [[ -n "${line}" ]] && RUNNING+=("${line}")
done < <(docker ps --filter "${filter}" --format '{{.ID}}')

# --- 2. Collect all (running + stopped) container ids -------------------------
ALL=()
while IFS= read -r line; do
  [[ -n "${line}" ]] && ALL+=("${line}")
done < <(docker ps -a --filter "${filter}" --format '{{.ID}}')

if [[ ${#ALL[@]} -eq 0 ]]; then
  echo "No containers (running or stopped) from ${desc}."
else
  echo "Found ${#ALL[@]} container(s) from ${desc}:"
  docker ps -a --filter "${filter}" --format 'table {{.ID}}\t{{.Image}}\t{{.Names}}\t{{.Status}}'
  echo

  if [[ ${#RUNNING[@]} -gt 0 ]]; then
    if [[ "${FORCE}" == "1" ]]; then
      echo ">>> docker kill ${RUNNING[*]}"
      docker kill "${RUNNING[@]}" || true
    else
      echo ">>> docker stop -t ${TIMEOUT} ${RUNNING[*]}"
      docker stop -t "${TIMEOUT}" "${RUNNING[@]}" || true
    fi
  fi

  if [[ "${FORCE}" == "1" ]]; then
    echo ">>> docker rm -f ${ALL[*]}"
    docker rm -f "${ALL[@]}" || true
  else
    echo ">>> docker rm ${ALL[*]}"
    docker rm "${ALL[@]}" || true
  fi
  echo "Removed ${#ALL[@]} container(s)."
fi

# --- 3. Optionally delete the named volume -----------------------------------
if [[ "${WITH_VOLUME}" == "1" ]]; then
  if docker volume inspect "${VOLUME_NAME}" >/dev/null 2>&1; then
    echo
    echo ">>> docker volume rm ${VOLUME_NAME}"
    docker volume rm "${VOLUME_NAME}" || {
      echo "WARN: volume removal failed — likely still in use by another container." >&2
    }
  else
    echo
    echo "Volume '${VOLUME_NAME}' does not exist — nothing to remove."
  fi
fi

# --- 4. Optionally delete the image ------------------------------------------
if [[ "${WITH_IMAGE}" == "1" ]]; then
  if [[ "${ALL_TAGS}" == "1" ]]; then
    echo
    echo "WITH_IMAGE=1 with ALL_TAGS=1 is not supported (pick a specific tag)." >&2
    exit 4
  fi
  if docker image inspect "${IMAGE_NAME}:${IMAGE_TAG}" >/dev/null 2>&1; then
    echo
    echo ">>> docker image rm ${IMAGE_NAME}:${IMAGE_TAG}"
    docker image rm "${IMAGE_NAME}:${IMAGE_TAG}" || true
  else
    echo
    echo "Image '${IMAGE_NAME}:${IMAGE_TAG}' does not exist — nothing to remove."
  fi
fi
