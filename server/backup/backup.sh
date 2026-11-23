#!/bin/sh
# School's scheduled backup (flyingrobots/school#48). The `backup` service in server/compose.yaml runs
# this in the database's own image, so pg_dump is the same major version as the server it dumps.
#
#   backup.sh         dump now, prune, then again every SCHOOL_BACKUP_INTERVAL_SECONDS, until stopped
#   backup.sh once    dump now, prune, exit: 0 on success, 1 if the dump failed, 2 on bad settings
#   backup.sh --help | --schema [--human]    describe itself and its output, touch nothing, exit 0
#
# Each dump is pg_dump's custom format, written to /backups/school-<UTC time>.dump: first to a
# hidden .partial file of its own, put in place under that name only once pg_dump succeeds and
# only if no dump has the name yet, so a dump that fails leaves nothing that looks like a backup. After a good dump the newest SCHOOL_BACKUP_KEEP files named like that
# are kept and older ones deleted; nothing else in the folder is touched. A failed dump deletes
# nothing. The folder is closed to everyone but its owner (0700) and every file is 0600.
#
# The connection comes from libpq's environment (PGHOST, PGPORT, PGUSER, PGDATABASE, PGPASSWORD);
# nothing here prints it, and every message is scrubbed of PGPASSWORD before it is printed.
#
# Output (flyingrobots/school#135; docs/topics/program-output/README.md): every line, on stdout or
# stderr, is one JSON object naming its published schema (`_schema: {id, version}`), a file in
# server/backup/schemas/ beside this script (compose mounts it at /backup/schemas), with
# "kind": "backup", an "event" and this invocation's "run" id. pg_dump's own stderr is never passed
# through: from a failed dump it is the `failed` line's message, from a dump that succeeds a
# `captured` line. `--human` (alias `--humanize`) prints the same messages as prose; nothing else
# changes the format.
# Docs: docs/workflows/backup-and-restore/README.md.
set -u
umask 077

DIR=/backups
KEEP=${SCHOOL_BACKUP_KEEP:-28}
INTERVAL=${SCHOOL_BACKUP_INTERVAL_SECONDS:-21600}
# After a failed dump, try again this soon rather than a whole interval later.
RETRY=300
SCHEMAS=$(dirname "$0")/schemas
# One id per invocation, on every line: 16 random bytes as a UUID's 8-4-4-4-12 hex digits.
RUN=$(od -An -N16 -tx1 /dev/urandom | tr -d ' \n' | sed 's/^\(.\{8\}\)\(.\{4\}\)\(.\{4\}\)\(.\{4\}\)\(.\{12\}\)$/\1-\2-\3-\4-\5/')
USAGE="backup.sh [once] | --help | --schema [--human]"

HUMAN=0
MODE=schedule
BAD=
for arg in "$@"; do
  case $arg in
    --human | --humanize) HUMAN=1 ;;
    --help | -h) MODE=help ;;
    --schema) [ "$MODE" = help ] || MODE=schema ;;
    once) [ "$MODE" = schedule ] && MODE=once ;;
    *) BAD="${BAD:+$BAD }$arg" ;;
  esac
done

# $1 with PGPASSWORD, if set, replaced by "(redacted)". awk reads it from its environment, so it
# sees the password as it is, with no escape processing.
scrub() {
  printf '%s\n' "$1" | awk 'BEGIN { s = ENVIRON["PGPASSWORD"] }
    { if (s != "") { out = ""; while ((i = index($0, s)) > 0) { out = out substr($0, 1, i - 1) "(redacted)"; $0 = substr($0, i + length(s)) } $0 = out $0 } print }'
}

# $1, scrubbed, as the inside of a JSON string: backslashes, quotes and tabs escaped, lines joined with \n.
json() {
  scrub "$1" | sed -e 's/\\/\\\\/g' -e 's/"/\\"/g' -e 's/	/\\t/g' | tr -d '\r' | awk 'BEGIN { ORS = "" } NR > 1 { print "\\n" } { print }'
}

# The version of each message type's published schema: each is versioned on its own.
version() {
  case $1 in
    help | schema | started | dumped | pruned | waiting | stopped | captured | failed | error.usage | error.refused) echo 1.0.0 ;;
  esac
}

# say <type> <event> <fields> <prose>: one message of type school.backup.<type> on stdout. <fields>
# is the JSON after "event", each field preceded by a comma; <prose> is what --human prints
# instead. warn: the same, on stderr.
say() {
  if [ "$HUMAN" = 1 ]; then
    printf '%s\n' "$4"
  else
    printf '{"_schema":{"id":"school.backup.%s","version":"%s"},"kind":"backup","event":"%s"%s,"run":"%s"}\n' "$1" "$(version "$1")" "$2" "$3" "$RUN"
  fi
}
warn() { say "$@" >&2; }
refuse() {
  warn error.refused error ",\"error\":\"refused\",\"code\":2,\"message\":\"$(json "$1")\"" "error (refused): $(scrub "$1")"
  exit 2
}

if [ -n "$BAD" ]; then
  message="unknown argument $BAD; usage: $USAGE"
  warn error.usage error ",\"error\":\"usage\",\"code\":2,\"message\":\"$(json "$message")\"" "error (usage): $(scrub "$message")"
  exit 2
fi

# --help and --schema read only the published schemas beside the script: no setting, no database,
# not the folder.
published() { ls -1 "$SCHEMAS" 2>/dev/null | grep -E '^school\.backup\.[a-z.]+\.schema\.json$' | sed 's/\.schema\.json$//'; }
schemas() {
  for id in $(published); do
    v=$(sed -n 's/.*"\$id": *"[^"]*\/\([0-9][0-9.]*\)".*/\1/p' "$SCHEMAS/$id.schema.json" | head -n 1)
    if [ "$HUMAN" = 1 ]; then
      printf 'schema %s %s\n' "$id" "$v"
      cat "$SCHEMAS/$id.schema.json"
    else
      say schema schema ",\"id\":\"$id\",\"version\":\"$v\",\"schema\":$(tr -d '\n' <"$SCHEMAS/$id.schema.json")" ""
    fi
  done
}

# The help, as data: one entry a line, "<names, comma-separated>|<description>".
OPTIONS='once|Dump now, prune, and exit, instead of running the schedule.
--help,-h|Print this help and the schema of every message type, then exit 0. Reads no setting, touches nothing.
--schema|Print every published message schema, then exit 0. Reads no setting, touches nothing.
--human,--humanize|Print prose instead of JSON Lines. Nothing else switches the format.'
SETTINGS='SCHOOL_BACKUP_INTERVAL_SECONDS|Seconds between dumps on the schedule, a positive whole number. Default 21600.
SCHOOL_BACKUP_KEEP|How many dumps to keep, a positive whole number. Default 28.
PGHOST|The database server, as libpq reads it.
PGPORT|Its port, as libpq reads it.
PGUSER|The role to dump as, as libpq reads it.
PGDATABASE|The database to dump, as libpq reads it.
PGPASSWORD|The role'"'"'s password, as libpq reads it. Never printed: every message is scrubbed of it.'
EXITS='0|once: the dump succeeded. The schedule: stopped. Or --help or --schema printed.
1|once: the dump failed. Nothing was deleted and no file left behind.
2|An unknown argument, a setting that is not a positive whole number, a folder it cannot close, or no published schemas for --help or --schema. Nothing was run.'
SUMMARY="Dump School's record with pg_dump now and every SCHOOL_BACKUP_INTERVAL_SECONDS, keep the newest SCHOOL_BACKUP_KEEP dumps, and delete older ones."

if [ "$MODE" = help ] || [ "$MODE" = schema ]; then
  [ -n "$(published)" ] || refuse "no published schemas in $SCHEMAS"
fi
if [ "$MODE" = help ] && [ "$HUMAN" = 1 ]; then
  printf 'backup.sh: %s\n\nusage: %s\n\noptions:\n' "$SUMMARY" "$USAGE"
  printf '%s\n' "$OPTIONS" | awk -F'|' '{ n = $1; gsub(",", ", ", n); print "  " n "  " $2 }'
  printf '\nsettings:\n'
  printf '%s\n' "$SETTINGS" | awk -F'|' '{ print "  " $1 "  " $2 }'
  printf '\nexit codes:\n'
  printf '%s\n' "$EXITS" | awk -F'|' '{ print "  " $1 "  " $2 }'
  printf '\noutput: JSON Lines unless --human is given, each line one of these message types (--schema prints their schemas):\n'
  for id in $(published); do printf '  %s\n' "$id"; done
  printf '\n(run %s)\n' "$RUN"
  exit 0
fi
if [ "$MODE" = help ]; then
  # The data holds no quote or backslash, so it goes into JSON as it is.
  options=$(printf '%s\n' "$OPTIONS" | awk -F'|' 'BEGIN { ORS = "" } { n = split($1, f, ","); printf "%s{\"flags\":[", (NR > 1 ? "," : ""); for (i = 1; i <= n; i++) printf "%s\"%s\"", (i > 1 ? "," : ""), f[i]; printf "],\"description\":\"%s\"}", $2 }')
  settings=$(printf '%s\n' "$SETTINGS" | awk -F'|' 'BEGIN { ORS = "" } { printf "%s{\"name\":\"%s\",\"description\":\"%s\"}", (NR > 1 ? "," : ""), $1, $2 }')
  exits=$(printf '%s\n' "$EXITS" | awk -F'|' 'BEGIN { ORS = "" } { printf "%s{\"code\":%s,\"meaning\":\"%s\"}", (NR > 1 ? "," : ""), $1, $2 }')
  output=$(for id in $(published); do printf ',"%s"' "$id"; done)
  say help help ",\"command\":\"backup.sh\",\"usage\":\"$USAGE\",\"summary\":\"$SUMMARY\",\"options\":[$options],\"environment\":[$settings],\"exit\":[$exits],\"output\":[${output#,}]" ""
  schemas
  exit 0
fi
if [ "$MODE" = schema ]; then
  schemas
  exit 0
fi

whole() { case $1 in '' | *[!0-9]* | 0*) return 1 ;; *) return 0 ;; esac; }
whole "$KEEP" || refuse "SCHOOL_BACKUP_KEEP must be a positive whole number, not \"$KEEP\""
whole "$INTERVAL" || refuse "SCHOOL_BACKUP_INTERVAL_SECONDS must be a positive whole number, not \"$INTERVAL\""
chmod 700 "$DIR" 2>/dev/null || refuse "cannot close $DIR to others (chmod 700)"

# Stopped mid-dump (docker compose stop): remove this run's temporary files, and no one else's.
trap 'rm -f ${partial:+"$partial"} ${errors:+"$errors"}; say stopped stopped "" stopped; exit 0' TERM INT

# failed <file> <why>: one dump failed.
failed() { warn failed failed ",\"file\":\"$1\",\"message\":\"$(json "$2")\"" "failed: $1: $(scrub "$2")"; }

# One dump and, if it was put in place, the retention. Returns 1 if anything failed, having printed
# a `failed` line, deleted nothing and left no temporary file.
#
# The temporary files are made by mktemp, so two runs never share one, even in the same second (a
# manual `once` beside the schedule). The finished dump is put in place with `ln`, which refuses an
# existing name, so a dump never overwrites another: a second run in the same second fails, and
# the schedule tries again later.
once() {
  file="school-$(date -u +%Y%m%dT%H%M%SZ).dump"
  partial=
  errors=
  if ! partial=$(mktemp "$DIR/.school-XXXXXXXX.partial" 2>/dev/null) || ! errors=$(mktemp "$DIR/.school-XXXXXXXX.errors" 2>/dev/null); then
    [ -n "$partial" ] && rm -f "$partial"
    partial=
    errors=
    failed "$file" "cannot make a temporary file in $DIR"
    return 1
  fi
  if ! pg_dump --format=custom --file="$partial" 2>"$errors"; then
    failed "$file" "$(cat "$errors")"
    rm -f "$partial" "$errors"
    return 1
  fi
  # A dump that succeeded may still have printed (a warning): a line, never raw text.
  if [ -s "$errors" ]; then
    text=$(cat "$errors")
    warn captured captured ",\"stream\":\"stderr\",\"command\":\"pg_dump\",\"text\":\"$(json "$text")\"" "(pg_dump) $(scrub "$text")"
  fi
  if ! ln "$partial" "$DIR/$file" 2>"$errors"; then
    failed "$file" "could not put the dump in place: $(cat "$errors")"
    rm -f "$partial" "$errors"
    return 1
  fi
  rm -f "$partial" "$errors"
  bytes=$(wc -c <"$DIR/$file" | tr -d ' ')
  say dumped dumped ",\"file\":\"$file\",\"bytes\":$bytes" "dumped $file ($bytes bytes)"
  # The names sort by time; keep the newest KEEP.
  ls -1 "$DIR" 2>/dev/null | grep -E '^school-[0-9]{8}T[0-9]{6}Z\.dump$' | sort -r | tail -n +"$((KEEP + 1))" | while read -r old; do
    rm -f "$DIR/$old" 2>/dev/null && say pruned pruned ",\"file\":\"$old\"" "pruned $old"
  done
  return 0
}

if [ "$MODE" = once ]; then
  once
  exit $?
fi

say started started ",\"intervalSeconds\":$INTERVAL,\"keep\":$KEEP" "started: a dump every $INTERVAL seconds, keeping $KEEP (run $RUN)"
while :; do
  if once; then pause=$INTERVAL; else pause=$((RETRY < INTERVAL ? RETRY : INTERVAL)); fi
  say waiting waiting ",\"seconds\":$pause" "waiting $pause seconds"
  # In the background, so a stop is handled at once rather than after the sleep.
  sleep "$pause" &
  wait $!
done
