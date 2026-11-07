#!/usr/bin/env bash
# Linux / macOS launcher
cd "$(dirname "$0")" || exit 1
if command -v python3 >/dev/null 2>&1; then PY=python3
elif command -v python >/dev/null 2>&1; then PY=python
else echo "Python 3.9+ is required: https://www.python.org/downloads/"; exit 1; fi
exec "$PY" run.py "$@"
