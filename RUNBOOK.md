# Ellie v5 runbook

Everything runs as the `ellie` user on your host (e.g. `ellie.example.com`; SSH as `ubuntu`, which has sudo).

| What | Where |
| --- | --- |
| Code | `~/ellie` (deployed from this repo with `deploy/push.sh`; commit in `~/ellie/DEPLOYED_COMMIT`) |
| Config and secrets | `~/ellie/.env` (mode 600) |
| State | `~/.local/share/ellie/` (`app.sqlite`, `ledger.sqlite`) |
| Units | `~/.config/systemd/user/ellie.service`, `ellie-wake.service`, `ellie-wake.timer` |
| Kept original secrets | `~/backups/v2-preservation/.env` (untouched; its `SLACK_BOT_TOKEN` is an old, revoked one) |
| Archive of everything before v5 | `/var/backups/ellie-archive/ellie-home-pre-v5-20261014.tar.zst` (root only) |
| Other services on the box | Proton Bridge (`proton-bridge.service`, user unit), Tailscale |

## Network

There is no nginx/Caddy. Tailscale provides both entry points:

| Address | Reaches | Who |
| --- | --- | --- |
| `https://ellie-funnel.example.ts.net:8443` (Funnel, public) | `/api/health`, `/api/slack/events`, `/api/slack/interactions`, `/api/auth/google/callback` on port 3001 | Slack, Google OAuth |
| `https://ellie-vps.example.ts.net:10000` (tailnet only) | everything on port 3002, no token | you, on the tailnet |
| `127.0.0.1:3001` | everything, control-page token required | local |

`ELLIE_PUBLIC_URL` is the Funnel address, `ELLIE_CONTROL_URL` the tailnet one (used in Slack links). Check with `sudo tailscale serve status`.

## Acceptance checks (Ellie is "working" only when you have seen these in Slack)

| # | Do | You should see |
| --- | --- | --- |
| 1 | DM: "what's on my calendar tomorrow?" | An answer in the thread; a ⏳ status first if it takes >4 s |
| 2 | Paste a job link: "should I apply?" | A reasoned answer in the thread |
| 3 | In that thread: "make a tailored resume" | DOCX and PDF links in the thread; the PDF is 2 pages and every contact detail is in your sources (or BLOCKED with the reason + "reply continue") |
| 4 | "send an email to <allowlisted address> saying …" ("draft an email" makes a Gmail draft, no card) | A quote card; Approve → card shows "Done (provider confirmed, not read back)"; the mail is in Gmail Sent |
| 5 | "create a routine every weekday at 8:00 called Morning brief: …", then control page → Routines → Run now | A Slack post with the result; status DELIVERED |
| 6 | Wait for a scheduled routine | The same, at the scheduled time |
| 7 | "what did you spend this week?" | Flash vs reasoning-model cost answer |

## Everyday operations

```bash
ssh ubuntu@ellie.example.com
sudo -iu ellie
export XDG_RUNTIME_DIR=/run/user/$(id -u)
systemctl --user status ellie.service              # server
systemctl --user list-timers ellie-wake.timer      # next wake cycle
journalctl --user -u ellie.service -f              # live logs
journalctl --user -u ellie-wake.service -n 200     # last wake cycles
cd ~/ellie && node --env-file=.env dist/scripts/doctor.js
```

### Deploy a new version (from the laptop, in this repo)

```bash
bash deploy/push.sh
```

It uploads the committed `HEAD` into a fresh `~/ellie.new`, copies `.env`, runs `npm ci`, the build and `doctor`, and only then swaps it in and restarts. If anything fails, the running install is untouched. The previous install stays in `~/ellie.prev`; roll back with `mv ~/ellie ~/ellie.bad && mv ~/ellie.prev ~/ellie` and a restart. Migrations run on start and are additive.

### Turn things off (trigger inventory)

| Trigger | Off |
| --- | --- |
| Slack conversations, approvals, control page | `systemctl --user stop ellie.service` |
| All background work (sentinels, reminders, routines) | `systemctl --user disable --now ellie-wake.timer` |
| One routine | Slack: "disable routine X", or control page → Routines → Disable |
| One sentinel | Slack: "turn off the Gmail sentinel" |
| Proactive messages for a while | Slack: "snooze nudges until 16:00" |
| Public webhooks | `sudo tailscale funnel --https=8443 off` |

### Secrets

All live secrets are in `~/ellie/.env`. After rotating one, edit `.env`, run doctor, then `systemctl --user restart ellie.service`. The Google OAuth refresh token is in `app.sqlite` (`integrations` table); if it is revoked, open `<ELLIE_CONTROL_URL>/api/integrations/google/connect`. The Google Cloud OAuth client must list `https://ellie-funnel.example.ts.net:8443/api/auth/google/callback` as a redirect URI.

### Backup and restore

```bash
mkdir -p ~/backups/ellie && for db in app ledger; do
  sqlite3 ~/.local/share/ellie/$db.sqlite ".backup $HOME/backups/ellie/$db-$(date +%F).sqlite"; done
# restore
systemctl --user stop ellie.service ellie-wake.timer
cp ~/backups/ellie/app-<date>.sqlite ~/.local/share/ellie/app.sqlite
cp ~/backups/ellie/ledger-<date>.sqlite ~/.local/share/ellie/ledger.sqlite
systemctl --user start ellie.service ellie-wake.timer
```

### Getting something back from the pre-v5 archive

```bash
sudo tar -I zstd -tf /var/backups/ellie-archive/ellie-home-pre-v5-20261014.tar.zst | less      # list
sudo tar -I zstd -xf /var/backups/ellie-archive/ellie-home-pre-v5-20261014.tar.zst -C /tmp/restore ellie-v4/.env   # extract one path
```

It holds the old home folder: `backups/` (old SQLite snapshots, `v2-preservation/` incl. v2's `routines.json` and `never-claims.json`), `ellie-v4/` (with its `.env`), `.local/share/ellie-v4/`, `work/`, `dev/`, `acceptance/`, `state/`, logs, old unit files. `node_modules` and caches were not archived.

### Where does a problem belong?

- **Ellie fix**: wrong tone, wrong routine wording, a missing fact. Tell Ellie in Slack (memory, routine edit).
- **Config fix**: anything doctor reports, a revoked token, a wrong channel. Edit `.env` or reconnect.
- **Code fix**: a run trace (control page → Runs) that shows the wrong tool, a crash, or a reply that does not match what the tools returned.

## Fresh server

`deploy/vps.sh` (phases `inventory`, `fetch`, `preserve`, `wipe`, `configure`, `start`) sets up a new box. The 2026-10-14 cutover on this server was done step by step instead, archiving rather than deleting (see the table above).
