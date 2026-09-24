#!/usr/bin/env bash
# Daily nxtsmarthome.com.au article.
#
# Publishes the next unwritten topic(s) from topic_nxtsmarthome_com_au.txt, top to bottom,
# with a cover and gallery from fal.ai. Rows whose slug or title is already in
# Strapi (draft or published) are skipped by the generator, so each run simply
# takes the next one -- no bookkeeping here, and the topic file is not edited.
# A post that ends up with fewer than 2 catalogue product boxes is saved as a
# draft instead (site rule 8), and is still skipped on the next run.
#
#   run-nxtsmarthome-daily.sh            # 1 article
#   run-nxtsmarthome-daily.sh 2          # 2 articles
#   run-nxtsmarthome-daily.sh 1 other.txt
#
# Cron has no nvm and almost no PATH, so node is resolved explicitly here
# (same pattern as run-originfacts-daily.sh).
set -uo pipefail

export HOME=${HOME:-/root}
export PATH=${PATH:-/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin}
export NVM_DIR=/root/.nvm
# shellcheck disable=SC1091
. "$NVM_DIR/nvm.sh" >/dev/null 2>&1
nvm use 22 >/dev/null 2>&1

COUNT=${1:-1}
TOPICS=${2:-topic_nxtsmarthome_com_au.txt}
CLI_DIR=/opt/strapi-cms-git/backend/ai-writer-cli
LOG=/var/log/nxtsmarthome-articles.log

cd "$CLI_DIR" || exit 1

# Two overlapping runs would both pick the same next topic, so hold a lock.
exec 9>/var/lock/nxtsmarthome-articles.lock
flock -n 9 || { echo "[$(date '+%F %T')] previous run still going, skipping" >>"$LOG"; exit 0; }

echo "[$(date '+%F %T')] start -- $COUNT article(s) from $TOPICS" >>"$LOG"

node generate-nxtsmarthome-post.js --topics "$TOPICS" --count "$COUNT" --publish --images </dev/null >>"$LOG" 2>&1
status=$?
echo "[$(date '+%F %T')] finished (exit $status)" >>"$LOG"

# Keep the log from growing without bound.
if [ -f "$LOG" ] && [ "$(wc -l <"$LOG")" -gt 5000 ]; then
  tail -n 2000 "$LOG" >"$LOG.tmp" && mv "$LOG.tmp" "$LOG"
fi
exit $status
