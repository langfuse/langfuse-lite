"""langfuse-lite: a local Langfuse for experiment runs and agent tracing.

The wheel ships the langfuse-lite executable for this platform. Use it from
the command line (``langfuse-lite serve``, ``uvx langfuse-lite observations``) or
start a server from Python:

    from langfuse_lite import serve

    with serve() as lite:            # random free port, temporary database
        os.environ.update(lite.env)  # LANGFUSE_BASE_URL and keys for the SDK
        ...

In pytest, the ``langfuse_lite`` fixture does the same for a test session.
"""
from __future__ import annotations

import os
import re
import subprocess
import sys
import tempfile
import threading
import time
import urllib.request
from pathlib import Path

__version__ = "0.1.0"
__all__ = ["binary", "serve", "LangfuseLite"]


def binary() -> str:
    """Path of the bundled langfuse-lite executable."""
    name = "langfuse-lite.exe" if sys.platform == "win32" else "langfuse-lite"
    path = Path(__file__).parent / "bin" / name
    if not path.exists():
        raise RuntimeError(f"langfuse-lite executable missing at {path}; this wheel does not match the platform")
    return str(path)


class LangfuseLite:
    """A running langfuse-lite server; stop() or use as a context manager."""

    def __init__(self, port: int = 0, db: str | os.PathLike | None = None, host: str = "127.0.0.1"):
        self._tmp = None
        if db is None:
            self._tmp = tempfile.TemporaryDirectory(prefix="langfuse-lite-")
            db = Path(self._tmp.name) / "lite.db"
        self.db = str(db)
        env = dict(os.environ)
        if self._tmp:
            # A temporary database is a test run: no usage telemetry for those.
            env["TELEMETRY_ENABLED"] = "false"
        self.process = subprocess.Popen(
            [binary(), "serve", "--host", host, "--port", str(port), "--db", self.db],
            stdout=subprocess.PIPE, stderr=subprocess.STDOUT, text=True, bufsize=1, env=env,
        )
        self.log: list[str] = []
        line = self.process.stdout.readline() if self.process.stdout else ""
        match = re.search(r"listening on (http://\S+)", line)
        if not match:
            rest = self.process.stdout.read() if self.process.stdout else ""
            self.process.kill()
            raise RuntimeError(f"langfuse-lite did not start: {line}{rest}")
        self.url = match.group(1)
        threading.Thread(target=self._drain, daemon=True).start()
        self._wait_healthy()

    def _drain(self):
        for line in self.process.stdout or []:
            self.log.append(line.rstrip("\n"))

    def _wait_healthy(self, timeout: float = 10):
        deadline = time.time() + timeout
        while time.time() < deadline:
            try:
                with urllib.request.urlopen(self.url + "/api/public/health", timeout=1):
                    return
            except OSError:
                time.sleep(0.05)
        raise RuntimeError("langfuse-lite did not become healthy")

    @property
    def env(self) -> dict[str, str]:
        """Settings for the Langfuse SDKs (any keys are accepted)."""
        return {"LANGFUSE_BASE_URL": self.url, "LANGFUSE_HOST": self.url,
                "LANGFUSE_PUBLIC_KEY": "pk-lf-local", "LANGFUSE_SECRET_KEY": "sk-lf-local"}

    def cli(self, *args: str) -> str:
        """Runs a langfuse-lite command (observations, tree, runs, compare, sql) on this server's database."""
        out = subprocess.run([binary(), *args, "--db", self.db], capture_output=True, text=True, check=True)
        return out.stdout

    def stop(self):
        if self.process.poll() is None:
            self.process.terminate()
            try:
                self.process.wait(timeout=5)
            except subprocess.TimeoutExpired:
                self.process.kill()
        if self._tmp:
            self._tmp.cleanup()
            self._tmp = None

    def __enter__(self):
        return self

    def __exit__(self, *exc):
        self.stop()


def serve(port: int = 0, db: str | os.PathLike | None = None, host: str = "127.0.0.1") -> LangfuseLite:
    """Starts langfuse-lite; port 0 picks a free port, db None uses a temporary database."""
    return LangfuseLite(port=port, db=db, host=host)
