#!/usr/bin/env bash
# Ellie v5 cutover on the VPS. Run as the `ellie` user. Phases, in order:
#
#   inventory  read-only: what old Ellie pieces exist (units, timers, cron, dirs, ports)
#   fetch      clone/update the v5 repo into ~/ellie and build it (does not start anything)
#   preserve   export the Google connection from the old database into the backup folder
#   wipe       stop and delete every old Ellie install (asks you to type "wipe")
#   configure  write ~/ellie/.env from the backup .env, install systemd units, import Google token
#   start      start Ellie and the wake timer, check health
#
# Never touched: ~/backups, Proton Bridge, Tailscale, anything not named ellie*.
set -euo pipefail

REPO_URL="${REPO_URL:-https://github.com/marcinpilarczyk/ellie-5-showcase.git}"
APP_DIR="$HOME/ellie"
DATA_DIR="$HOME/.local/share/ellie"
BACKUP_DIR="$HOME/backups/v2-preservation"
BACKUP_ENV="$BACKUP_DIR/.env"
TOKEN_FILE="$BACKUP_DIR/google-token.json"
UNIT_DIR="$HOME/.config/systemd/user"
NEW_UNITS=(ellie.service ellie-wake.service ellie-wake.timer)

# Old installs: directories and unit-name patterns that belong to earlier Ellie versions
OLD_DIRS=("$HOME/apps/ellie-v2" "$HOME/apps/ellie-v4" "$HOME/apps/ellie" "$HOME/ellie-v2" "$HOME/ellie-v4" \
          "$HOME/.local/share/ellie-v2" "$HOME/.local/share/ellie-v4")
OLD_DB_CANDIDATES=("$HOME/apps/ellie-v2/data/ellie-v2.sqlite" "$HOME/.local/share/ellie-v4/app.sqlite" "$HOME/ellie-v4/.local-data/app.sqlite")

say() { printf '\n== %s\n' "$*"; }
node_bin() {
  local n
  n="$(command -v node || true)"
  [ -z "$n" ] && [ -x "$HOME/.local/bin/node" ] && n="$HOME/.local/bin/node"
  [ -z "$n" ] && { echo "node not found (need >= 22.13)" >&2; exit 1; }
  echo "$n"
}
old_units() {
  systemctl --user list-unit-files --no-legend 'ellie*' 2>/dev/null | awk '{print $1}' | while read -r u; do
    case " ${NEW_UNITS[*]} " in *" $u "*) ;; *) echo "$u" ;; esac
  done
}

inventory() {
  say "systemd user units (ellie*, proton*)"
  systemctl --user list-unit-files --no-pager 'ellie*' 'proton*' 2>/dev/null || true
  say "running ellie units"
  systemctl --user list-units --all --no-pager 'ellie*' 2>/dev/null || true
  say "system-level ellie units (these need sudo to remove)"
  systemctl list-unit-files --no-pager 'ellie*' 2>/dev/null | grep -i ellie || echo "none"
  say "timers"
  systemctl --user list-timers --all --no-pager 2>/dev/null || true
  say "crontab lines mentioning ellie"
  (crontab -l 2>/dev/null | grep -in ellie) || echo "none"
  say "old directories"
  for d in "${OLD_DIRS[@]}"; do [ -e "$d" ] && du -sh "$d" 2>/dev/null; done; true
  say "new install"
  ls -la "$APP_DIR" "$DATA_DIR" 2>/dev/null || echo "not installed yet"
  say "backup folder"
  ls -la "$BACKUP_DIR" 2>/dev/null || echo "MISSING: $BACKUP_DIR"
  say "listening ports (3000-3009, 10000)"
  (ss -ltnp 2>/dev/null | grep -E ':(300[0-9]|10000)\b') || echo "none"
  say "tailscale serve"
  (tailscale serve status 2>/dev/null) || echo "tailscale serve not available to this user"
  say "lingering (user services survive logout)"
  loginctl show-user "$USER" -p Linger 2>/dev/null || true
  say "node"
  "$(node_bin)" --version
}

fetch() {
  say "Fetching v5 into $APP_DIR"
  if [ -d "$APP_DIR/.git" ]; then
    git -C "$APP_DIR" pull --ff-only
  else
    git clone "$REPO_URL" "$APP_DIR"
  fi
  cd "$APP_DIR"
  local NODE; NODE="$(node_bin)"
  PATH="$(dirname "$NODE"):$PATH" npm ci --no-audit --no-fund
  PATH="$(dirname "$NODE"):$PATH" npm run build
  echo "Built. Nothing started."
}

preserve() {
  [ -f "$BACKUP_ENV" ] || { echo "Missing $BACKUP_ENV; stop here." >&2; exit 1; }
  [ -f "$APP_DIR/dist/scripts/google-token.js" ] || { echo "Run 'fetch' first." >&2; exit 1; }
  local db=""
  for c in "${OLD_DB_CANDIDATES[@]}"; do
    if [ -f "$c" ] && "$(node_bin)" "$APP_DIR/dist/scripts/google-token.js" export --from "$c" --out "$TOKEN_FILE.tmp" >/dev/null 2>&1; then
      db="$c"; mv "$TOKEN_FILE.tmp" "$TOKEN_FILE"; break
    fi
    rm -f "$TOKEN_FILE.tmp"
  done
  if [ -n "$db" ]; then
    chmod 600 "$TOKEN_FILE"
    echo "Google connection exported from $db to $TOKEN_FILE"
  else
    echo "No Google token found in: ${OLD_DB_CANDIDATES[*]}"
    echo "You can still connect Google after install at <ELLIE_PUBLIC_URL>/api/integrations/google/connect."
  fi
}

wipe() {
  local units; units="$(old_units)"
  local dirs=(); for d in "${OLD_DIRS[@]}"; do [ -e "$d" ] && dirs+=("$d"); done
  local cron; cron="$(crontab -l 2>/dev/null | grep -i ellie || true)"

  say "This will permanently delete:"
  echo "systemd user units:"; [ -n "$units" ] && echo "$units" | sed 's/^/  /' || echo "  none"
  echo "directories:"; [ ${#dirs[@]} -gt 0 ] && printf '  %s\n' "${dirs[@]}" || echo "  none"
  echo "crontab lines:"; [ -n "$cron" ] && echo "$cron" | sed 's/^/  /' || echo "  none"
  echo "Kept: $BACKUP_DIR, Proton Bridge, Tailscale, $APP_DIR (v5)."
  [ -f "$TOKEN_FILE" ] || echo "WARNING: no $TOKEN_FILE; Google will need reconnecting."
  read -r -p "Type 'wipe' to delete the above: " answer
  [ "$answer" = "wipe" ] || { echo "Aborted. Nothing deleted."; exit 1; }

  if [ -n "$units" ]; then
    while read -r u; do
      systemctl --user disable --now "$u" 2>/dev/null || true
      rm -f "$UNIT_DIR/$u"
    done <<< "$units"
    systemctl --user daemon-reload
    systemctl --user reset-failed 2>/dev/null || true
  fi
  [ -n "$cron" ] && (crontab -l | grep -vi ellie | crontab -)
  for d in "${dirs[@]}"; do rm -rf "$d"; done
  echo "Old Ellie removed."
  if systemctl list-unit-files --no-pager 'ellie*' 2>/dev/null | grep -qi ellie; then
    echo "System-level ellie units still exist; remove them with sudo (see RUNBOOK.md)."
  fi
}

configure() {
  [ -f "$BACKUP_ENV" ] || { echo "Missing $BACKUP_ENV" >&2; exit 1; }
  [ -f "$APP_DIR/dist/index.js" ] || { echo "Run 'fetch' first." >&2; exit 1; }
  local NODE; NODE="$(node_bin)"
  mkdir -p "$DATA_DIR/private" "$UNIT_DIR"
  chmod 700 "$DATA_DIR" "$DATA_DIR/private"

  say "Writing $APP_DIR/.env from the backup (values are not printed)"
  local env_out="$APP_DIR/.env"
  grep -vE '^(ELLIE_APP_DB_PATH|ELLIE_LEDGER_DB_PATH|ELLIE_PRIVATE_DIR|ELLIE_DATA_DIR|GEMINI_ARGON_MODEL|NODE_ENV|PORT|ELLIE_PRIVATE_PORT)=' "$BACKUP_ENV" > "$env_out"
  {
    echo ""
    echo "# --- set by deploy/vps.sh configure ---"
    echo "NODE_ENV=production"
    echo "PORT=3001"
    echo "ELLIE_PRIVATE_PORT=3002"
    echo "ELLIE_DATA_DIR=$DATA_DIR"
  } >> "$env_out"
  if ! grep -q '^GEMINI_REASONING_MODEL=' "$env_out" && grep -q '^GEMINI_PRO_MODEL=' "$env_out"; then
    echo "GEMINI_REASONING_MODEL=$(grep '^GEMINI_PRO_MODEL=' "$env_out" | tail -1 | cut -d= -f2-)" >> "$env_out"
  fi
  chmod 600 "$env_out"

  say "Installing systemd units"
  for u in "${NEW_UNITS[@]}"; do
    sed "s#@NODE@#$NODE#g" "$APP_DIR/deploy/systemd/$u" > "$UNIT_DIR/$u"
  done
  systemctl --user daemon-reload

  cd "$APP_DIR"
  if [ -f "$TOKEN_FILE" ]; then
    say "Importing Google connection"
    "$NODE" --env-file="$env_out" dist/scripts/google-token.js import --from "$TOKEN_FILE"
  fi

  say "Doctor"
  "$NODE" --env-file="$env_out" dist/scripts/doctor.js || echo "Fix the FAIL lines above in $env_out, then run: npm run doctor"
}

start() {
  systemctl --user enable --now ellie.service ellie-wake.timer
  sleep 3
  systemctl --user --no-pager status ellie.service | head -5
  say "Health"
  curl -fsS http://127.0.0.1:3001/api/health && echo
  say "Next"
  echo "Tailnet access without token:  tailscale serve --bg --https=10000 http://127.0.0.1:3002"
  echo "Public proxy (Slack webhooks) must point at http://127.0.0.1:3001"
}

case "${1:-}" in
  inventory|fetch|preserve|wipe|configure|start) "$1" ;;
  *) sed -n '2,12p' "$0"; exit 1 ;;
esac
