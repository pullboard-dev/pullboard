/** The runner agent: a small shell loop that claims queued jobs by rename and runs the existing worker command on files [C7,#5467]. */
/** Quote one literal value as a single POSIX shell word. */
function shellWord(value) { return `'${String(value).replaceAll("'", "'\\''")}'`; }

/**
 * POSIX shell text of the agent; argument 1 is the runner root. Tunables (seconds unless noted) come from the environment:
 * PULLBOARD_AGENT_POLL (1), PULLBOARD_AGENT_IDLE_SECONDS (600), PULLBOARD_AGENT_WANTED_SECONDS (120), PULLBOARD_AGENT_DONE_MINUTES (30).
 * Load gate [#5578]: a new job is claimed only while the machine's one-minute load average is under its core count; each
 * tick writes <root>/load (`state=ok|hold load=.. cores=.. at=..`) for the status script. PULLBOARD_AGENT_LOAD_FILE (a file
 * holding the load) and PULLBOARD_AGENT_CORES replace the machine's own readings, for tests and for capping a shared box.
 * Why a shell loop: a runner already has a node and a shell, so no daemon, launchd entry or extra runtime is installed, and
 * waiting for work costs the kernel one directory read a second. The text holds no backtick or dollar-brace, so it
 * can sit in a template literal.
 *
 * Job folder <root>/queue/<id>/ holds `input` (capsule plus spec frame, the worker's stdin), `command` (the worker's remote
 * command), and later `source.pack` then `source.pack.ready`; the coordinator touches `wanted` and may touch `cancel`.
 * Claim is mv queue/<id> running/<id>. The agent writes owner.json, pid and beat; the job wrapper writes out.bin, control.log
 * and exit, and the folder moves to done/<id> once the wrapper is gone.
 */
export const RUNNER_AGENT_SCRIPT = String.raw`
ROOT=$1
[ -n "$ROOT" ] || exit 2
POLL=$PULLBOARD_AGENT_POLL; [ -n "$POLL" ] || POLL=1
IDLE=$PULLBOARD_AGENT_IDLE_SECONDS; [ -n "$IDLE" ] || IDLE=600
WANTED=$PULLBOARD_AGENT_WANTED_SECONDS; [ -n "$WANTED" ] || WANTED=120
KEEP=$PULLBOARD_AGENT_DONE_MINUTES; [ -n "$KEEP" ] || KEEP=30
umask 077
Q=$ROOT/queue; R=$ROOT/running; D=$ROOT/done; LOCK=$ROOT/agent.lock
mkdir -p "$Q" "$R" "$D" || exit 1
now() { date +%s; }
cores() {
  if [ -n "$PULLBOARD_AGENT_CORES" ]; then echo "$PULLBOARD_AGENT_CORES"; return; fi
  getconf _NPROCESSORS_ONLN 2>/dev/null || sysctl -n hw.ncpu 2>/dev/null || echo 1
}
load1() {
  if [ -n "$PULLBOARD_AGENT_LOAD_FILE" ]; then tr -cd '0-9.' < "$PULLBOARD_AGENT_LOAD_FILE" 2>/dev/null; return; fi
  if [ -r /proc/loadavg ]; then cut -d ' ' -f 1 /proc/loadavg; return; fi
  uptime 2>/dev/null | sed 's/.*load averages*: *//' | sed 's/[ ,].*//' | tr ',' '.'
}
mtime() { stat -c %Y "$1" 2>/dev/null || stat -f %m "$1" 2>/dev/null; }
alive() { [ -n "$1" ] && kill -0 "$1" 2>/dev/null; }
if ! mkdir "$LOCK" 2>/dev/null; then
  held=$(cat "$LOCK/pid" 2>/dev/null)
  [ -n "$held" ] || { sleep 1; held=$(cat "$LOCK/pid" 2>/dev/null); }
  alive "$held" && exit 0
  rm -rf "$LOCK"; mkdir "$LOCK" 2>/dev/null || exit 0
fi
echo $$ > "$LOCK/pid"
trap 'rm -rf "$LOCK"' EXIT
trap 'exit 0' TERM INT HUP
WRAP='trap : TERM INT HUP
cd "$1" || exit 1
PULLBOARD_QUEUE_JOB=$1; export PULLBOARD_QUEUE_JOB
sh -c "$(cat command)" < input > out.bin 2> control.log
code=$?
sig=null; why=exit
if [ -f killed ]; then sig="\"SIGTERM\""; why=$(cat killed); fi
printf "{\"code\":%s,\"signal\":%s,\"reason\":\"%s\",\"at\":%s000}\n" "$code" "$sig" "$why" "$(date +%s)" > exit.tmp && mv exit.tmp exit'
finish() {
  printf '{"code":null,"signal":%s,"reason":"%s","at":%s000}\n' "$2" "$3" "$(now)" > "$R/$1/exit.tmp" && mv "$R/$1/exit.tmp" "$R/$1/exit"
  mv "$R/$1" "$D/$1" 2>/dev/null
}
stale() { m=$(mtime "$1"); [ -n "$m" ] && [ $(( $(now) - m )) -gt "$WANTED" ]; }
stop() { echo "$2" > "$R/$1/killed"; kill -s TERM -- "-$3" 2>/dev/null || kill -s TERM "$3" 2>/dev/null; }
claim() {
  [ -e "$R/$1" ] && return 0
  mv "$Q/$1" "$R/$1" 2>/dev/null || return 0
  d=$R/$1
  printf '{"pid":%s,"startedAt":%s000,"agent":"pullboard-runner-agent"}\n' "$$" "$(now)" > "$d/owner.json"
  [ -e "$d/wanted" ] || : > "$d/wanted"
  if [ -e "$d/cancel" ]; then finish "$1" null canceled-before-start; return 0; fi
  if stale "$d/wanted"; then finish "$1" null wanted-expired-before-start; return 0; fi
  if command -v setsid >/dev/null 2>&1; then
    setsid sh -c "$WRAP" wrap "$d" < /dev/null > /dev/null 2>&1 &
  else
    set -m
    sh -c "$WRAP" wrap "$d" < /dev/null > /dev/null 2>&1 &
    set +m
  fi
  echo $! > "$d/pid.tmp" && mv "$d/pid.tmp" "$d/pid"
  : > "$d/beat"
}
tend() {
  d=$R/$1
  pid=$(cat "$d/pid" 2>/dev/null)
  if [ -f "$d/exit" ]; then alive "$pid" || mv "$d" "$D/$1" 2>/dev/null; return 0; fi
  if alive "$pid"; then
    : > "$d/beat"
    [ -f "$d/killed" ] && return 0
    if [ -f "$d/cancel" ]; then stop "$1" canceled "$pid"
    elif stale "$d/wanted"; then stop "$1" wanted-expired "$pid"; fi
    return 0
  fi
  [ -z "$pid" ] && ! stale "$d/owner.json" && return 0
  finish "$1" '"LOST"' lost
}
CORES=$(cores); c=$CORES; full=0; ticks=0
gate() {
  l=$(load1); full=0; state=ok
  if [ -n "$l" ] && awk "BEGIN{exit !($l >= $c)}"; then full=1; state=hold; fi
  shown=$l; [ -n "$shown" ] || shown=-
  printf 'state=%s load=%s cores=%s at=%s\n' "$state" "$shown" "$c" "$(now)" > "$ROOT/load.tmp" && mv "$ROOT/load.tmp" "$ROOT/load"
}
idle_since=$(now)
while :; do
  busy=0; ticks=$((ticks + 1)); queued=0
  for d in "$Q"/*/; do
    [ -d "$d" ] || continue
    case $d in */.*) continue ;; esac
    queued=1; break
  done
  if [ "$queued" = 1 ] || [ "$ticks" -ge 10 ]; then gate; ticks=0; fi
  for d in "$Q"/*/; do
    [ -d "$d" ] || continue
    id=$(basename "$d")
    case $id in .*) continue ;; esac
    busy=1; [ "$full" = 1 ] || claim "$id"
  done
  for d in "$R"/*/; do
    [ -d "$d" ] || continue
    id=$(basename "$d")
    busy=1; tend "$id"
  done
  find "$D" -mindepth 1 -maxdepth 1 -mmin +"$KEEP" -exec rm -rf {} + 2>/dev/null
  if [ "$busy" = 1 ]; then idle_since=$(now)
  elif [ $(( $(now) - idle_since )) -ge "$IDLE" ]; then exit 0; fi
  sleep "$POLL"
done
`;

/**
 * One shell command that starts the agent in the background unless a live one holds agent.lock, and returns at once.
 * Why: runners need no setup, because the first enqueue starts the agent; an empty root means the default ~/.pullboard-runner.
 */
export function runnerAgentStartCommand(root = '') {
  const folder = root ? shellWord(root) : '"$HOME"/.pullboard-runner';
  return `nohup sh -c ${shellWord(RUNNER_AGENT_SCRIPT)} pullboard-runner-agent ${folder} < /dev/null > /dev/null 2>&1 &`;
}
