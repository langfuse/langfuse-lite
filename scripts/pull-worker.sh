#!/bin/sh
# Docker Hub rate-limits anonymous pulls; retry with backoff.
for wait in 60 120 240 480 900 900; do
  docker pull docker.langfuse.com/langfuse/langfuse-worker:4 && exit 0
  sleep $wait
done
exit 1
