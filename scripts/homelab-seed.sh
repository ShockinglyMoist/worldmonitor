#!/bin/bash
# Homelab wrapper: run the World Monitor seeders inside node:24-alpine.
# The host runs Node 20 but the repo targets Node 24 (.nvmrc), so the seeders
# execute in a container on the host network (redis-rest listens on 127.0.0.1:8079).
# run-seeders.sh sources REDIS_TOKEN and API keys from .env itself.
set -euo pipefail
cd "$(dirname "$0")/.."

exec docker run --rm --network host \
  -v "$PWD:/app" -w /app \
  --entrypoint sh \
  node:24-alpine scripts/run-seeders.sh
