#!/bin/sh
# Vendor Langfuse's OTel span → observation conversion, cost calculation and
# default model prices from the official worker image (MIT-licensed code outside `ee/`).
#
#   scripts/vendor-langfuse.sh            # from docker.langfuse.com/langfuse/langfuse-worker:4
#   LANGFUSE_IMAGE_TAG=4.84.0 scripts/vendor-langfuse.sh
#
# Copies @langfuse/shared's compiled dist into a scratch tree, replaces the
# entry points that pull in Redis, ClickHouse, S3, env parsing and logging with
# the small files in vendor/shims/, bundles a probe that imports the
# processor, and keeps only the files that bundle actually reaches.
# Result: vendor/langfuse/ (committed). Needs docker and bun.
set -eu
cd "$(dirname "$0")/.."
TAG="${LANGFUSE_IMAGE_TAG:-4}"
IMAGE="docker.langfuse.com/langfuse/langfuse-worker:$TAG"
SHARED='/app/worker/node_modules/.pnpm/@langfuse+shared@file++++app+packages+shared/node_modules/@langfuse/shared'
work=$(mktemp -d)
trap 'rm -rf "$work"; [ -n "${cid:-}" ] && docker rm "$cid" >/dev/null 2>&1 || true' EXIT

cid=$(docker create "$IMAGE")
docker cp -q "$cid:$SHARED/dist/src" "$work/src"
docker cp -q "$cid:/app/worker/dist/constants/default-model-prices.json" "$work/default-model-prices.json"
docker cp -q "$cid:/app/worker/package.json" "$work/worker-package.json"
version=$(docker run --rm --entrypoint sh "$IMAGE" -c 'cat /app/packages/shared/package.json 2>/dev/null || cat /app/worker/package.json' |
  sed -n 's/.*"version": *"\([^"]*\)".*/\1/p' | head -1)

cp -R vendor/shims/. "$work/src/"
cat > "$work/probe.js" <<'EOF'
const { OtelIngestionProcessor } = require("./src/server/otel/OtelIngestionProcessor");
const { calculateModelUsageCosts } = require("./src/server/pricing-tiers/calculateModelUsageCosts");
const { flattenJsonToPathArrays } = require("./src/server/otel/utils");
module.exports = { OtelIngestionProcessor, calculateModelUsageCosts, flattenJsonToPathArrays };
EOF
ln -s "$PWD/node_modules" "$work/node_modules"
bun build "$work/probe.js" --target node --format cjs --outfile "$work/probe.out.js" --metafile="$work/meta.json" \
  --external=zod --external="zod/*" --external="lodash/*" --external=lossless-json >/dev/null

rm -rf vendor/langfuse && mkdir -p vendor/langfuse
node -e '
const meta = require(process.argv[1]);
for (const p of Object.keys(meta.inputs)) if (p.includes("/src/")) console.log(p.slice(p.indexOf("/src/") + 1));
' "$work/meta.json" | sort > "$work/files.txt"
(cd "$work" && tar -cf - -T files.txt) | (cd vendor/langfuse && tar -xf -)
cp "$work/default-model-prices.json" vendor/langfuse/
echo '{ "type": "commonjs" }' > vendor/langfuse/package.json
cat > vendor/langfuse/VENDORED.md <<EOF
# Vendored from Langfuse

Compiled files from \`@langfuse/shared\` (packages/shared, MIT license) and the
worker's \`default-model-prices.json\`, taken from \`$IMAGE\`
(Langfuse $version) by \`scripts/vendor-langfuse.sh\`. Do not edit by hand:
re-run the script for a new Langfuse version.

Files under \`src/\` are unchanged, except the entry points listed in
\`../shims/\`, which replace Langfuse's versions so that nothing pulls in
Redis, ClickHouse, S3, env parsing or logging.

Langfuse: https://github.com/langfuse/langfuse. None of the vendored files are
under an \`ee/\` folder, so all are MIT-licensed; the license text is in
\`../LICENSE-langfuse\` (the image does not contain it).
EOF
echo "$version" > vendor/langfuse/LANGFUSE_VERSION
echo "vendored $(wc -l < "$work/files.txt") files from Langfuse $version: $(du -sh vendor/langfuse | cut -f1)"
