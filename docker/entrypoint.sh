#!/bin/sh
# langfuse-lite container entrypoint: four stand-ins, then Langfuse worker and web.
# Settings come from /opt/lite/lite.env; anything passed with `docker run -e` wins.
set -eu
LITE=/opt/lite
DATA="${LITE_DATA:-/data}"
cd /app

# Defaults for every setting not already in the environment.
while IFS= read -r line; do
  case "$line" in ''|\#*) continue ;; esac
  key="${line%%=*}"
  eval "is_set=\${$key+x}"
  [ -n "$is_set" ] || export "$line"
done < "$LITE/lite.env"

# First start: copy the pre-migrated database snapshot.
if [ ! -f "$DATA/.lite-initialized" ]; then
  mkdir -p "$DATA"
  cp -a "$LITE/seed/." "$DATA/"
  touch "$DATA/.lite-initialized"
fi

export PYTHONPATH="$LITE/site-packages"
PY="$LITE/python/bin/python3.12"
stand_ins="" apps=""
run() { "$@" & pids="${pids:-} $!"; }

# dumb-init runs with --single-child, so SIGTERM reaches only this script.
# Langfuse web and worker hold no state but wait up to 110 s to drain
# connections, so they get LITE_STOP_GRACE seconds; then the stand-ins stop
# cleanly so PGlite and chDB close their files.
stopping=""
alive() { for pid in "$@"; do kill -0 "$pid" 2>/dev/null && return 0; done; return 1; }
stop() {
  [ -z "$stopping" ] || return 0
  stopping=1
  if [ -n "$apps" ]; then
    kill -TERM $apps 2>/dev/null || true
    i=0
    while alive $apps && [ $i -lt $((${LITE_STOP_GRACE:-3} * 10)) ]; do sleep 0.1; i=$((i + 1)); done
    kill -KILL $apps 2>/dev/null || true
  fi
  kill -TERM $stand_ins 2>/dev/null || true
  for pid in $stand_ins; do wait "$pid" 2>/dev/null || true; done
  echo "lite: stopped"
  exit 0
}
trap stop TERM INT

run "$LITE/bin/redis-server" --port 6379 --bind 127.0.0.1 --save "" --appendonly no \
    --requirepass "$REDIS_AUTH" --loglevel warning
run "$PY" -m moto.server -H 127.0.0.1 -p 9090
run node "$LITE/shims/postgres.mjs" --data "$DATA/postgres" \
    --migrations /app/packages/shared/prisma/migrations
run "$PY" "$LITE/shims/clickhouse.py" --data "$DATA/clickhouse" \
    --migrations /app/packages/shared/clickhouse/migrations/unclustered
stand_ins="$pids" pids=""

wait_port() { # port, name
  i=0
  until node -e "require('net').connect($1,'127.0.0.1').on('connect',()=>process.exit(0)).on('error',()=>process.exit(1))" 2>/dev/null; do
    i=$((i + 1)); [ $i -gt 120 ] && { echo "lite: $2 did not start"; exit 1; }
    sleep 0.25
  done
}
wait_port 6379 redis
wait_port 9090 s3
wait_port 5432 postgres
wait_port 8123 clickhouse
wget -q -O /dev/null --method=PUT "http://127.0.0.1:9090/$LANGFUSE_S3_EVENT_UPLOAD_BUCKET" || true
echo "lite: stand-ins ready"

# Docker sets HOSTNAME to the container id and the web image sets PORT=3000:
# pin both so the worker and web never compete for the same address.
run env HOSTNAME=127.0.0.1 PORT=3030 node worker/dist/index.js
run env HOSTNAME=0.0.0.0 PORT=3000 node ./web/server.js --keepAliveTimeout 110000
apps="$pids"

# Stop everything when any process exits on its own.
while :; do
  for pid in $stand_ins $apps; do
    kill -0 "$pid" 2>/dev/null || { [ -n "$stopping" ] || echo "lite: process $pid exited"; stop; }
  done
  sleep 1 & wait $! || true
done
