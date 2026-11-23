// Starts the API on Bun.serve when running under Bun, otherwise on node:http
// with a small Request/Response bridge.

import { handle, type HandleOptions } from "./api";
import type { Db } from "./db";
import { MAX_BODY_BYTES, SCALE_HINT } from "./limits";

export type Server = { url: string; port: number; stop(): Promise<void> };

// handle() answers oversized bodies with a 413 and the scaling hint; the runtimes'
// own limits sit above that so the hint is what clients see.
const MAX_BODY = MAX_BODY_BYTES * 2;

export const isLoopback = (host: string) => host === "localhost" || host === "::1" || host === "[::1]" || /^127\./.test(host);

export async function serve(db: Db, opts: { host: string; port: number }): Promise<Server> {
  const Bun = (globalThis as { Bun?: any }).Bun;
  const handleOpts: HandleOptions = { localOnly: isLoopback(opts.host) };
  const urlHost = opts.host.includes(":") && !opts.host.startsWith("[") ? `[${opts.host}]` : opts.host;
  if (Bun) {
    const s = Bun.serve({
      hostname: opts.host,
      port: opts.port,
      maxRequestBodySize: MAX_BODY,
      fetch: (req: Request) => handle(db, req, handleOpts),
    });
    return { url: `http://${urlHost}:${s.port}`, port: s.port, stop: async () => s.stop(true) };
  }
  const http = await import("node:http");
  const server = http.createServer(async (req, res) => {
    try {
      const chunks: Buffer[] = [];
      let size = 0;
      for await (const chunk of req) {
        size += (chunk as Buffer).length;
        if (size > MAX_BODY) {
          res.writeHead(413, { "content-type": "application/json" });
          res.end(JSON.stringify({ message: `Request body too large. ${SCALE_HINT}`, error: "PayloadTooLarge" }));
          return;
        }
        chunks.push(chunk as Buffer);
      }
      const headers = new Headers();
      for (const [k, v] of Object.entries(req.headers))
        if (v !== undefined) headers.set(k, Array.isArray(v) ? v.join(", ") : v);
      const method = req.method ?? "GET";
      const request = new Request(`http://${req.headers.host ?? "localhost"}${req.url ?? "/"}`, {
        method,
        headers,
        body: method === "GET" || method === "HEAD" ? undefined : Buffer.concat(chunks),
      });
      const response = await handle(db, request, handleOpts);
      const out: Record<string, string> = {};
      response.headers.forEach((v, k) => (out[k] = v));
      res.writeHead(response.status, out);
      res.end(Buffer.from(await response.arrayBuffer()));
    } catch (e) {
      res.writeHead(500, { "content-type": "application/json" });
      res.end(JSON.stringify({ message: String(e), error: "InternalServerError" }));
    }
  });
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(opts.port, opts.host, () => resolve());
  });
  const port = (server.address() as { port: number }).port;
  return {
    url: `http://${urlHost}:${port}`,
    port,
    // Idle keep-alive connections (an open viewer tab) would otherwise hold the process for seconds.
    stop: () =>
      new Promise((resolve) => {
        server.close(() => resolve());
        server.closeAllConnections();
      }),
  };
}
