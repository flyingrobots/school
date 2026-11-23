#!/bin/sh
# School's scheduled backup (flyingrobots/school#48). The `backup` service in server/compose.yaml runs
# this in the database's own image, so pg_dump is the same major version as the server it dumps.
#
#   backup.sh         dump now, prune, then again every SCHOOL_BACKUP_INTERVAL_SECONDS, until stopped
#   backup.sh once    dump now, prune, exit: 0 on success, 1 if the dump failed, 2 on bad settings
#
# Each dump is pg_dump's custom format, written to /backups/school-<UTC time>.dump: first to a
# hidden .partial file of its own, put in place under that name only once pg_dump succeeds and
# only if no dump has the name yet, so a dump that fails leaves nothing that looks like a backup. After a good dump the newest SCHOOL_BACKUP_KEEP files named like that
# are kept and older ones deleted; nothing else in the folder is touched. A failed dump deletes
# nothing. The folder is closed to everyone but its owner (0700) and every file is 0600.
#
# The connection comes from libpq's environment (PGHOST, PGPORT, PGUSER, PGDATABASE, PGPASSWORD);
# nothing here prints it. Under compose the password is a file instead (flyingrobots/school#123):
# PGPASSWORD_FILE names it, it wins over a plain PGPASSWORD, and it is read into this process's
# environment only, never the container's. Every line printed, on stdout or stderr, is one JSON object with
# "kind": "backup" and an "event". Docs: docs/workflows/backup-and-restore/README.md.
set -u
umask 077

DIR=/backups
KEEP=${SCHOOL_BACKUP_KEEP:-28}
INTERVAL=${SCHOOL_BACKUP_INTERVAL_SECONDS:-21600}
# After a failed dump, try again this soon rather than a whole interval later.
RETRY=300

# $1 as the inside of a JSON string: backslashes, quotes and tabs escaped, lines joined with \n.
json() {
  printf '%s' "$1" | sed -e 's/\\/\\\\/g' -e 's/"/\\"/g' -e 's/	/\\t/g' | tr -d '\r' | awk 'BEGIN { ORS = "" } NR > 1 { print "\\n" } { print }'
}
say() { printf '{"kind":"backup",%s}\n' "$1"; }
fail() { say "$1" >&2; }

whole() { case $1 in '' | *[!0-9]* | 0*) return 1 ;; *) return 0 ;; esac; }
if ! whole "$KEEP"; then
  fail "\"event\":\"error\",\"message\":\"SCHOOL_BACKUP_KEEP must be a positive whole number, not \\\"$(json "$KEEP")\\\"\""
  exit 2
fi
if ! whole "$INTERVAL"; then
  fail "\"event\":\"error\",\"message\":\"SCHOOL_BACKUP_INTERVAL_SECONDS must be a positive whole number, not \\\"$(json "$INTERVAL")\\\"\""
  exit 2
fi
if [ -n "${PGPASSWORD_FILE:-}" ]; then
  if ! [ -f "$PGPASSWORD_FILE" ] || ! [ -r "$PGPASSWORD_FILE" ]; then
    fail "\"event\":\"error\",\"message\":\"PGPASSWORD_FILE ($(json "$PGPASSWORD_FILE")) cannot be read\""
    exit 2
  fi
  # $(...) drops the trailing newline.
  PGPASSWORD=$(cat "$PGPASSWORD_FILE")
  if [ -z "$PGPASSWORD" ]; then
    fail "\"event\":\"error\",\"message\":\"PGPASSWORD_FILE ($(json "$PGPASSWORD_FILE")) is empty\""
    exit 2
  fi
  export PGPASSWORD
fi
if ! chmod 700 "$DIR" 2>/dev/null; then
  fail "\"event\":\"error\",\"message\":\"cannot close $DIR to others (chmod 700)\""
  exit 2
fi

# Stopped mid-dump (docker compose stop): remove this run's temporary files, and no one else's.
trap 'rm -f ${partial:+"$partial"} ${errors:+"$errors"}; say "\"event\":\"stopped\""; exit 0' TERM INT

# One dump and, if it was put in place, the retention. Returns 1 if anything failed, having printed
# a `failed` line, deleted nothing and left no temporary file.
#
# The temporary files are made by mktemp, so two runs never share one, even in the same second (a
# manual `once` beside the schedule). The finished dump is put in place with `ln`, which refuses an
# existing name, so a dump never overwrites another: a second run in the same second fails, and
# the schedule tries again later.
once() {
  file="school-$(date -u +%Y%m%dT%H%M%SZ).dump"
  if ! partial=$(mktemp "$DIR/.school-XXXXXXXX.partial") || ! errors=$(mktemp "$DIR/.school-XXXXXXXX.errors"); then
    [ -n "${partial:-}" ] && rm -f "$partial"
    fail "\"event\":\"failed\",\"file\":\"$file\",\"message\":\"cannot make a temporary file in $DIR\""
    return 1
  fi
  if ! pg_dump --format=custom --file="$partial" 2>"$errors"; then
    fail "\"event\":\"failed\",\"file\":\"$file\",\"message\":\"$(json "$(cat "$errors")")\""
    rm -f "$partial" "$errors"
    return 1
  fi
  if ! ln "$partial" "$DIR/$file" 2>"$errors"; then
    fail "\"event\":\"failed\",\"file\":\"$file\",\"message\":\"$(json "could not put the dump in place: $(cat "$errors")")\""
    rm -f "$partial" "$errors"
    return 1
  fi
  rm -f "$partial" "$errors"
  bytes=$(wc -c <"$DIR/$file" | tr -d ' ')
  say "\"event\":\"dumped\",\"file\":\"$file\",\"bytes\":$bytes"
  # The names sort by time; keep the newest KEEP.
  ls -1 "$DIR" | grep -E '^school-[0-9]{8}T[0-9]{6}Z\.dump$' | sort -r | tail -n +"$((KEEP + 1))" | while read -r old; do
    rm -f "$DIR/$old" && say "\"event\":\"pruned\",\"file\":\"$old\""
  done
  return 0
}

if [ "${1:-}" = once ]; then
  once
  exit $?
fi

say "\"event\":\"started\",\"intervalSeconds\":$INTERVAL,\"keep\":$KEEP"
while :; do
  if once; then pause=$INTERVAL; else pause=$((RETRY < INTERVAL ? RETRY : INTERVAL)); fi
  say "\"event\":\"waiting\",\"seconds\":$pause"
  # In the background, so a stop is handled at once rather than after the sleep.
  sleep "$pause" &
  wait $!
done
