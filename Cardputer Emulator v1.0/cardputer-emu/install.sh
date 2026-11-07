#!/bin/sh
# Double-click installer for Linux (and any POSIX shell with python3 on PATH).
cd "$(dirname "$0")" || exit 1
if command -v python3 >/dev/null 2>&1; then
  chmod +x run.sh run.py install.py 2>/dev/null
  exec python3 install.py "$@"
elif command -v python >/dev/null 2>&1; then
  exec python install.py "$@"
else
  echo "Python 3 was not found. Install it from https://www.python.org/downloads/"
  printf "Press Enter to close..."
  read -r _
  exit 1
fi
