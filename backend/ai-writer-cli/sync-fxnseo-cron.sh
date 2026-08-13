#!/usr/bin/env bash
# Publish new Strapi fxnseo-posts to the live fxnseo.com blog.
#
# Cron has no nvm and almost no PATH, so node is resolved explicitly here rather
# than relying on the login shell.
set -uo pipefail

# cron supplies HOME, but a bare environment does not and nvm needs it. Setting
# it here means the script cannot fail depending on who invokes it.
export HOME=${HOME:-/root}
export PATH=${PATH:-/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin}
export NVM_DIR=/root/.nvm
# shellcheck disable=SC1091
. "$NVM_DIR/nvm.sh" >/dev/null 2>&1
nvm use 22 >/dev/null 2>&1

CLI_DIR=/opt/strapi-cms-git/backend/ai-writer-cli
LOG=/var/log/fxnseo-sync.log

cd "$CLI_DIR" || exit 1

# A run that overlaps the previous one could import the same slug twice, so a
# lock is cheaper than making the importer transactional.
exec 9>/var/lock/fxnseo-sync.lock
flock -n 9 || { echo "[$(date '+%F %T')] previous run still going, skipping" >>"$LOG"; exit 0; }

node sync-fxnseo-posts.js --write >>"$LOG" 2>&1
status=$?
[ $status -ne 0 ] && echo "[$(date '+%F %T')] sync exited $status" >>"$LOG"
# Keep the log from growing without bound.
tail -n 2000 "$LOG" > "$LOG.tmp" 2>/dev/null && mv "$LOG.tmp" "$LOG"
exit 0
