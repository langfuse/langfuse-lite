// Anonymous usage telemetry, so we can tell whether langfuse-lite is used at all.
// Counts and versions only: never trace content, names, ids, paths or host names.
// Sent to PostHog (EU), like self-hosted Langfuse's telemetry. Off with
// TELEMETRY_ENABLED=false or DO_NOT_TRACK=1, and always off in CI.
//
// Events, not a fixed interval: lite runs in short agent sessions that are
// usually killed, not shut down.
//   langfuse_lite:serve_started  at start, with the totals already in the database
//                                (this is how a killed session's result is reported)
//   langfuse_lite:first_data     once per session, shortly after the first trace arrives
//   langfuse_lite:heartbeat      hourly while new data keeps arriving
//   langfuse_lite:push           after a push to a full Langfuse

import type { Db } from "./db";
import { LANGFUSE_VERSION } from "./langfuse";
import pkg from "../package.json" with { type: "json" };

/** PostHog project API key: public and write-only, the same project self-hosted
 * Langfuse reports to. Empty: telemetry is off. */
export const POSTHOG_KEY: string = "phc_zkMwFajk8ehObUlMth0D7DtPItFnxETi3lmSvyQDrwB";
const DEFAULT_URL = "https://eu.i.posthog.com/capture/";

const FIRST_DATA_DELAY_MS = 60_000;
const HEARTBEAT_MS = 60 * 60_000;
const SEND_TIMEOUT_MS = 3000;

const off = (v: string | undefined) => v !== undefined && ["false", "0", "off", "no"].includes(v.trim().toLowerCase());
const on = (v: string | undefined) => v !== undefined && v.trim() !== "" && !off(v);

type Env = Record<string, string | undefined>;
const apiKey = (env: Env) => env.LANGFUSE_LITE_TELEMETRY_KEY ?? POSTHOG_KEY;

export function telemetryEnabled(env: Env = process.env): boolean {
  if (!apiKey(env)) return false;
  if (off(env.TELEMETRY_ENABLED) || on(env.DO_NOT_TRACK) || on(env.CI)) return false;
  return true;
}

/** A random id per database, so distinct databases can be counted without identifying anyone. */
function installId(db: Db): string {
  const stored = db.get<{ value: string }>("SELECT value FROM lite_meta WHERE key = 'telemetry_id'")?.value;
  if (stored) return stored;
  const id = crypto.randomUUID();
  db.run("INSERT OR REPLACE INTO lite_meta (key, value) VALUES ('telemetry_id', ?)", id);
  return id;
}

/** Counts only. SDK names and versions come from the SDK's own headers. */
export function usageTotals(db: Db) {
  const n = (sql: string) => db.get<{ n: number }>(sql)?.n ?? 0;
  return {
    observations: n("SELECT COUNT(*) AS n FROM observations"),
    traces: n("SELECT COUNT(DISTINCT trace_id) AS n FROM observations"),
    scores: n("SELECT COUNT(*) AS n FROM scores"),
    datasets: n("SELECT COUNT(*) AS n FROM datasets"),
    dataset_items: n("SELECT COUNT(*) AS n FROM dataset_items"),
    experiment_runs: n("SELECT COUNT(DISTINCT experiment_id) AS n FROM observations WHERE experiment_id IS NOT NULL"),
    otlp_requests: n("SELECT COUNT(*) AS n FROM otlp_requests"),
    otlp_requests_pushed: n("SELECT COUNT(*) AS n FROM otlp_requests WHERE pushed_at IS NOT NULL"),
    sdks: db
      .all<{ sdk: string }>(
        `SELECT DISTINCT ingestion_sdk_name || '@' || COALESCE(ingestion_sdk_version, '?') AS sdk
         FROM observations WHERE ingestion_sdk_name IS NOT NULL LIMIT 20`,
      )
      .map((r) => r.sdk),
  };
}

function runtime() {
  const g = globalThis as { Bun?: { version: string } };
  return {
    lite_version: pkg.version,
    langfuse_version: LANGFUSE_VERSION,
    runtime: g.Bun ? "bun" : "node",
    runtime_version: g.Bun ? g.Bun.version : process.versions.node,
    os: process.platform,
    arch: process.arch,
  };
}

/** The proxy to use for a URL, from the usual environment variables, or null. */
export function proxyFor(target: URL, env: Env = process.env): URL | null {
  const raw = target.protocol === "https:" ? (env.HTTPS_PROXY ?? env.https_proxy) : (env.HTTP_PROXY ?? env.http_proxy);
  if (!raw) return null;
  const host = target.hostname.toLowerCase();
  for (const entry of (env.NO_PROXY ?? env.no_proxy ?? "").split(",")) {
    const rule = entry.trim().toLowerCase().replace(/^\*?\./, "").replace(/:\d+$/, "");
    if (rule && (rule === "*" || host === rule || host.endsWith("." + rule))) return null;
  }
  try {
    const proxy = new URL(raw.includes("://") ? raw : `http://${raw}`);
    return proxy.protocol === "http:" ? proxy : null; // other proxy types: fall back to a direct request
  } catch {
    return null;
  }
}

/** POSTs JSON through an HTTP proxy. Node's fetch ignores HTTPS_PROXY (Bun's does not),
 * and sandboxed agents, the users we most want to count, usually sit behind one.
 * https targets go through a CONNECT tunnel, http targets as a plain proxy request. */
export async function postViaProxy(target: URL, proxy: URL, body: string, timeoutMs = SEND_TIMEOUT_MS): Promise<boolean> {
  const http = await import("node:http");
  const tls = await import("node:tls");
  const auth = proxy.username
    ? { "proxy-authorization": "Basic " + btoa(`${decodeURIComponent(proxy.username)}:${decodeURIComponent(proxy.password)}`) }
    : {};
  const proxyAt = { host: proxy.hostname, port: Number(proxy.port) || 80 };
  const headers = { "content-type": "application/json", "content-length": String(Buffer.byteLength(body)) };
  return new Promise<boolean>((resolve) => {
    const open: { destroy(): void }[] = [];
    let settled = false;
    const done = (ok: boolean) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      for (const o of open) o.destroy();
      resolve(ok);
    };
    const timer = setTimeout(() => done(false), timeoutMs);
    const send = (options: Record<string, unknown>) => {
      const req = http.request({ method: "POST", agent: false, ...options }, (res) => {
        res.resume();
        res.on("end", () => done((res.statusCode ?? 500) < 300));
      });
      open.push(req);
      req.on("error", () => done(false));
      req.end(body);
    };
    if (target.protocol !== "https:") {
      send({ ...proxyAt, path: target.href, headers: { ...headers, ...auth, host: target.host } });
      return;
    }
    const authority = `${target.hostname}:${target.port || 443}`;
    const connect = http.request({ ...proxyAt, method: "CONNECT", path: authority, headers: { host: authority, ...auth }, agent: false });
    open.push(connect);
    connect.on("error", () => done(false));
    connect.on("connect", (res, socket) => {
      open.push(socket);
      if (res.statusCode !== 200) return done(false);
      const secure = tls.connect({ socket, servername: target.hostname });
      open.push(secure);
      secure.on("error", () => done(false));
      // One request on the tunnel, written by hand: http.request would look the host up again.
      let head = "";
      secure.on("data", (chunk: Buffer) => {
        head += chunk.toString("latin1");
        const status = /^HTTP\/1\.[01] (\d{3})/.exec(head);
        if (status) done(Number(status[1]) < 300);
        else if (head.length > 64) done(false);
      });
      secure.on("end", () => done(false));
      secure.write(
        `POST ${target.pathname}${target.search} HTTP/1.1\r\nhost: ${target.host}\r\n` +
          `content-type: application/json\r\ncontent-length: ${Buffer.byteLength(body)}\r\nconnection: close\r\n\r\n${body}`,
      );
    });
    connect.end();
  });
}

/** Sends one event; never throws and never takes longer than the timeout. */
export async function capture(db: Db, event: string, properties: Record<string, unknown> = {}, env: Env = process.env): Promise<boolean> {
  if (!telemetryEnabled(env)) return false;
  try {
    const url = new URL(env.LANGFUSE_LITE_TELEMETRY_URL ?? DEFAULT_URL);
    const body = JSON.stringify({
      api_key: apiKey(env),
      event,
      distinct_id: installId(db),
      timestamp: new Date().toISOString(),
      // No person profile and no location lookup: the events are anonymous counts.
      properties: { ...runtime(), ...properties, $process_person_profile: false, $geoip_disable: true },
    });
    const proxy = (globalThis as { Bun?: unknown }).Bun ? null : proxyFor(url, env);
    if (proxy) return await postViaProxy(url, proxy, body);
    const res = await fetch(url, {
      method: "POST",
      headers: { "content-type": "application/json" },
      signal: AbortSignal.timeout(SEND_TIMEOUT_MS),
      body,
    });
    return res.ok;
  } catch {
    return false; // offline, sandboxed, blocked: telemetry must never get in the way
  }
}

const lastRequestId = (db: Db) => db.get<{ id: number | null }>("SELECT MAX(id) AS id FROM otlp_requests")?.id ?? 0;

/** Telemetry for a running server. Returns a function that stops it. */
export function startServeTelemetry(db: Db, opts: { loopback: boolean; firstDataDelayMs?: number; heartbeatMs?: number }, env: Env = process.env): () => void {
  if (!telemetryEnabled(env)) return () => {};
  void capture(db, "langfuse_lite:serve_started", { ...usageTotals(db), loopback: opts.loopback }, env);
  const atStart = lastRequestId(db);
  let reported = atStart;
  let sentFirst = false;
  const firstDelay = opts.firstDataDelayMs ?? FIRST_DATA_DELAY_MS;
  const check = setInterval(() => {
    try {
      if (sentFirst || lastRequestId(db) === atStart) return;
      sentFirst = true;
      reported = lastRequestId(db);
      void capture(db, "langfuse_lite:first_data", usageTotals(db), env);
    } catch {
      // a busy database is no reason to disturb the server
    }
  }, firstDelay);
  const heartbeat = setInterval(() => {
    try {
      const latest = lastRequestId(db);
      if (latest === reported) return;
      reported = latest;
      void capture(db, "langfuse_lite:heartbeat", usageTotals(db), env);
    } catch {
      // as above
    }
  }, opts.heartbeatMs ?? HEARTBEAT_MS);
  // Never keep the process alive for telemetry.
  check.unref?.();
  heartbeat.unref?.();
  return () => {
    clearInterval(check);
    clearInterval(heartbeat);
  };
}

/** After a push: what was moved, and whether the target was Langfuse Cloud (never the host itself). */
export function capturePush(db: Db, target: string, report: { datasets: number; datasetItems: number; spans: number; scores: number }, env: Env = process.env) {
  let cloud = false;
  try {
    cloud = /(^|\.)langfuse\.com$/.test(new URL(target).hostname);
  } catch {
    // not a URL
  }
  return capture(db, "langfuse_lite:push", {
    to_langfuse_cloud: cloud, datasets: report.datasets, dataset_items: report.datasetItems, spans: report.spans, scores: report.scores,
  }, env);
}

export const TELEMETRY_NOTICE =
  "Telemetry: anonymous usage counts (no trace content) are sent to Langfuse. Turn off with TELEMETRY_ENABLED=false.";
