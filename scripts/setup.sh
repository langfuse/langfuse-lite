#!/bin/sh
# One-time setup: stand-in dependencies, the official Langfuse images, and the
# migrations that ship inside the web image (so the schema always matches the
# image that runs).
#
# Needs: node 20+, uv, docker, redis-server.
set -eu
cd "$(dirname "$0")/.."
TAG="${LANGFUSE_IMAGE_TAG:-4}"

(cd shims && npm install --no-audit --no-fund)
uv venv -q .venv -p 3.12
VIRTUAL_ENV=.venv uv pip install -q -r shims/requirements.txt

docker pull "docker.langfuse.com/langfuse/langfuse:$TAG"
docker pull "docker.langfuse.com/langfuse/langfuse-worker:$TAG"

rm -rf vendor && mkdir -p vendor
cid=$(docker create "docker.langfuse.com/langfuse/langfuse:$TAG")
docker cp "$cid:/app/packages/shared/prisma/migrations" vendor/prisma-migrations >/dev/null
docker cp "$cid:/app/packages/shared/clickhouse" vendor/clickhouse >/dev/null
docker rm "$cid" >/dev/null
echo "setup done: $(ls vendor/prisma-migrations | wc -l) Postgres and $(ls vendor/clickhouse/migrations/unclustered/*.up.sql | wc -l) ClickHouse migrations from langfuse:$TAG"
