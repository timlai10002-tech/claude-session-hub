#!/bin/bash
# Installs the Claude Sessions local server (127.0.0.1:8787) and starts it at every login.
set -euo pipefail
HERE="$(cd "$(dirname "$0")" && pwd)"
DEST="$HOME/Library/Application Support/claude-sessions"
LABEL="com.claude-sessions.server"
PLIST="$HOME/Library/LaunchAgents/$LABEL.plist"
PY="$(command -v python3 || true)"

[ "$(uname)" = "Darwin" ] || { echo "Only macOS is supported."; exit 1; }
[ -n "$PY" ] || { echo "python3 not found. Install it (xcode-select --install, or brew install python) and run again."; exit 1; }

mkdir -p "$DEST" "$HOME/Library/LaunchAgents"
cp "$HERE/server/"* "$DEST/"

cat > "$PLIST" <<PLIST
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key><string>$LABEL</string>
  <key>ProgramArguments</key>
  <array><string>$PY</string><string>-I</string><string>$DEST/server.py</string></array>
  <key>RunAtLoad</key><true/>
  <key>KeepAlive</key><true/>
  <key>StandardOutPath</key><string>$DEST/server.log</string>
  <key>StandardErrorPath</key><string>$DEST/server.log</string>
</dict>
</plist>
PLIST

launchctl bootout "gui/$(id -u)/$LABEL" 2>/dev/null || true
launchctl bootstrap "gui/$(id -u)" "$PLIST"

for _ in $(seq 20); do
  if curl -s http://127.0.0.1:8787/api/ping | grep -q session-progress; then
    echo "✔ Server running at http://127.0.0.1:8787 (starts at every login)."
    echo "Next: Chrome → chrome://extensions → Developer mode → Load unpacked → choose:"
    echo "      $HERE/extension"
    exit 0
  fi
  sleep 0.3
done
echo "✘ The server did not answer. See $DEST/server.log"
exit 1
