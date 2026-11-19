#!/bin/sh
# Stop langfuse-lite. Data in ./data is kept.
docker rm -f lf-web lf-worker >/dev/null 2>&1
pkill -f "shims/postgres.mjs" 2>/dev/null
pkill -f "shims/clickhouse.py" 2>/dev/null
pkill -f "moto_server -H 127.0.0.1 -p 9090" 2>/dev/null
redis-cli -a myredissecret shutdown nosave >/dev/null 2>&1
echo "stopped"
