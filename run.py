#!/usr/bin/env python3
"""Cardputer EMU launcher.

    python run.py                 start the emulator (opens your browser)
    python run.py --check         ask the release feed for updates
    python run.py --update        download + verify + install an update
    python run.py --rollback      go back to the previous build
    python run.py --status        print version / update state
    python run.py --dev           serve src/ (unbundled) for hacking on the UI

Works unchanged on Linux, macOS and Windows (Python 3.9+, stdlib only).
"""
import os
import sys

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))

from cardputer.cli import main

if __name__ == "__main__":
    sys.exit(main())
