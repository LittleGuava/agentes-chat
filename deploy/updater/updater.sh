#!/usr/bin/env bash
# Updates the app of a docker-compose.yml stack when the app asks, with a copy of the database first and the way back
# when the new version never gets healthy (ADR 0200). It runs in the `updater` service, the only container with the
# Docker socket; the app only leaves a file in a folder they share and reads the status this script writes.
#   updater.sh watch   every UPDATER_POLL_SECONDS: one tick
#   updater.sh tick    finish an update a previous run left halfway, say it is alive, and run one update when asked
#
# Whatever the request file holds is never read: it can't choose an image, a version, a flag or a path. An update
# moves the `agentes` service to whatever its image reference (AGENTES_IMAGE) points at in the registry now, and never
# a reference pinned by digest.
#
# Folders (the compose service mounts them): UPDATER_PROJECT_DIR the compose folder, read-only (/project);
# UPDATER_REQUESTS_DIR the app's requests (/updater/requests); UPDATER_STATUS_DIR what the app reads
# (/updater/status); UPDATER_DATA_DIR this script's own, never the app's: the copies and the run in progress
# (/var/lib/agentes-updater).
set -uo pipefail

project=${UPDATER_PROJECT_DIR:-/project}
requests=${UPDATER_REQUESTS_DIR:-/updater/requests}
status_dir=${UPDATER_STATUS_DIR:-/updater/status}
data=${UPDATER_DATA_DIR:-/var/lib/agentes-updater}
wait_seconds=${UPDATER_WAIT_SECONDS:-300}
cooldown=${UPDATER_COOLDOWN_SECONDS:-240}
# The app image's `bun` user, which must be able to write a request. Empty: leave the folder as it is.
app_uid=${UPDATER_APP_UID-1000}
backups=$data/backups
run_file=$data/run
# The running image, tagged before anything stops, so the way back never depends on the registry.
previous=agentes-updater:previous
keep=3

dc() { docker compose --project-directory "$project" "$@"; }
# The stack's project name, as Compose labelled this container: inside it, the folder's name is /project's.
know_project() {
  [[ -n ${COMPOSE_PROJECT_NAME:-} ]] && return 0
  if ! COMPOSE_PROJECT_NAME=$(docker inspect --format '{{index .Config.Labels "com.docker.compose.project"}}' "$HOSTNAME"); then
    return 1
  fi
  [[ -n $COMPOSE_PROJECT_NAME ]] || return 1
  export COMPOSE_PROJECT_NAME
}
pg() { dc exec -T postgres "$@"; }
now() { date -u +%Y-%m-%dT%H:%M:%SZ; }
json() { if [[ -n $1 ]]; then printf '"%s"' "$1"; else printf null; fi; }

# The run in progress, in this script's own folder: what a later start needs to finish it.
step="" ref="" old="" new="" dump="" started=""
save_run() {
  printf 'step=%s\nref=%s\nold=%s\nnew=%s\ndump=%s\nstarted=%s\n' \
    "$step" "$ref" "$old" "$new" "$dump" "$started" >"$run_file.tmp" && mv "$run_file.tmp" "$run_file"
}
load_run() {
  local key value
  while IFS='=' read -r key value; do
    case $key in
    step) step=$value ;;
    ref) ref=$value ;;
    old) old=$value ;;
    new) new=$value ;;
    dump) dump=$value ;;
    started) started=$value ;;
    esac
  done <"$run_file"
}

# status STATE [STEP] [REASON]: the file the app reads, replaced whole.
status() {
  local state=$1 at=${2:-} reason=${3:-} finished=""
  [[ $state == running ]] || finished=$(now)
  printf '{"state":"%s","step":%s,"reason":%s,"startedAt":%s,"finishedAt":%s,"from":%s,"to":%s}\n' \
    "$state" "$(json "$at")" "$(json "$reason")" "$(json "$started")" "$(json "$finished")" \
    "$(json "$old")" "$(json "$new")" >"$status_dir/status.json.tmp" &&
    mv "$status_dir/status.json.tmp" "$status_dir/status.json"
}

at() {
  step=$1
  save_run
  status running "$step"
}

finish() {
  rm -f "$run_file"
  status "$@"
}

started_app() { dc up --detach --wait --wait-timeout "$wait_seconds" --no-deps agentes; }

# The previous image under the app's reference again, and started. With `restore`, the copy goes back first: the new
# version may have migrated the database. Never without a copy that was checked.
way_back() {
  if [[ ${1:-} == restore ]]; then
    dc stop agentes
    [[ -s $dump ]] || return 1
    pg dropdb -U agentes --force agentes || return 1
    pg createdb -U agentes agentes || return 1
    pg pg_restore -U agentes -d agentes --no-owner --exit-on-error <"$dump" || return 1
  fi
  docker tag "$previous" "$ref" || return 1
  started_app
}

keep_newest() {
  local files=("$backups"/before-*.dump) i
  [[ -e ${files[0]} ]] || return 0
  for ((i = 0; i < ${#files[@]} - keep; i++)); do rm -f "${files[$i]}"; done
}

update() {
  step="" ref="" old="" new="" dump="" started=$(now)
  local cid
  date +%s >"$data/last-run"
  at pulling
  cid=$(dc ps -q agentes) || cid=""
  if [[ -z $cid ]]; then
    finish failed "" no_app
    return
  fi
  old=$(docker inspect --format '{{.Image}}' "$cid") || old=""
  ref=$(docker inspect --format '{{.Config.Image}}' "$cid") || ref=""
  if [[ -z $old || -z $ref ]]; then
    finish failed "" no_app
    return
  fi
  if [[ $ref == *@* ]]; then
    finish pinned
    return
  fi
  if ! dc pull --quiet agentes; then
    finish failed "" pull
    return
  fi
  new=$(docker image inspect --format '{{.Id}}' "$ref") || new=""
  if [[ -z $new ]]; then
    finish failed "" pull
    return
  fi
  if [[ $new == "$old" ]]; then
    finish current
    return
  fi
  if ! docker tag "$old" "$previous"; then
    finish failed "" pull
    return
  fi

  at stopping
  dc stop agentes

  dump=$backups/before-$(date -u +%Y%m%dT%H%M%SZ).dump
  at backing_up
  mkdir -p "$backups"
  if ! pg pg_dump -U agentes -d agentes -Fc >"$dump" || [[ ! -s $dump ]]; then
    rm -f "$dump"
    dump=""
    way_back
    finish failed "" backup
    return
  fi
  keep_newest

  at starting
  if started_app; then
    finish updated
    return
  fi
  at rolling_back
  if way_back restore; then
    finish rolled_back "" unhealthy
  else
    finish failed "" rollback
  fi
}

# A run this script never finished (the host restarted, the helper was stopped): never leave the app stopped.
# While pulling, the app was still running: nothing to undo.
recover() {
  load_run
  local was=$step back=0
  date +%s >"$data/last-run"
  case $was in
  pulling) ;;
  starting | rolling_back) way_back restore || back=$? ;;
  *) way_back || back=$? ;;
  esac
  if ((back == 0)); then
    finish interrupted
  else
    finish failed "" rollback
  fi
}

cooling() {
  local last
  last=$(cat "$data/last-run" 2>/dev/null) || return 1
  (($(date +%s) - last < cooldown))
}

tick() {
  mkdir -p "$requests" "$status_dir" "$data"
  if [[ -n $app_uid ]]; then
    chown "$app_uid" "$requests" && chmod 0700 "$requests"
  fi
  touch "$status_dir/alive"
  if [[ -f $run_file ]]; then
    know_project || return 1
    recover
    return
  fi
  [[ -e $requests/request ]] || return 0
  cooling && return 0
  know_project || return 1
  rm -rf -- "$requests/request"
  update
}

case ${1:-} in
tick) tick ;;
watch)
  while true; do
    tick
    sleep "${UPDATER_POLL_SECONDS:-5}"
  done
  ;;
*)
  echo "usage: updater.sh watch | tick" >&2
  exit 2
  ;;
esac
