#!/bin/zsh
# Launch the skill-eval TUI in a new macOS terminal window.
#
# Why `--command="<one string>"` instead of `open -a Ghostty --args -e <python> <script> --flags`:
# Ghostty's `-e` mangles a command line that carries flags, and the window it
# opens then runs the wrong thing. One quoted string, no ambiguity.
#
# Usage: ./tools/launch-macos.sh [--run-now] [--scenarios FILE] [--evals-dir DIR]
set -e
REPO="$(cd "$(dirname "$0")/.." && pwd)"
cd "$REPO"

VENV="$REPO/.venv"
[ -x "$VENV/bin/python" ] || { echo "no $VENV — run: python3 -m venv .venv && .venv/bin/pip install -r tools/requirements-tui.txt" >&2; exit 1; }

TERM_APP="${TERM_APP:-Ghostty}"
CMD="$VENV/bin/python $REPO/tools/tui.py"
for arg in "$@"; do CMD="$CMD $(printf '%q' "$arg")"; done

open -na "$TERM_APP.app" --args --window-width=150 --window-height=46 --command="$CMD"
