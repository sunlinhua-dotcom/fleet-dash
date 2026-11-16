#!/bin/bash
# Install the hub as a macOS LaunchAgent (starts at login, restarts if it dies).
# Usage: bash install-macos.sh   (re-run after editing hub.py / fleet.json)
# Needs: fleet.json next to this script, FLEETDASH_RELAY below, token in ~/.config/fleetdash/hub_token.
set -euo pipefail
SRC=$(cd "$(dirname "$0")" && pwd)
R="$HOME/.local/share/fleetdash"          # launchd can't read some external volumes, so copy the code here
L=com.fleetdash.hub
RELAY_URL="${FLEETDASH_RELAY:-http://127.0.0.1:8941}"
[ -f "$SRC/fleet.json" ] || { echo "missing $SRC/fleet.json (copy fleet.example.json)"; exit 1; }
[ -s "$HOME/.config/fleetdash/hub_token" ] || { echo "missing ~/.config/fleetdash/hub_token"; exit 1; }
mkdir -p "$R" "$HOME/Library/Logs" "$HOME/Library/LaunchAgents"
cp "$SRC/hub.py" "$SRC/fleet.json" "$R/"
PY=$(command -v python3)
cat > "$HOME/Library/LaunchAgents/$L.plist" <<PL
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
  <key>Label</key><string>$L</string>
  <key>ProgramArguments</key><array><string>$PY</string><string>-u</string><string>$R/hub.py</string></array>
  <key>EnvironmentVariables</key><dict>
    <key>PATH</key><string>$HOME/.local/bin:/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin</string>
    <key>HOME</key><string>$HOME</string>
    <key>LANG</key><string>en_US.UTF-8</string>
    <key>FLEETDASH_RELAY</key><string>$RELAY_URL</string>
  </dict>
  <key>RunAtLoad</key><true/>
  <key>KeepAlive</key><true/>
  <key>ThrottleInterval</key><integer>10</integer>
  <key>ProcessType</key><string>Background</string>
  <key>StandardOutPath</key><string>$HOME/Library/Logs/fleetdash-hub.log</string>
  <key>StandardErrorPath</key><string>$HOME/Library/Logs/fleetdash-hub.log</string>
</dict></plist>
PL
launchctl bootout "gui/$(id -u)/$L" 2>/dev/null && sleep 2 || true
launchctl bootstrap "gui/$(id -u)" "$HOME/Library/LaunchAgents/$L.plist"
echo "installed: $R  (LaunchAgent $L, log ~/Library/Logs/fleetdash-hub.log, relay $RELAY_URL)"
