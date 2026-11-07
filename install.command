#!/bin/sh
# Double-click installer for macOS.
cd "$(dirname "$0")" || exit 1
chmod +x run.command run.py install.py 2>/dev/null
if command -v python3 >/dev/null 2>&1; then
  exec python3 install.py "$@"
elif command -v python >/dev/null 2>&1; then
  exec python install.py "$@"
else
  echo "Python 3 was not found. Install it from https://www.python.org/downloads/"
  printf "Press Enter to close..."
  read -r _
  exit 1
fi
