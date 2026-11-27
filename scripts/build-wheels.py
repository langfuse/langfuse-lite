"""Builds one PyPI wheel per platform from the compiled executables in dist/bin/.

    bun run scripts/build.ts --compile && python3 scripts/build-wheels.py

Each wheel holds the python/langfuse_lite package plus that platform's
executable, so `pip install langfuse-lite` / `uvx langfuse-lite` need neither
Node nor Bun (the same approach as ruff and uv). Output: dist/wheels/.
Platform floors come from the binaries: glibc 2.17 on Linux, macOS 13.
"""
from __future__ import annotations

import base64
import hashlib
import io
import json
import stat
import sys
import zipfile
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
PACKAGE = json.loads((ROOT / "package.json").read_text())
VERSION = PACKAGE["version"]
# One list for both registries: PyPI shows the keywords of package.json.
KEYWORDS = ",".join(PACKAGE["keywords"])
PLATFORMS = {
    "linux-x64": "manylinux_2_17_x86_64.manylinux2014_x86_64",
    "linux-arm64": "manylinux_2_17_aarch64.manylinux2014_aarch64",
    "darwin-x64": "macosx_13_0_x86_64",
    "darwin-arm64": "macosx_13_0_arm64",
    "windows-x64": "win_amd64",
}
_init = (ROOT / "python" / "langfuse_lite" / "__init__.py").read_text()
if f'__version__ = "{VERSION}"' not in _init:
    raise SystemExit(f"python/langfuse_lite/__init__.py: __version__ does not match package.json ({VERSION})")
README = (ROOT / "README.md").read_text() if (ROOT / "README.md").exists() else ""
METADATA = f"""Metadata-Version: 2.1
Name: langfuse-lite
Version: {VERSION}
Summary: A local Langfuse for experiment runs and agent tracing: one process, one SQLite file, the Langfuse SDKs unchanged.
License: MIT
License-File: LICENSE
Keywords: {KEYWORDS}
Classifier: Development Status :: 4 - Beta
Classifier: Intended Audience :: Developers
Classifier: License :: OSI Approved :: MIT License
Classifier: Programming Language :: Python :: 3
Classifier: Framework :: Pytest
Classifier: Topic :: Software Development :: Testing
Classifier: Topic :: System :: Monitoring
Requires-Python: >=3.9
Project-URL: Homepage, https://github.com/langfuse/langfuse-lite
Project-URL: Source, https://github.com/langfuse/langfuse-lite
Project-URL: Issues, https://github.com/langfuse/langfuse-lite/issues
Description-Content-Type: text/markdown

{README}"""
ENTRY_POINTS = """[console_scripts]
langfuse-lite = langfuse_lite.__main__:main

[pytest11]
langfuse_lite = langfuse_lite.pytest_plugin
"""


def record_line(name: str, data: bytes) -> str:
    digest = base64.urlsafe_b64encode(hashlib.sha256(data).digest()).rstrip(b"=").decode()
    return f"{name},sha256={digest},{len(data)}"


def build(platform: str, tag: str, out: Path) -> Path:
    exe = ROOT / "dist" / "bin" / f"langfuse-lite-{platform}{'.exe' if platform.startswith('windows') else ''}"
    if not exe.exists():
        raise SystemExit(f"missing {exe}; run `bun run scripts/build.ts --compile` first")
    dist_info = f"langfuse_lite-{VERSION}.dist-info"
    files: list[tuple[str, bytes, int]] = []
    for path in sorted((ROOT / "python" / "langfuse_lite").glob("*.py")):
        files.append((f"langfuse_lite/{path.name}", path.read_bytes(), 0o644))
    files.append(("langfuse_lite/THIRD_PARTY_NOTICES.md", (ROOT / "dist" / "THIRD_PARTY_NOTICES.md").read_bytes(), 0o644))
    bin_name = "langfuse-lite.exe" if platform.startswith("windows") else "langfuse-lite"
    files.append((f"langfuse_lite/bin/{bin_name}", exe.read_bytes(), 0o755))
    files.append((f"{dist_info}/METADATA", METADATA.encode(), 0o644))
    files.append((f"{dist_info}/WHEEL", f"Wheel-Version: 1.0\nGenerator: langfuse-lite build-wheels.py\nRoot-Is-Purelib: false\nTag: py3-none-{tag.split('.')[0]}\n".encode()
                  + "".join(f"Tag: py3-none-{t}\n" for t in tag.split(".")[1:]).encode(), 0o644))
    files.append((f"{dist_info}/entry_points.txt", ENTRY_POINTS.encode(), 0o644))
    files.append((f"{dist_info}/LICENSE", (ROOT / "LICENSE").read_bytes(), 0o644))
    record = [record_line(n, d) for n, d, _ in files] + [f"{dist_info}/RECORD,,"]
    files.append((f"{dist_info}/RECORD", ("\n".join(record) + "\n").encode(), 0o644))
    wheel = out / f"langfuse_lite-{VERSION}-py3-none-{tag}.whl"
    with zipfile.ZipFile(wheel, "w", compression=zipfile.ZIP_DEFLATED, compresslevel=9) as z:
        for name, data, mode in files:
            info = zipfile.ZipInfo(name, date_time=(2026, 1, 1, 0, 0, 0))
            info.external_attr = (stat.S_IFREG | mode) << 16
            info.compress_type = zipfile.ZIP_DEFLATED
            z.writestr(info, data, compresslevel=9)
    return wheel


def main() -> None:
    out = ROOT / "dist" / "wheels"
    out.mkdir(parents=True, exist_ok=True)
    wanted = sys.argv[1:] or list(PLATFORMS)
    for platform in wanted:
        wheel = build(platform, PLATFORMS[platform], out)
        print(f"{wheel.relative_to(ROOT)}  {wheel.stat().st_size / 1024 / 1024:.0f} MB")


if __name__ == "__main__":
    main()
