#!/bin/sh
# Start langfuse-lite: four local stand-ins plus the official, unchanged Langfuse
# web and worker images.
#
#   scripts/start.sh            start, keeping data from earlier runs
#   scripts/start.sh --fresh    delete ./data first
#
# Ports: web 3000, worker 3030, Postgres 5432, ClickHouse HTTP 8123, Redis 6379, S3 9090.
set -eu
cd "$(dirname "$0")/.."
[ "${1:-}" = "--fresh" ] && rm -rf data
mkdir -p data logs
started=$(date +%s)

wait_for() { # name, command
  i=0
  until sh -c "$2" >/dev/null 2>&1; do
    i=$((i + 1)); [ $i -gt 120 ] && { echo "$1 did not start; see logs/"; exit 1; }
    sleep 0.5
  done
  echo "$1 ready after $(( $(date +%s) - started )) s"
}

# PIDs go to logs/*.pid so stop.sh can stop exactly these processes.
node shims/postgres.mjs --data ./data/postgres --migrations ./vendor/prisma-migrations ${POSTGRES_DEBUG:+--debug} > logs/postgres.log 2>&1 &
echo $! > logs/postgres.pid
.venv/bin/python -I shims/clickhouse.py --data ./data/clickhouse --migrations ./vendor/clickhouse/migrations/unclustered > logs/clickhouse.log 2>&1 &
echo $! > logs/clickhouse.pid
redis-server --port 6379 --bind 127.0.0.1 --save "" --appendonly no --requirepass myredissecret > logs/redis.log 2>&1 &
echo $! > logs/redis.pid
.venv/bin/moto_server -H 127.0.0.1 -p 9090 > logs/s3.log 2>&1 &
echo $! > logs/s3.pid

wait_for "postgres" "grep -q listening logs/postgres.log"
wait_for "clickhouse" "curl -sf http://127.0.0.1:8123/ping"
wait_for "redis" "redis-cli -a myredissecret ping"
wait_for "s3" "curl -sf -X PUT http://127.0.0.1:9090/langfuse"

docker rm -f lf-web lf-worker >/dev/null 2>&1 || true
docker run -d --name lf-worker --network host --env-file langfuse-lite.env --env-file worker.env docker.langfuse.com/langfuse/langfuse-worker:4 >/dev/null
docker run -d --name lf-web --network host --env-file langfuse-lite.env docker.langfuse.com/langfuse/langfuse:4 >/dev/null
wait_for "langfuse web" "curl -sf http://127.0.0.1:3000/api/public/health"
echo "langfuse-lite is up: http://localhost:3000 (keys pk-lf-lite / sk-lf-lite)"
