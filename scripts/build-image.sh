#!/bin/sh
# Build the langfuse-lite image.
#
#   scripts/build-image.sh                      # -> langfuse-lite:latest
#   LANGFUSE_IMAGE_TAG=4 IMAGE=langfuse-lite:dev scripts/build-image.sh
#
# Stages build/image/ on the host, then runs `docker build` on it:
#   python/         uv's portable CPython 3.12 (works on the image's glibc 2.34)
#   site-packages/  chDB (core only), aiohttp, moto's S3 server for that Python
#   shims/          postgres.mjs (+ PGlite) and clickhouse.py
#   seed/           Postgres and ClickHouse data: migrated, then warmed up by one
#                   start of the image (default models, dashboards, lite-org)
#   lite.env        langfuse-lite.env + worker.env
# Needs: scripts/setup.sh run first, uv, node 20+, docker. No root needed.
set -eu
cd "$(dirname "$0")/.."
TAG="${LANGFUSE_IMAGE_TAG:-4}"
IMAGE="${IMAGE:-langfuse-lite:latest}"
STAGE=build/image
[ -d vendor/prisma-migrations ] || { echo "run scripts/setup.sh first"; exit 1; }

rm -rf "$STAGE" && mkdir -p "$STAGE"
started=$(date +%s)

UV_PYTHON_INSTALL_DIR="$PWD/build/uv-python" uv python install --no-bin 3.12 >/dev/null 2>&1
py=$(ls -d "$PWD"/build/uv-python/cpython-3.12.*-linux-x86_64-gnu | head -1)
cp -a "$py" "$STAGE/python"
uv pip install -q --python "$STAGE/python/bin/python3.12" --target "$STAGE/site-packages" -r shims/requirements.txt
uv pip install -q --python "$STAGE/python/bin/python3.12" --target "$STAGE/site-packages" --no-deps -r shims/requirements-chdb.txt
# Bytecode is rebuilt on demand; tests and docs are not needed at runtime.
find "$STAGE/site-packages" "$STAGE/python" -name __pycache__ -type d -prune -exec rm -rf {} +
rm -rf "$STAGE/python/lib/python3.12/test" "$STAGE/python/lib/python3.12/idlelib" "$STAGE/python/lib/python3.12/tkinter" "$STAGE/python/include"

mkdir -p "$STAGE/shims"
cp shims/postgres.mjs shims/clickhouse.py shims/package.json shims/package-lock.json "$STAGE/shims/"
(cd "$STAGE/shims" && npm ci --omit=dev --no-audit --no-fund --silent)

# Pre-migrated snapshot, built with exactly the code and packages the image runs.
mkdir -p "$STAGE/seed"
node shims/postgres.mjs --data "$STAGE/seed/postgres" --migrations vendor/prisma-migrations --migrate-only
PYTHONPATH="$STAGE/site-packages" "$STAGE/python/bin/python3.12" shims/clickhouse.py --data "$STAGE/seed/clickhouse" \
  --migrations vendor/clickhouse/migrations/unclustered --migrate-only

grep -v '^HOSTNAME=' langfuse-lite.env > "$STAGE/lite.env"
cat worker.env >> "$STAGE/lite.env"
cp docker/entrypoint.sh "$STAGE/entrypoint.sh"

echo "staged in $(( $(date +%s) - started )) s: $(du -sh "$STAGE" | cut -f1)"
docker build -q --build-arg LANGFUSE_TAG="$TAG" -f docker/Dockerfile -t "$IMAGE" "$STAGE" >/dev/null

# Langfuse web seeds ~200 default model prices, dashboards and the LANGFUSE_INIT_*
# org on its first start (~20 s through PGlite). Do that once here: start the
# image once, wait for the seeding to finish, stop it cleanly and bake its /data
# in as the snapshot.
name="lite-warm-$$"
docker run -d --name "$name" "$IMAGE" >/dev/null
trap 'docker rm -f -v "$name" >/dev/null 2>&1 || true' EXIT
i=0
until docker logs "$name" 2>&1 | grep -q "Finished upserting Langfuse dashboards" &&
      docker logs "$name" 2>&1 | grep -q "Finished upserting default model prices" &&
      docker logs "$name" 2>&1 | grep -q "ingestion-queue executor started"; do
  i=$((i + 1)); [ $i -gt 300 ] && { docker logs "$name" 2>&1 | tail -30; echo "warm-up did not finish"; exit 1; }
  docker ps -q -f name="$name" | grep -q . || { docker logs "$name" 2>&1 | tail -30; echo "warm-up container exited"; exit 1; }
  sleep 1
done
docker stop -t 30 "$name" >/dev/null
rm -rf "$STAGE/seed" && docker cp -q "$name:/data" "$STAGE/seed" && rm -f "$STAGE/seed/.lite-initialized"
echo "warm-up done in $i s"

docker build -q --build-arg LANGFUSE_TAG="$TAG" -f docker/Dockerfile -t "$IMAGE" "$STAGE" >/dev/null
docker images "$IMAGE" --format '{{.Repository}}:{{.Tag}} {{.Size}}'
echo "built in $(( $(date +%s) - started )) s"
