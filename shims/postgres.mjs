// Postgres stand-in: PGlite (Postgres compiled to WebAssembly) behind the
// Postgres wire protocol, so Langfuse web and worker connect with an ordinary
// DATABASE_URL and need no code changes.
//
//   node shims/postgres.mjs --data ./data/postgres --migrations ./vendor/prisma-migrations --port 5432
//
// On start it applies any Prisma migrations not applied yet (tracked in
// _lite_migrations). PGlite has one connection, so CREATE INDEX CONCURRENTLY
// is rewritten to a plain CREATE INDEX; that is safe on a single-user database.
import fs from "node:fs";
import path from "node:path";
import { parseArgs } from "node:util";
import { PGlite } from "@electric-sql/pglite";
import { PGLiteSocketServer } from "@electric-sql/pglite-socket";

const { values: args } = parseArgs({
  options: {
    data: { type: "string", default: "./data/postgres" },
    migrations: { type: "string", default: "./vendor/prisma-migrations" },
    host: { type: "string", default: "127.0.0.1" },
    port: { type: "string", default: "5432" },
    "max-connections": { type: "string", default: "50" },
  },
});

const t0 = performance.now();
fs.mkdirSync(args.data, { recursive: true });
const db = new PGlite(args.data);
await db.waitReady;

await db.exec(`CREATE TABLE IF NOT EXISTS _lite_migrations (name text PRIMARY KEY, applied_at timestamptz DEFAULT now())`);
const applied = new Set((await db.query("SELECT name FROM _lite_migrations")).rows.map((r) => r.name));
const pending = fs
  .readdirSync(args.migrations)
  .filter((d) => fs.existsSync(path.join(args.migrations, d, "migration.sql")) && !applied.has(d))
  .sort();
for (const name of pending) {
  const sql = fs.readFileSync(path.join(args.migrations, name, "migration.sql"), "utf8").replace(/\bCONCURRENTLY\b/gi, "");
  try {
    await db.exec(sql);
  } catch (err) {
    console.error(`postgres: migration ${name} failed: ${err.message}`);
    process.exit(1);
  }
  await db.query("INSERT INTO _lite_migrations (name) VALUES ($1)", [name]);
}
console.log(`postgres: ${pending.length} migrations applied, ${applied.size} already present (${Math.round(performance.now() - t0)} ms)`);

const server = new PGLiteSocketServer({
  db,
  host: args.host,
  port: Number(args.port),
  maxConnections: Number(args["max-connections"]),
});
await server.start();
console.log(`postgres: listening on ${args.host}:${args.port}`);

const stop = async () => {
  await server.stop();
  await db.close();
  process.exit(0);
};
process.on("SIGINT", stop);
process.on("SIGTERM", stop);
