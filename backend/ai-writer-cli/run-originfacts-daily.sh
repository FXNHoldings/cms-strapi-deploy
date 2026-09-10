#!/usr/bin/env bash
# Daily originfacts.com article batch.
#
# Generates the next N topics from topics_originfacts.txt, top to bottom. The
# generator comments each finished line out ("# done …"), so every run simply
# takes the first N lines that are still uncommented — no bookkeeping here.
#
#   run-originfacts-daily.sh            # 2 articles from topics_originfacts.txt
#   run-originfacts-daily.sh 5          # 5 articles
#   run-originfacts-daily.sh 2 other.txt
#
# Cron has no nvm and almost no PATH, so node is resolved explicitly here rather
# than relying on the login shell (same pattern as sync-fxnseo-cron.sh).
set -uo pipefail

export HOME=${HOME:-/root}
export PATH=${PATH:-/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin}
export NVM_DIR=/root/.nvm
# shellcheck disable=SC1091
. "$NVM_DIR/nvm.sh" >/dev/null 2>&1
nvm use 22 >/dev/null 2>&1

COUNT=${1:-2}
TOPICS=${2:-topics_originfacts.txt}
CLI_DIR=/opt/strapi-cms-git/backend/ai-writer-cli
LOG=/var/log/originfacts-articles.log

cd "$CLI_DIR" || exit 1

# Two overlapping runs would both take the same top lines and write the same
# articles twice, so hold a lock for the whole run.
exec 9>/var/lock/originfacts-articles.lock
flock -n 9 || { echo "[$(date '+%F %T')] previous run still going, skipping" >>"$LOG"; exit 0; }

remaining=$(grep -cv '^\s*#\|^\s*$' "$TOPICS" 2>/dev/null || echo 0)
echo "[$(date '+%F %T')] start — $COUNT of $remaining remaining topics in $TOPICS" >>"$LOG"

node generate-originfacts-post.js --topics "$TOPICS" --count "$COUNT" >>"$LOG" 2>&1
status=$?
echo "[$(date '+%F %T')] finished (exit $status)" >>"$LOG"

# Keep the log from growing without bound.
if [ -f "$LOG" ] && [ "$(wc -l <"$LOG")" -gt 5000 ]; then
  tail -n 2000 "$LOG" >"$LOG.tmp" && mv "$LOG.tmp" "$LOG"
fi
exit $status
