#!/usr/bin/env bash
# Run a Node/npm command against this repo inside the node:22 image.
# The host has no Node toolchain; this wrapper is the canonical test path.
set -euo pipefail

repo_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"

exec docker run --rm \
  -v "$repo_root":/app \
  -w /app \
  --user "$(id -u):$(id -g)" \
  -e HOME=/tmp \
  -e npm_config_cache=/tmp/npm-cache \
  node:22 "$@"
