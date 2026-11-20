"""ClickHouse stand-in: chDB (embedded ClickHouse) behind ClickHouse's HTTP interface.

Langfuse talks to ClickHouse through @clickhouse/client over HTTP. This server
accepts the same requests and runs them in an in-process chDB session, so web
and worker need no code changes:

    python shims/clickhouse.py --data ./data/clickhouse --migrations ./vendor/clickhouse/migrations/unclustered

Covered: GET /ping; POST queries with the SQL in the body or in ?query=;
inserts (?query=INSERT ... FORMAT X with the rows in the body); typed query
parameters (?param_<name>=); ClickHouse settings as URL parameters; gzip request
and response bodies; ClickHouse-style errors. chDB runs one query at a time, so
requests are serialized.

On start it applies any ClickHouse migrations not applied yet (tracked in
_lite_migrations). Langfuse runs those with golang-migrate over the native
protocol, which this server does not speak.
"""

from __future__ import annotations

import argparse
import asyncio
import email.parser
import email.policy
import gzip
import json
import re
import time
import uuid
from pathlib import Path

from aiohttp import web
from chdb import session as chdb_session

# Parameters that configure the HTTP exchange, not the query.
HTTP_ONLY = {
    "query", "query_id", "database", "default_format", "user", "password", "session_id", "session_timeout",
    "session_check", "compress", "decompress", "buffer_size", "wait_end_of_query", "enable_http_compression",
    "send_progress_in_http_headers", "http_headers_progress_interval_ms", "http_zlib_compression_level",
}
NUMBER = re.compile(r"^-?[0-9.]+$")
ERROR_CODE = re.compile(r"Code:\s*(\d+)")


class ClickHouse:
    def __init__(self, data: str):
        self.session = chdb_session.Session(data)
        self.lock = asyncio.Lock()
        self.applied_settings: dict[str, str] = {}   # settings this session currently has changed
        self.original_settings: dict[str, str] = {}  # their values before the first change
        self.unsupported_settings: set[str] = set()

    def run(self, sql: str, params: dict[str, str] | None = None) -> bytes:
        result = self.session.query(sql, "TabSeparated", params=params or None)
        return result.bytes() if hasattr(result, "bytes") else str(result).encode()

    def _set(self, key: str, value: str) -> bool:
        literal = value if NUMBER.match(value) else "'" + value.replace("\\", "\\\\").replace("'", "\\'") + "'"
        try:
            self.run(f"SET {key} = {literal}")
            return True
        except Exception as exc:  # noqa: BLE001 - an unknown setting must not fail the query
            self.unsupported_settings.add(key)
            print(f"clickhouse: ignoring setting {key}={value}: {str(exc)[:120]}", flush=True)
            return False

    def apply_settings(self, settings: dict[str, str]) -> None:
        """Make the session's settings match this request's.

        SET lasts for the whole chDB session, so a setting one request sends would
        leak into later requests. Settings the previous request changed and this
        one doesn't send are restored to their original values first.
        """
        for key in list(self.applied_settings):
            if key not in settings:
                self._set(key, self.original_settings[key])
                del self.applied_settings[key]
        for key, value in settings.items():
            if key in self.unsupported_settings or self.applied_settings.get(key) == value:
                continue
            if key not in self.original_settings:
                rows = self.run(f"SELECT value FROM system.settings WHERE name = '{key}'").decode().splitlines()
                if not rows:
                    self.unsupported_settings.add(key)
                    print(f"clickhouse: ignoring unknown setting {key}={value}", flush=True)
                    continue
                self.original_settings[key] = rows[0]
            if self._set(key, value):
                self.applied_settings[key] = value

    def migrate(self, directory: Path) -> None:
        started = time.monotonic()
        self.run("CREATE TABLE IF NOT EXISTS default._lite_migrations (name String) ENGINE = MergeTree ORDER BY name")
        done = set(self.run("SELECT name FROM default._lite_migrations").decode().split())
        pending = sorted(p for p in directory.glob("*.up.sql") if p.name not in done)
        for path in pending:
            for statement in re.split(r";\s*(?:\n|$)", path.read_text()):
                if statement.strip() and not all(line.strip().startswith("--") or not line.strip()
                                                 for line in statement.splitlines()):
                    try:
                        self.run(statement)
                    except Exception as exc:
                        raise SystemExit(f"clickhouse: migration {path.name} failed: {exc}") from exc
            self.run("INSERT INTO default._lite_migrations VALUES ({n:String})", {"n": path.name})
        print(f"clickhouse: {len(pending)} migrations applied, {len(done)} already present "
              f"({round((time.monotonic() - started) * 1000)} ms)", flush=True)


def form_fields(content_type: str, body: bytes) -> dict[str, str]:
    """Fields of a multipart/form-data body; the client sends parameterized queries this way."""
    message = email.parser.BytesParser(policy=email.policy.HTTP).parsebytes(
        f"Content-Type: {content_type}\r\n\r\n".encode() + body)
    fields = {}
    for part in message.iter_parts():
        name = part.get_param("name", header="content-disposition")
        if name:
            fields[name] = part.get_payload(decode=True).decode()
    return fields


def error_response(exc: Exception) -> web.Response:
    message = str(exc)
    code = ERROR_CODE.search(message)
    if not message.startswith("Code:"):
        message = f"Code: {code.group(1) if code else 1000}. DB::Exception: {message}"
    return web.Response(status=500, text=message + "\n",
                        headers={"X-ClickHouse-Exception-Code": code.group(1) if code else "1000"})


def make_app(ch: ClickHouse, log_queries: bool = False) -> web.Application:
    async def handle(req: web.Request) -> web.StreamResponse:
        if req.path in ("/ping", "/"):
            if req.method == "GET" and not req.query.get("query"):
                return web.Response(text="Ok.\n")
        body = await req.read()
        if req.headers.get("Content-Encoding", "").lower() == "gzip":
            body = gzip.decompress(body)
        fields = dict(req.query)
        content_type = req.headers.get("Content-Type", "")
        if content_type.startswith("multipart/form-data"):
            fields.update(form_fields(content_type, body))
            body = b""
        query_param = fields.get("query")
        # Inserts put the statement in ?query= and the rows in the body.
        sql = f"{query_param}\n{body.decode()}" if query_param and body else (query_param or body.decode())
        params = {k[len("param_"):]: v for k, v in fields.items() if k.startswith("param_")}
        settings = {k: v for k, v in req.query.items() if k not in HTTP_ONLY and not k.startswith("param_")}
        query_id = req.query.get("query_id") or str(uuid.uuid4())
        started = time.monotonic()
        async with ch.lock:
            try:
                await asyncio.to_thread(ch.apply_settings, settings)
                out = await asyncio.to_thread(ch.run, sql, params)
            except Exception as exc:  # noqa: BLE001 - reported like ClickHouse does
                print(f"clickhouse: error {str(exc)[:300]} | sql: {sql[:300]!r}", flush=True)
                return error_response(exc)
        if log_queries:
            print(f"clickhouse: {round((time.monotonic() - started) * 1000)} ms settings={settings} {sql[:160]!r}", flush=True)
        headers = {
            "X-ClickHouse-Query-Id": query_id,
            "X-ClickHouse-Summary": json.dumps({"read_rows": "0", "read_bytes": "0", "written_rows": "0",
                                                "written_bytes": "0", "total_rows_to_read": "0",
                                                "result_rows": "0", "result_bytes": str(len(out))}),
            "Content-Type": "text/plain; charset=UTF-8",
        }
        if "gzip" in req.headers.get("Accept-Encoding", "") and req.query.get("enable_http_compression") == "1":
            out = gzip.compress(out)
            headers["Content-Encoding"] = "gzip"
        return web.Response(body=out, headers=headers)

    app = web.Application(client_max_size=256 * 1024 * 1024)
    app.router.add_route("*", "/{tail:.*}", handle)
    return app


def main() -> None:
    p = argparse.ArgumentParser(description=__doc__.split("\n")[0])
    p.add_argument("--data", default="./data/clickhouse")
    p.add_argument("--migrations", default="./vendor/clickhouse/migrations/unclustered")
    p.add_argument("--host", default="127.0.0.1")
    p.add_argument("--port", type=int, default=8123)
    p.add_argument("--log-queries", action="store_true")
    p.add_argument("--migrate-only", action="store_true", help="apply migrations and exit")
    args = p.parse_args()
    Path(args.data).mkdir(parents=True, exist_ok=True)
    ch = ClickHouse(args.data)
    ch.migrate(Path(args.migrations))
    if args.migrate_only:
        ch.session.close()
        return
    print(f"clickhouse: listening on {args.host}:{args.port}", flush=True)
    try:
        web.run_app(make_app(ch, args.log_queries), host=args.host, port=args.port, access_log=None, print=None)
    finally:
        ch.session.close()


if __name__ == "__main__":
    main()
