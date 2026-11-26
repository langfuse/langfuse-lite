// Builds dist/cli.js: one ES module for Node 22.13+ (and Bun) with the vendored
// Langfuse code, zod, decimal.js and lossless-json bundled in. No runtime
// dependencies. With --compile, also builds standalone executables (no Node or
// Bun needed) into dist/bin/.
//
//   bun run scripts/build.ts             # dist/cli.js
//   bun run scripts/build.ts --compile   # + dist/bin/langfuse-lite-<os>-<arch>

import { chmodSync, mkdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";

const compile = process.argv.includes("--compile");
const targets = (process.env.TARGETS ?? "bun-linux-x64,bun-linux-arm64,bun-darwin-x64,bun-darwin-arm64,bun-windows-x64")
  .split(",")
  .filter(Boolean);

rmSync("dist", { recursive: true, force: true });
const result = await Bun.build({
  entrypoints: ["src/cli.ts"],
  outdir: "dist",
  target: "node",
  format: "esm",
  minify: { syntax: true, whitespace: true, identifiers: false },
  external: ["bun:sqlite", "node:sqlite"],
});
if (!result.success) {
  for (const log of result.logs) console.error(log);
  process.exit(1);
}
chmodSync("dist/cli.js", 0o755);

// The bundle and the executables contain these; their licenses ship alongside.
const notices: [string, string][] = [
  ["Langfuse (vendor/langfuse: OTel conversion, cost calculation, model prices)", "vendor/LICENSE-langfuse"],
  ["Lucide icons (observation type icons in the viewer)", "vendor/LICENSE-lucide"],
  ["Lodash", "node_modules/lodash/LICENSE"],
  ["zod", "node_modules/zod/LICENSE"],
  ["decimal.js", "node_modules/decimal.js/LICENCE.md"],
  ["lossless-json", "node_modules/lossless-json/LICENSE.md"],
];
writeFileSync(
  "dist/THIRD_PARTY_NOTICES.md",
  "# Third-party notices\n\nlangfuse-lite bundles the following software.\n\n" +
    notices.map(([name, file]) => `## ${name}\n\n${readFileSync(file, "utf8").trim()}\n`).join("\n"),
);
console.log(`dist/cli.js  ${(statSync("dist/cli.js").size / 1024).toFixed(0)} KB`);

if (compile) {
  mkdirSync("dist/bin", { recursive: true });
  for (const target of targets) {
    const name = `langfuse-lite-${target.replace(/^bun-/, "")}${target.includes("windows") ? ".exe" : ""}`;
    const proc = Bun.spawnSync(["bun", "build", "src/cli.ts", "--compile", `--target=${target}`, "--minify-syntax", "--minify-whitespace", `--outfile=dist/bin/${name}`], {
      stdout: "inherit",
      stderr: "inherit",
    });
    if (proc.exitCode !== 0) process.exit(proc.exitCode ?? 1);
    console.log(`dist/bin/${name}  ${(statSync(`dist/bin/${name}`).size / 1024 / 1024).toFixed(0)} MB`);
  }
}
