#!/bin/bash
# Stops and removes the Claude Session Hub local server. Remove the Chrome extension in chrome://extensions.
LABEL="com.claude-sessions.server"
launchctl bootout "gui/$(id -u)/$LABEL" 2>/dev/null || true
rm -f "$HOME/Library/LaunchAgents/$LABEL.plist"
rm -rf "$HOME/Library/Application Support/claude-sessions"
echo "✔ Removed the Claude Session Hub server."
