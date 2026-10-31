#!/usr/bin/env bash
# Installs (or repairs) the self-hosted GitHub Actions runner on the Oracle VM
# and hardens it. Safe to re-run: an already-registered runner is kept and only
# the service hardening is (re)applied. Pass --reregister to register again.
#
# Usage: scripts/setup-oracle-runner.sh [--reregister] [user@host] [ssh options...]
# Needs: gh (logged in, repo admin) and SSH access to the VM.
set -euo pipefail

REREGISTER=0
[ "${1:-}" = --reregister ] && { REREGISTER=1; shift; }
TARGET="${1:-ubuntu@158.101.198.99}"; [ $# -gt 0 ] && shift
REPO=acierto/backstage-radar
NAME=agents-runner
VER=$(gh api repos/actions/runner/releases/latest --jq '.tag_name | ltrimstr("v")')
TOKEN=$(gh api -X POST "repos/$REPO/actions/runners/registration-token" --jq .token)

ssh "$@" "$TARGET" "TOKEN='$TOKEN' VER='$VER' REPO='$REPO' NAME='$NAME' REREGISTER='$REREGISTER' bash -s" <<'REMOTE'
set -euo pipefail
DIR=~/actions-runner
mkdir -p "$DIR" && cd "$DIR"

if [ ! -f config.sh ]; then
  curl -fsSL -o runner.tgz "https://github.com/actions/runner/releases/download/v$VER/actions-runner-linux-arm64-$VER.tar.gz"
  tar xzf runner.tgz && rm runner.tgz
  sudo ./bin/installdependencies.sh
fi

if [ ! -f .runner ] || [ "$REREGISTER" = 1 ]; then
  [ -f .service ] && { sudo ./svc.sh stop || true; sudo ./svc.sh uninstall || true; }
  ./config.sh --unattended --url "https://github.com/$REPO" --token "$TOKEN" \
    --name "$NAME" --labels oracle --replace
fi
[ -f .service ] || sudo ./svc.sh install
UNIT=$(cat .service)

# 1. Restart the service whenever it dies, forever, and start it after Docker
#    and the network are up. The runner auto-updates itself by default.
sudo mkdir -p "/etc/systemd/system/$UNIT.d"
sudo tee "/etc/systemd/system/$UNIT.d/resilience.conf" >/dev/null <<EOF
[Unit]
Wants=network-online.target
After=network-online.target
StartLimitIntervalSec=0

[Service]
Restart=always
RestartSec=15
# Keep CI from starving the other services on this VM (sheltersync).
Nice=5
MemoryHigh=4G
MemoryMax=6G
EOF

# 2. Weekly housekeeping limited to this runner's own files (the VM is shared,
#    so no docker prune): old diagnostic logs, stale temp files, npm cache.
sudo tee /etc/systemd/system/actions-runner-cleanup.service >/dev/null <<EOF
[Unit]
Description=Clean up GitHub Actions runner files

[Service]
Type=oneshot
User=$USER
ExecStart=/bin/sh -c 'find $DIR/_diag -type f -mtime +14 -delete; find $DIR/_work/_temp -mindepth 1 -mtime +2 -delete 2>/dev/null; npm cache clean --force 2>/dev/null || rm -rf \$HOME/.npm/_cacache; true'
EOF
sudo tee /etc/systemd/system/actions-runner-cleanup.timer >/dev/null <<EOF
[Unit]
Description=Weekly GitHub Actions runner cleanup

[Timer]
OnCalendar=Sun 03:30
Persistent=true

[Install]
WantedBy=timers.target
EOF

sudo systemctl daemon-reload
sudo systemctl enable --now actions-runner-cleanup.timer
sudo systemctl enable "$UNIT"
sudo systemctl restart "$UNIT"
sleep 3
systemctl is-active "$UNIT"
systemctl show "$UNIT" -p Restart -p MemoryMax -p NRestarts
REMOTE

sleep 10
gh api "repos/$REPO/actions/runners" --jq '.runners[] | "\(.name) \(.status) \(.labels | map(.name) | join(","))"'
