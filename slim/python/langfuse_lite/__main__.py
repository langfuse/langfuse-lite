"""`langfuse-lite` / `python -m langfuse_lite`: runs the bundled executable."""
import os
import subprocess
import sys

from . import binary


def main() -> None:
    args = [binary(), *sys.argv[1:]]
    if sys.platform == "win32":
        sys.exit(subprocess.call(args))
    os.execv(args[0], args)


if __name__ == "__main__":
    main()
