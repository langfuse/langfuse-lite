// SQLite behind one small interface, on Node's built-in node:sqlite (22.13+)
// or Bun's built-in bun:sqlite, so the same code runs on both.

export type Param = string | number | bigint | null | Uint8Array;
export interface Db {
  exec(sql: string): void;
  run(sql: string, ...params: Param[]): { changes: number };
  all<T = Record<string, unknown>>(sql: string, ...params: Param[]): T[];
  get<T = Record<string, unknown>>(sql: string, ...params: Param[]): T | undefined;
  tx<T>(fn: () => T): T;
  close(): void;
}

type Stmt = { run(...p: Param[]): unknown; all(...p: Param[]): unknown[]; get(...p: Param[]): unknown };

export async function openDb(path: string): Promise<Db> {
  let raw: { exec(sql: string): void; prepare(sql: string): Stmt; close(): void };
  let changes: () => number;
  if (typeof (globalThis as { Bun?: unknown }).Bun !== "undefined") {
    const { Database } = await import("bun:sqlite");
    const d = new Database(path, { create: true, strict: true });
    raw = { exec: (s) => d.exec(s), prepare: (s) => d.prepare(s) as unknown as Stmt, close: () => d.close() };
    changes = () => (d.query("SELECT changes() AS n").get() as { n: number }).n;
  } else {
    silenceSqliteWarning();
    const { DatabaseSync } = await import("node:sqlite");
    const d = new DatabaseSync(path);
    raw = { exec: (s) => d.exec(s), prepare: (s) => d.prepare(s) as unknown as Stmt, close: () => d.close() };
    changes = () => (d.prepare("SELECT changes() AS n").get() as { n: number }).n;
  }
  const cache = new Map<string, Stmt>();
  const stmt = (sql: string) => {
    let s = cache.get(sql);
    if (!s) cache.set(sql, (s = raw.prepare(sql)));
    return s;
  };
  let depth = 0;
  const db: Db = {
    exec: (sql) => raw.exec(sql),
    run: (sql, ...p) => {
      stmt(sql).run(...p);
      return { changes: changes() };
    },
    all: <T>(sql: string, ...p: Param[]) => stmt(sql).all(...p) as T[],
    get: <T>(sql: string, ...p: Param[]) => (stmt(sql).get(...p) ?? undefined) as T | undefined,
    tx: (fn) => {
      if (depth > 0) return fn();
      depth++;
      raw.exec("BEGIN IMMEDIATE");
      try {
        const out = fn();
        raw.exec("COMMIT");
        return out;
      } catch (e) {
        raw.exec("ROLLBACK");
        throw e;
      } finally {
        depth--;
      }
    },
    close: () => raw.close(),
  };
  db.exec("PRAGMA journal_mode = WAL; PRAGMA synchronous = NORMAL; PRAGMA busy_timeout = 5000; PRAGMA foreign_keys = ON;");
  return db;
}

// node:sqlite prints an ExperimentalWarning on Node 22; it is noise for a CLI.
function silenceSqliteWarning() {
  const original = process.emitWarning;
  process.emitWarning = ((warning: string | Error, ...rest: unknown[]) => {
    const text = typeof warning === "string" ? warning : warning?.message;
    if (text && text.includes("SQLite")) return;
    return (original as (...a: unknown[]) => void).call(process, warning, ...rest);
  }) as typeof process.emitWarning;
}
