// Postgres stand-in: PGlite (Postgres compiled to WebAssembly) behind the
// Postgres wire protocol, so Langfuse web and worker connect with an ordinary
// DATABASE_URL and need no code changes.
//
//   node shims/postgres.mjs --data ./data/postgres --migrations ./vendor/prisma-migrations --port 5432
//
// PGlite is one Postgres session. Many client connections share it, so this
// server queues each connection's protocol messages as a unit up to the next
// Sync (or simple Query / Flush), the point where Postgres treats a request as
// complete. While a connection is inside a transaction, only that connection's
// requests run. Clients must not use named prepared statements, which would
// collide across connections: Prisma's `pgbouncer=true` turns them off.
//
// On start it applies any Prisma migrations not applied yet (tracked in
// _lite_migrations). CREATE INDEX CONCURRENTLY is rewritten to a plain CREATE
// INDEX; that is safe on a single-user database.
import fs from "node:fs";
import net from "node:net";
import path from "node:path";
import { parseArgs } from "node:util";
import { PGlite } from "@electric-sql/pglite";

const { values: args } = parseArgs({
  options: {
    data: { type: "string", default: "./data/postgres" },
    migrations: { type: "string", default: "./vendor/prisma-migrations" },
    host: { type: "string", default: "127.0.0.1" },
    port: { type: "string", default: "5432" },
    debug: { type: "boolean", default: false },
    "migrate-only": { type: "boolean", default: false },
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
if (args["migrate-only"]) {
  await db.close();
  process.exit(0);
}

// ---------------------------------------------------------------- scheduling

const queue = []; // { conn, bytes, done }
let running = false;
let owner = null; // connection whose transaction is open
let ownerSince = 0;
let stallReported = 0;

// The SQL text of the first Query or Parse message in a request, for logs.
function sqlOf(bytes) {
  for (let i = 0; i + 5 <= bytes.length; ) {
    const type = bytes[i], len = bytes.readInt32BE(i + 1);
    const body = bytes.subarray(i + 5, i + 1 + len);
    if (type === 0x51) return body.toString("utf8", 0, Math.min(body.length, 200)).replace(/\0/g, "");
    if (type === 0x50) {
      const nameEnd = body.indexOf(0);
      return body.toString("utf8", nameEnd + 1, Math.min(body.length, nameEnd + 201)).replace(/\0.*$/s, "");
    }
    i += 1 + len;
  }
  return "";
}

function enqueue(conn, bytes) {
  return new Promise((resolve, reject) => {
    queue.push({ conn, bytes, resolve, reject });
    drain();
  });
}

async function drain() {
  if (running) return;
  running = true;
  try {
    while (queue.length) {
      const i = owner ? queue.findIndex((q) => q.conn === owner) : 0;
      if (i === -1) {
        // Wait for the transaction owner's next request.
        const waited = Date.now() - ownerSince;
        if (args.debug && waited > 2000 && Date.now() - stallReported > 2000) {
          stallReported = Date.now();
          console.log(`postgres: ${queue.length} requests waiting ${waited} ms on a transaction; it last ran: ${owner.lastSql}`);
          setTimeout(drain, 2100);
        }
        break;
      }
      const job = queue.splice(i, 1)[0];
      try {
        await db.runExclusive(() =>
          db.execProtocolRawStream(job.bytes, { onRawData: (chunk) => job.conn.write(Buffer.from(chunk)) }),
        );
        job.resolve();
      } catch (err) {
        job.reject(err);
      }
      job.conn.lastSql = sqlOf(job.bytes) || job.conn.lastSql;
      const nextOwner = db.isInTransaction() ? job.conn : null;
      if (nextOwner && nextOwner !== owner) ownerSince = Date.now();
      owner = nextOwner;
    }
  } finally {
    running = false;
  }
}

// ---------------------------------------------------------------- connections

const BOUNDARY = new Set([0x53 /* S Sync */, 0x51 /* Q Query */, 0x48 /* H Flush */]);
const TERMINATE = 0x58; // X

const server = net.createServer((socket) => {
  let buffer = Buffer.alloc(0);
  let pending = [];
  let started = false;
  let chain = Promise.resolve();
  const conn = { write: (b) => socket.writable && socket.write(b) };

  const send = (bytes) => {
    chain = chain.then(() => enqueue(conn, bytes)).catch((err) => {
      if (args.debug) console.error("postgres: request failed", err);
      socket.destroy();
    });
  };

  socket.on("data", (data) => {
    buffer = Buffer.concat([buffer, data]);
    for (;;) {
      if (!started) {
        if (buffer.length < 8) return;
        const len = buffer.readInt32BE(0);
        const code = buffer.readInt32BE(4);
        if (buffer.length < len) return;
        const msg = buffer.subarray(0, len);
        buffer = buffer.subarray(len);
        if (code === 80877103 || code === 80877104) {
          socket.write("N"); // SSL / GSS encryption not supported
          continue;
        }
        if (code === 80877102) { socket.end(); return; } // CancelRequest: unsupported
        started = true;
        send(Buffer.from(msg));
        continue;
      }
      if (buffer.length < 5) return;
      const len = 1 + buffer.readInt32BE(1);
      if (buffer.length < len) return;
      const type = buffer[0];
      const msg = buffer.subarray(0, len);
      buffer = buffer.subarray(len);
      if (type === TERMINATE) {
        pending = [];
        socket.end();
        return;
      }
      pending.push(Buffer.from(msg));
      if (BOUNDARY.has(type)) {
        send(Buffer.concat(pending));
        pending = [];
      }
    }
  });

  const close = () => {
    // A connection that disappears inside a transaction must not block everyone else.
    if (owner === conn) {
      chain = chain.then(() => enqueue(conn, Buffer.from("Q\0\0\0\x0dROLLBACK\0", "binary"))).catch(() => {});
    }
  };
  socket.on("close", close);
  socket.on("error", () => socket.destroy());
});

server.listen(Number(args.port), args.host, () => console.log(`postgres: listening on ${args.host}:${args.port}`));

const stop = async () => {
  server.close();
  await db.close();
  process.exit(0);
};
process.on("SIGINT", stop);
process.on("SIGTERM", stop);
