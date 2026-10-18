#!/usr/bin/env bash
# Deploy the committed HEAD of this repo to the VPS from a laptop (no GitHub needed).
#   bash deploy/push.sh            # host defaults to ${ELLIE_DEPLOY_HOST:-ubuntu@ellie.example.com}
# Unpacks into a fresh ~/ellie.new (so deleted files do not linger), carries over .env,
# builds and runs doctor there, then swaps it in and restarts. On any failure the
# running install is left untouched. The previous install stays in ~/ellie.prev.
set -euo pipefail
HOST="${1:-${ELLIE_DEPLOY_HOST:-ubuntu@ellie.example.com}}"
cd "$(dirname "$0")/.."
[ -z "$(git status --porcelain)" ] || { echo "Commit your changes first (deploys HEAD only)." >&2; exit 1; }
SHA="$(git rev-parse HEAD)"
echo "Deploying $SHA to $HOST"

git archive --format=tar HEAD | ssh "$HOST" 'sudo -u ellie bash -c "rm -rf /home/ellie/ellie.new && mkdir -p /home/ellie/ellie.new && tar -x -C /home/ellie/ellie.new"'
ssh "$HOST" "sudo -u ellie bash -lc '
  set -e
  export HOME=/home/ellie
  export PATH=/home/ellie/.local/bin:\$PATH XDG_RUNTIME_DIR=/run/user/\$(id -u)
  cd /home/ellie/ellie.new
  cp -p /home/ellie/ellie/.env .env 2>/dev/null || cp -p /home/ellie/ellie.prev/.env .env
  echo $SHA > DEPLOYED_COMMIT
  npm ci --no-audit --no-fund --loglevel=error
  npm run build --silent
  node --env-file=.env dist/scripts/doctor.js
  cd /home/ellie
  if [ -d /home/ellie/ellie ]; then
    rm -rf /home/ellie/ellie.prev && mv /home/ellie/ellie /home/ellie/ellie.prev
  fi
  mv /home/ellie/ellie.new /home/ellie/ellie
  systemctl --user restart ellie.service
  sleep 3
  curl -fsS http://127.0.0.1:3001/api/health && echo
'"
echo "Deployed $SHA. Roll back: ssh $HOST 'sudo -u ellie bash -c \"mv /home/ellie/ellie /home/ellie/ellie.bad && mv /home/ellie/ellie.prev /home/ellie/ellie\"' then restart ellie.service"
