#!/bin/sh
# Stop langfuse-lite. Data in ./data is kept.
cd "$(dirname "$0")/.."
docker rm -f lf-web lf-worker >/dev/null 2>&1
for f in logs/*.pid; do
  [ -f "$f" ] && kill "$(cat "$f")" 2>/dev/null
  rm -f "$f"
done
echo "stopped"
