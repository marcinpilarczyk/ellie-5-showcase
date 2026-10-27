# Ellie v5 example runbook

> **Showcase note:** This runbook contains optional operational examples for running the reference
> implementation. It is not a supported hosting service or production deployment contract. Use
> synthetic accounts and data unless you have completed an independent security, privacy, and
> provider-access review.

## Components

| Component | Example location |
| :--- | :--- |
| Application checkout | `~/ellie` |
| Environment configuration | `~/ellie/.env` |
| Runtime data | `~/.local/share/ellie/` |
| App database | `~/.local/share/ellie/app.sqlite` |
| Approval database | `~/.local/share/ellie/ledger.sqlite` |
| Published Spaces | `~/.local/share/ellie/spaces/` |
| systemd user units | `~/.config/systemd/user/` |

The data directory and its backups may contain OAuth tokens, task history, documents, and personal
information. Restrict access to the service account.

## Prerequisites

- Node.js 22.13 or newer
- npm
- Optional: LibreOffice, Poppler, and a headless Chromium-compatible browser for document rendering
- Optional: Android Studio/JDK 17 for the Android client
- Provider credentials for whichever integrations you explicitly enable

## Local setup

```bash
git clone https://github.com/marcinpilarczyk/ellie-5-showcase.git
cd ellie-5-showcase
npm ci
cp .env.example .env
```

Edit `.env` and set synthetic or dedicated test credentials. At minimum, production startup checks
for:

- `ELLIE_CONTROL_PLANE_TOKEN`
- `GEMINI_API_KEY`
- `SLACK_SIGNING_SECRET`
- `SLACK_OWNER_USER_ID`

Most integrations remain disabled or unavailable until their own configuration is present.

Build, test, and diagnose:

```bash
npm run build
npm test
npm run doctor
```

Run the server:

```bash
npm start
```

The default application listener binds to `127.0.0.1:3001`.

## Configuration boundaries

- `ELLIE_DATA_DIR` controls SQLite and Spaces storage.
- `ELLIE_CONTROL_PLANE_TOKEN` protects the normal web listener.
- `ELLIE_PRIVATE_PORT` optionally exposes a second loopback listener intended for a private
  network such as Tailscale. Do not publish that listener through Funnel or a public proxy.
- `ELLIE_SEND_ALLOWLIST` optionally restricts outbound recipients.
- `ELLIE_ENABLE_JINA_FALLBACK=false` prevents page URLs from being sent to an external reader.
- Google OAuth tokens are stored in the configured SQLite database.

Treat `.env`, SQLite files, backups, and exported OAuth tokens as sensitive credentials.

## Optional systemd example

The repository includes unit templates under `deploy/systemd/`. They assume:

- the checkout is `~/ellie`;
- the environment file is `~/ellie/.env`;
- Node is available at a fixed executable path substituted by `deploy/vps.sh`;
- user lingering is enabled if services must survive logout.

Do not install or start these units on a shared host without reviewing paths, permissions,
resource limits, and provider access.

## Optional staged deployment example

`deploy/push.sh` demonstrates a staged deployment workflow:

1. require a clean Git tree;
2. upload committed `HEAD`;
3. install dependencies and build in a staging directory;
4. copy the environment file and run diagnostics;
5. swap the staged directory into place;
6. restart and health-check the service;
7. restore the previous checkout if restart or health checks fail.

Review and adapt the script before use. Database migrations are additive, but a files-only rollback
does not undo database changes.

## Health and diagnostics

Local health endpoint:

```bash
curl http://127.0.0.1:3001/api/health
```

Common checks:

```bash
node --env-file=.env dist/scripts/doctor.js
systemctl --user status ellie.service
systemctl --user list-timers ellie-wake.timer
journalctl --user -u ellie.service -n 200 --no-pager
journalctl --user -u ellie-wake.service -n 200 --no-pager
```

## Data protection

Use restrictive permissions:

```bash
chmod 700 "$HOME/.local/share/ellie"
chmod 600 "$HOME/ellie/.env"
```

The provided user units set `UMask=0077` so newly created runtime files are private to the service
account.

## Backup example

Stop background work before taking a manual snapshot, or use SQLite's online backup command.

```bash
backup_dir="$HOME/backups/ellie"
mkdir -p "$backup_dir"
chmod 700 "$backup_dir"

sqlite3 "$HOME/.local/share/ellie/app.sqlite" \
  ".backup '$backup_dir/app.sqlite'"
sqlite3 "$HOME/.local/share/ellie/ledger.sqlite" \
  ".backup '$backup_dir/ledger.sqlite'"
```

Encrypt or otherwise protect backups containing OAuth tokens and task history.

## Shutdown

| Scope | Example command |
| :--- | :--- |
| Web server and Slack responses | `systemctl --user stop ellie.service` |
| Background wake cycle | `systemctl --user disable --now ellie-wake.timer` |
| Public webhook exposure | Disable the relevant private-network or proxy route |
| One routine | Disable it from the control plane or Slack |
| One sentinel | Disable it from the control plane or Slack |

## Troubleshooting

1. Run `npm run doctor` and fix reported configuration failures.
2. Check `/api/health` from the same host.
3. Inspect the most recent run trace in the control plane.
4. Review service logs for provider errors or invalid configuration.
5. Reconnect an integration if its credentials were revoked or its scopes changed.

For architecture questions, start with [docs/INVENTORY_PUBLIC.md](docs/INVENTORY_PUBLIC.md) and
[docs/ELLIE_DESIGN.md](docs/ELLIE_DESIGN.md).
