/** Shell scripts a pull-mode runner runs for enqueue, status, pack upload and file fetch; shell and git only, no node [5465,5468]. */

/** The job ids a runner namespace accepts; anything else could escape the queue folders or the shell word. */
const JOB_ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/u;

/** Quote one literal value as a single POSIX shell word. */
export function pullWord(value) { return `'${String(value).replaceAll("'", "'\\''")}'`; }

/**
 * Refuse a job id that is not a plain folder name.
 * @param {string} id The job id.
 * @returns {string} The same id.
 */
export function pullJobId(id) {
  if (typeof id !== 'string' || !JOB_ID.test(id)) throw new Error(`invalid pull job id: ${String(id).slice(0, 40)}`);
  return id;
}

/** The runner root as a shell word: its configured folder, or the home default the worker launch uses. */
function rootWord(runner) { return runner?.root ? pullWord(runner.root) : '"$HOME/.pullboard-runner"'; }

/**
 * Build the enqueue script: stdin is one JSON line (row.json) then the frame bytes.
 * The job folder is built as queue/.tmp-<id> and renamed whole, so a runner never sees half a row; a frame that
 * is not exactly `frameBytes` long (a dropped connection) is removed instead of renamed.
 * @param {{ root?: string }} runner The runner record.
 * @param {{ id: string, frameBytes: number, agent?: string }} job The job id, the exact frame length, and an optional
 *   shell snippet that starts the runner agent (it must be safe to run when an agent already lives).
 * @returns {string} The POSIX script.
 */
export function enqueueScript(runner, { id, frameBytes, agent = '' }) {
  pullJobId(id);
  if (!Number.isSafeInteger(frameBytes) || frameBytes < 0) throw new Error('invalid pull frame length');
  return `set -e
umask 077
R=${rootWord(runner)}
mkdir -p "$R/queue" "$R/running" "$R/done"
for d in queue running done; do
  if [ -e "$R/$d/${id}" ]; then echo "duplicate job ${id}" >&2; exit 4; fi
done
T="$R/queue/.tmp-${id}"
rm -rf "$T"
mkdir "$T"
IFS= read -r ROW
printf '%s\\n' "$ROW" > "$T/row.json"
cat > "$T/frame"
N=$(wc -c < "$T/frame" | tr -d ' ')
if [ "$N" != ${frameBytes} ]; then rm -rf "$T"; echo "frame was cut short" >&2; exit 3; fi
: > "$T/wanted"
mv "$T" "$R/queue/${id}"
${agent ? `( ${agent}\n) </dev/null >/dev/null 2>&1 &\n` : ''}echo "queued ${id}"
`;
}

/**
 * Build the pack upload script: stdin is the whole pack; it lands as source.pack, then source.pack.ready is created.
 * The bytes go to a temporary file outside the job folder first, so a job that moves from queue to running mid-upload still gets them.
 * @param {{ root?: string }} runner The runner record.
 * @param {{ id: string, bytes: number }} job The job id and the exact pack length.
 * @returns {string} The POSIX script.
 */
export function packScript(runner, { id, bytes }) {
  pullJobId(id);
  if (!Number.isSafeInteger(bytes) || bytes < 0) throw new Error('invalid pull pack length');
  return `set -e
umask 077
R=${rootWord(runner)}
P="$R/.pack-${id}.tmp"
cat > "$P"
N=$(wc -c < "$P" | tr -d ' ')
if [ "$N" != ${bytes} ]; then rm -f "$P"; echo "pack was cut short" >&2; exit 3; fi
D=
for d in running queue; do
  if [ -d "$R/$d/${id}" ]; then D="$R/$d/${id}"; break; fi
done
if [ -z "$D" ]; then rm -f "$P"; echo "no such job ${id}" >&2; exit 4; fi
mv "$P" "$D/source.pack"
: > "$D/source.pack.ready"
echo "packed ${id}"
`;
}

/**
 * Build the fetch script for one file of a job (queue, running or done), optionally only its last bytes.
 * @param {{ root?: string }} runner The runner record.
 * @param {{ id: string, name: 'out.bin'|'control.log'|'exit'|'row.json', tailBytes?: number }} job What to read.
 * @returns {string} The POSIX script; it prints the file and exits 4 when there is none.
 */
export function fetchScript(runner, { id, name, tailBytes = 0 }) {
  pullJobId(id);
  if (!['out.bin', 'control.log', 'exit', 'row.json'].includes(name)) throw new Error(`pull job file not fetchable: ${name}`);
  return `R=${rootWord(runner)}
for d in done running queue; do
  F="$R/$d/${id}/${name}"
  if [ -f "$F" ]; then ${tailBytes > 0 ? `tail -c ${Math.floor(tailBytes)} "$F"` : 'cat "$F"'}; exit 0; fi
done
echo "no ${name} for ${id}" >&2
exit 4
`;
}

/**
 * Build the status script.
 * Stdin lines `W <id>` keep a job wanted, `C <id>` ask its worker to stop, `A <id>` remove its finished folder.
 * Stdout is `agent present|absent`, one `job <id> state=.. ready=.. beat=.. exit=.. alive=.. result=.. need=..` line per
 * job folder (beat in seconds, `-` when unknown), and a closing `end` so a cut connection is never read as a full answer.
 * @param {{ root?: string }} runner The runner record.
 * @returns {string} The POSIX script.
 */
export function statusScript(runner) {
  return `R=${rootWord(runner)}
umask 077
while IFS=' ' read -r OP ID; do
  case "$ID" in ''|.*|*[!A-Za-z0-9._-]*) continue;; esac
  case "$OP" in
    W) for d in queue running; do [ -d "$R/$d/$ID" ] && touch "$R/$d/$ID/wanted" 2>/dev/null; done;;
    C) for d in queue running; do [ -d "$R/$d/$ID" ] && touch "$R/$d/$ID/cancel" 2>/dev/null; done;;
    A) rm -rf "$R/done/$ID";;
  esac
done
NOW=$(date +%s)
mtime() { stat -c %Y "$1" 2>/dev/null || stat -f %m "$1" 2>/dev/null; }
pidof_file() {
  V=$(sed -n 's/.*"pid"[^0-9]*\\([0-9][0-9]*\\).*/\\1/p' "$1" 2>/dev/null | head -n 1)
  [ -n "$V" ] || V=$(tr -cs '0-9' '\\n' < "$1" 2>/dev/null | head -n 1)
  echo "$V"
}
A=absent
if [ -f "$R/agent.lock" ]; then
  AP=$(pidof_file "$R/agent.lock")
  if [ -n "$AP" ] && kill -0 "$AP" 2>/dev/null; then A=present; fi
fi
echo "agent $A"
for d in queue running done; do
  for P in "$R/$d"/*; do
    [ -d "$P" ] || continue
    ID=\${P##*/}
    case "$ID" in .*) continue;; esac
    READY=0; BEAT=-; EXIT=-; ALIVE=-; RESULT=0; NEED=-
    if [ -f "$P/control.log" ]; then
      grep -q '^PULLBOARD_RUNNER_READY ' "$P/control.log" && READY=1
      RESULT=$(grep -c '^PULLBOARD_RUNNER_RESULT ' "$P/control.log")
      if [ "$d" = running ] && [ ! -e "$P/source.pack.ready" ]; then
        NEED=$(grep -m 1 '^PULLBOARD_RUNNER_NEED ' "$P/control.log" | cut -d ' ' -f 3 | tr -d '\\n')
        [ -n "$NEED" ] || NEED=-
      fi
    fi
    if [ -f "$P/beat" ]; then
      B=$(mtime "$P/beat")
      if [ -n "$B" ]; then BEAT=$((NOW - B)); [ "$BEAT" -ge 0 ] || BEAT=0; fi
    fi
    [ -f "$P/exit" ] && EXIT=$(tr -d ' \\n\\t' < "$P/exit")
    if [ -f "$P/owner.json" ]; then
      OP=$(pidof_file "$P/owner.json")
      if [ -n "$OP" ]; then if kill -0 "$OP" 2>/dev/null; then ALIVE=1; else ALIVE=0; fi; fi
    fi
    echo "job $ID state=$d ready=$READY beat=$BEAT exit=\${EXIT:--} alive=$ALIVE result=$RESULT need=$NEED"
  done
done
echo end
`;
}
