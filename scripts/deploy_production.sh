#!/usr/bin/env bash

set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
TARGET_HOST="${1:-${DEPLOY_HOST:-root@134.175.238.186}}"
REMOTE_DIR="${DEPLOY_REMOTE_DIR:-/opt/bim-tender}"
REMOTE_SERVICE="${DEPLOY_SERVICE:-bim-tender.service}"
REMOTE_OWNER="${DEPLOY_OWNER:-admin:admin}"
REMOTE_RUN_USER="${DEPLOY_RUN_USER:-admin}"

VERSION="$(
  cd "$ROOT_DIR" &&
  node --input-type=module -e "import fs from 'node:fs'; console.log(JSON.parse(fs.readFileSync('./server/package.json', 'utf8')).version);"
)"
TIMESTAMP="$(date +%Y%m%d-%H%M%S)"
BACKUP_DIR="/opt/bim-tender-backups/${TIMESTAMP}"
BACKUP_FILE="${BACKUP_DIR}/bim-tender-pre-v${VERSION}.tgz"

echo "==> Deploying v${VERSION} to ${TARGET_HOST}"
echo "==> Backup target: ${BACKUP_FILE}"

ssh -o BatchMode=yes "${TARGET_HOST}" "mkdir -p '${BACKUP_DIR}' && tar -czf '${BACKUP_FILE}' -C \"$(dirname "${REMOTE_DIR}")\" \"$(basename "${REMOTE_DIR}")\""

echo "==> Syncing code (SQLite DB and secrets excluded)"
rsync -az \
  --exclude '.git' \
  --exclude '.DS_Store' \
  --exclude '.firecrawl' \
  --exclude '.secrets' \
  --exclude 'client/node_modules' \
  --exclude 'server/node_modules' \
  --exclude 'client/dist' \
  --exclude 'server/dist' \
  --exclude 'server/.env' \
  --exclude 'server/.cache' \
  --exclude 'server/prisma/dev.db' \
  --exclude 'server/prisma/dev.db-journal' \
  "${ROOT_DIR}/" "${TARGET_HOST}:${REMOTE_DIR}/"

echo "==> Building and restarting service"
ssh -o BatchMode=yes "${TARGET_HOST}" "
  chown -R '${REMOTE_OWNER}' '${REMOTE_DIR}' &&
  runuser -u '${REMOTE_RUN_USER}' -- bash -lc 'cd \"${REMOTE_DIR}/client\" && npm run build && cd \"${REMOTE_DIR}/server\" && npm run build' &&
  systemctl restart '${REMOTE_SERVICE}' &&
  sleep 3 &&
  ROOT_STATUS=\$(curl -s -H 'x-forwarded-proto: https' -o /tmp/bim_tender_root_check.html -w '%{http_code}' http://localhost:3001/) &&
  AUTH_STATUS=\$(curl -s -H 'x-forwarded-proto: https' -o /tmp/bim_tender_auth_check.json -w '%{http_code}' http://localhost:3001/api/auth/session) &&
  HEALTH_STATUS=\$(curl -s -H 'x-forwarded-proto: https' -o /tmp/bim_tender_health_check.json -w '%{http_code}' http://localhost:3001/api/health || true) &&
  [ \"\${ROOT_STATUS}\" = '200' ] &&
  [ \"\${AUTH_STATUS}\" = '401' ] &&
  if [ \"\${HEALTH_STATUS}\" = '200' ]; then
    cat /tmp/bim_tender_health_check.json;
  elif [ \"\${HEALTH_STATUS}\" = '401' ]; then
    printf '{\"status\":\"ok\",\"health\":\"protected\",\"auth\":\"required\"}\n';
  else
    echo \"Unexpected health status: \${HEALTH_STATUS}\" >&2;
    cat /tmp/bim_tender_health_check.json >&2 || true;
    exit 1;
  fi
"

echo
echo "==> Deploy complete"
echo "    host: ${TARGET_HOST}"
echo "    version: ${VERSION}"
echo "    backup: ${BACKUP_FILE}"
