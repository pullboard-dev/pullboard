/** @pullboard-module-loads apps/cli/src/io/resident/board.js apps/cli/src/io/commands/doctor.js */
/**
 * The thin side of the pullboard command: hand a board command to this checkout's resident board process over a
 * local socket and stream back its output and exit code [H24,C7]. A fresh node process loads 900-1,300 modules
 * before any work; the resident process has them loaded already. This module loads only node: built-ins, so the
 * thin path stays under 20 modules, and every case it cannot serve returns null so the entry runs the command
 * in-process exactly as before.
 */
import {
  spawn,
  spawnSync,
} from 'node:child_process';
import { createHash } from 'node:crypto';
import {
  existsSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  statSync,
  unlinkSync,
} from 'node:fs';
import { connect } from 'node:net';
import {
  dirname,
  join,
  resolve,
} from 'node:path';
import { fileURLToPath } from 'node:url';
import { inflateSync } from 'node:zlib';

/** The CLI entry this client serves; the resident process runs its code. */
export const PULLBOARD_ENTRY = fileURLToPath(new URL('../../../pullboard.js', import.meta.url));
/** The resident process's entry, started detached on first use. */
export const RESIDENT_ENTRY = fileURLToPath(new URL('./board.js', import.meta.url));

/**
 * Commands the resident process runs. Each is a bounded board read or move that reads no stdin and installs no
 * signal handler; servers, hooks, the gate, landing and interactive setup keep their own process.
 */
export const RESIDENT_COMMANDS = new Set(['add', 'agents', 'answer', 'claim', 'decisions', 'edit', 'escalate', 'fact', 'help',
  'heartbeat', 'hold', 'inbox', 'lanes', 'list', 'log', 'next', 'release', 'roadmap', 'seats', 'shout', 'show', 'stats', 'status',
  'version', 'whoami', 'why']);

/** Unix socket paths are limited to about 104 bytes on macOS; a longer one falls back in-process. */
const SOCKET_PATH_LIMIT = 100;

/**
 * How long a command may run in the resident process before the next command skips it and reads the board directly.
 * Why: the process serves one command at a time, and a status that ran 6 minutes held 15 seats' commands behind it.
 */
export const RESIDENT_BUSY_DIRECT_MS = 250;
/** How long a client waits for its command to start before it runs the command in-process instead [C7]. */
export const RESIDENT_START_WAIT_MS = 1_500;
/** The latest a resident process starts a queued command, counted from the client's send; past it the client has left. */
export const RESIDENT_START_CUTOFF_MS = 1_000;
/**
 * The longest a resident process may run one command; past it the command is ended with an error and the process
 * retires, so its slot frees. Why: on 10 Nov all four slots held commands that had hung 3-11 h at no CPU, so every
 * call ran cold (~1 s, ~1,750 modules) instead of warm (~0.25 s, 19 modules) [C7,#5470].
 */
export const RESIDENT_COMMAND_CEILING_MS = 60_000;
/** How far past the ceiling a busy file may age before a client treats its process as wedged and replaces it. */
export const RESIDENT_WEDGED_GRACE_MS = 10_000;

/** The ceiling in effect: PULLBOARD_RESIDENT_COMMAND_MS when set to a positive number, else the default. */
export function residentCommandCeiling(env = process.env) {
  const ms = Number(env.PULLBOARD_RESIDENT_COMMAND_MS);
  return Number.isFinite(ms) && ms > 0 ? ms : RESIDENT_COMMAND_CEILING_MS;
}

/** The busy file a resident process writes beside its pid file while a command runs: `<pid> <started ms>`. */
export function residentBusyFile(pidFile) {
  return pidFile.replace(/\.pid$/u, '') + '.busy';
}

/**
 * Whether the resident process has been running one command for longer than RESIDENT_BUSY_DIRECT_MS. Read from a file
 * so it holds while that command blocks the process's event loop, which then answers nothing on its socket.
 */
export function residentBusy(pidFile, now = Date.now(), env = process.env) {
  try {
    const [pid, at] = readFileSync(residentBusyFile(pidFile), 'utf8').trim().split(' ').map(Number);
    if (!Number.isSafeInteger(pid) || !Number.isFinite(at) || now - at <= RESIDENT_BUSY_DIRECT_MS) return false;
    process.kill(pid, 0);
    // A command past its ceiling and grace is wedged (its own timer never fired, so its event loop is blocked or the
    // process is stuck): the slot is not busy, it is dead, and is freed for a successor.
    if (now - at > residentCommandCeiling(env) + RESIDENT_WEDGED_GRACE_MS) return !reapWedged(pidFile, pid);
    return true;
  } catch (error) { return error?.code === 'EPERM'; }
}

/**
 * End a wedged resident process and clear its files so the slot starts a fresh one. Only the process the pid file
 * still names is signalled, so a recycled pid is never hit. True when the slot was cleared.
 */
function reapWedged(pidFile, pid) {
  try {
    if (Number(readFileSync(pidFile, 'utf8').trim()) !== pid) return false;
    process.kill(pid, 'SIGKILL');
    for (const file of [residentBusyFile(pidFile), pidFile]) try { unlinkSync(file); } catch { /* Already gone. */ }
    return true;
  } catch { return false; }
}

/** Find the Git metadata above a directory without starting Git: the checkout root, its Git dir and the shared one. */
export function gitLocation(start, { walk = true } = {}) {
  let root = resolve(start);
  while (!existsSync(join(root, '.git'))) {
    const parent = dirname(root);
    if (!walk || parent === root) return null;
    root = parent;
  }
  const marker = join(root, '.git');
  let gitDir = marker;
  if (!statSync(marker).isDirectory()) {
    const match = /^gitdir:\s*(.+)$/u.exec(readFileSync(marker, 'utf8').trim());
    if (!match) return null;
    gitDir = resolve(root, match[1].trim());
  }
  const commonFile = join(gitDir, 'commondir');
  const commonDir = existsSync(commonFile) ? resolve(gitDir, readFileSync(commonFile, 'utf8').trim()) : gitDir;
  return { root, gitDir, commonDir, linked: gitDir !== commonDir };
}

/** Resolve a checkout's HEAD commit from its files: a detached hash, a loose ref, or a packed ref. */
export function headCommit({ gitDir, commonDir }) {
  const head = readFileSync(join(gitDir, 'HEAD'), 'utf8').trim();
  if (!head.startsWith('ref:')) return head;
  const ref = head.slice('ref:'.length).trim();
  for (const dir of [gitDir, commonDir]) {
    try { return readFileSync(join(dir, ref), 'utf8').trim(); } catch { /* Try the next place a ref can live. */ }
  }
  const packed = readFileSync(join(commonDir, 'packed-refs'), 'utf8').split('\n').find(line => line.endsWith(` ${ref}`));
  return packed ? packed.split(' ')[0] : null;
}

/** The top-level paths whose files the resident process loads; a commit touching only other paths leaves it current. */
const CODE_PATHS = ['apps', 'bin', 'package.json', 'packages', 'src'];

/** One loose Git object's type and body, or null when it is packed or absent so Git itself must answer. */
function looseObject(commonDir, oid) {
  try {
    const raw = inflateSync(readFileSync(join(commonDir, 'objects', oid.slice(0, 2), oid.slice(2))));
    return { type: raw.subarray(0, raw.indexOf(32)).toString(), body: raw.subarray(raw.indexOf(0) + 1) };
  } catch { return null; }
}

/**
 * What `git ls-tree <commit> -- CODE_PATHS` prints, read from the commit's loose objects with no Git process; null when
 * an object is packed or the repository is not SHA-1, so Git answers (#6170).
 */
function listedFromObjects(commonDir, commit) {
  const head = /^[0-9a-f]{40}$/u.test(commit ?? '') ? looseObject(commonDir, commit) : null;
  const tree = head?.type === 'commit' ? /^tree ([0-9a-f]{40})$/mu.exec(head.body.toString('latin1'))?.[1] : null;
  const root = tree ? looseObject(commonDir, tree) : null;
  if (root?.type !== 'tree') return null;
  const bytes = root.body;
  let listed = '';
  for (let at = 0; at < bytes.length;) {
    const space = bytes.indexOf(32, at), nul = bytes.indexOf(0, space);
    if (space < 0 || nul < 0) return null;
    const mode = bytes.toString('latin1', at, space), name = bytes.toString('utf8', space + 1, nul);
    const oid = bytes.subarray(nul + 1, nul + 21).toString('hex');
    at = nul + 21;
    if (CODE_PATHS.includes(name)) listed += `${mode.padStart(6, '0')} ${mode === '40000' ? 'tree' : mode === '160000' ? 'commit' : 'blob'} ${oid}\t${name}\n`;
  }
  return listed;
}

/**
 * Name the code in a checkout's HEAD: a hash of the Git tree ids of the paths the CLI loads. A landing commit that
 * only changes tests, docs or the spec leaves the name alone, so the warm resident process keeps serving [C7,#3249].
 * Null when Git cannot answer. The tree is read from loose objects first, so a checkout whose HEAD is loose starts no Git process (#6170).
 */
function codeTreeName(location, commit) {
  try {
    const listed = listedFromObjects(location.commonDir, commit)
      ?? (() => { const run = spawnSync('git', ['ls-tree', commit, '--', ...CODE_PATHS], { cwd: location.root, encoding: 'utf8', timeout: 5000 }); return run.status === 0 ? run.stdout : null; })();
    if (!listed) return null;
    return createHash('sha256').update(listed).digest('hex').slice(0, 24);
  } catch { return null; }
}

/**
 * Name the code an entry would run: the Git tree ids of its checkout's code paths at HEAD, or for an installed package
 * the package and entry file stamps. A resident process loaded from different code is retired, so changed code reaches
 * the next command, while a commit that leaves the code alone does not retire it.
 */
export function codeVersion(entry) {
  const codeRoot = dirname(dirname(dirname(entry))); // apps/cli/pullboard.js sits three levels below the root [V32]
  const location = gitLocation(codeRoot, { walk: false });
  if (location) {
    const commit = headCommit(location);
    const tree = codeTreeName(location, commit);
    return { version: tree ? `code:${tree}` : `commit:${commit}`, linked: location.linked };
  }
  const stamp = file => { const stat = statSync(file); return `${stat.size}.${stat.mtimeMs}`; };
  return { version: `files:${stamp(join(codeRoot, 'package.json'))}:${stamp(entry)}`, linked: false };
}

/**
 * Whether this invocation may use a resident process. PULLBOARD_RESIDENT=0 turns it off and =1 turns it on. Without
 * either, test runs keep one process per command, and a linked worktree's own code (an agent's work in progress,
 * edited without commits) keeps running fresh.
 */
export function residentAllowed(env, linked) {
  if (env.PULLBOARD_RESIDENT === '0') return false;
  if (env.PULLBOARD_RESIDENT === '1') return true;
  if (env.NODE_TEST_CONTEXT || env.PULLBOARD_TEST_RUNNER_PID || env.PULLBOARD_TRANSIENT === '1') return false;
  return !linked;
}

/** Whether a command line is one the resident process serves: a listed command that neither waits nor acts as the person. */
export function residentCommand(argv) {
  // test --status only reads one run's row and prints it; a test run itself, --wait and --test-run keep their process.
  const status = argv[0] === 'test' && argv.slice(1).some(arg => arg === '--status' || arg.startsWith('--status='));
  if (!RESIDENT_COMMANDS.has(argv[0]) && !status) return false;
  for (let index = 1; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === '--') return false;
    if (arg === '--wait' || arg.startsWith('--wait=')) return false;
    if (status && (arg === '--test-run' || arg.startsWith('--test-run='))) return false;
    if (arg === '--as' && argv[index + 1] === 'person' || arg === '--as=person') return false;
  }
  return true;
}

/** Whether a resident command may start a resident process when none serves it: every one but `test --status` [#5888]. */
export function residentStarts(argv) {
  return argv[0] !== 'test';
}

/**
 * A private short folder for sockets whose board path is too long for a Unix socket: one per user under /tmp, used
 * only when it is a real directory this user owns that no one else can enter.
 */
function shortSocketFolder() {
  const folder = join('/tmp', `pullboard-${process.getuid()}`);
  try { mkdirSync(folder, { mode: 0o700 }); } catch (error) { if (error.code !== 'EEXIST') return null; }
  const stat = lstatSync(folder);
  return stat.isDirectory() && stat.uid === process.getuid() && (stat.mode & 0o077) === 0 ? folder : null;
}

/**
 * Where this board's resident process for one entry listens, and its pid file: under the board's .git/pullboard,
 * or, when that path is too long for a Unix socket, under a private /tmp folder named by its hash. Null without a
 * board here. Slot 0 is the first process of the pool; each further slot is a separate process with its own files.
 */
export function residentSocket(cwd, entry, slot = 0) {
  const location = gitLocation(cwd);
  if (!location) return null;
  const folder = join(location.commonDir, 'pullboard');
  if (!existsSync(join(folder, 'board.sqlite'))) return null;
  const name = createHash('sha256').update(resolve(entry)).digest('hex').slice(0, 12) + (slot ? `-${slot}` : '');
  const home = dirname(location.commonDir);
  const pid = join(folder, `resident-${name}.pid`);
  let socket = join(folder, `resident-${name}.sock`);
  if (process.platform === 'win32') socket = `\\\\?\\pipe\\pullboard-${createHash('sha256').update(socket).digest('hex').slice(0, 24)}`;
  else if (Buffer.byteLength(socket) > SOCKET_PATH_LIMIT) {
    const short = shortSocketFolder();
    if (!short) return null;
    socket = join(short, `${createHash('sha256').update(socket).digest('hex').slice(0, 24)}.sock`);
  }
  return { socket, pid, home };
}

/**
 * How many resident processes one board and entry may run. Why a pool: one process runs one command at a time, and
 * on 9 Nov a single long command kept the only one busy for over 15 minutes, so every seat's show, inbox and heartbeat
 * loaded 1,700 modules cold. PULLBOARD_RESIDENT_POOL sets it; 1 restores the single process.
 */
export function residentPoolSize(env) {
  const size = Number(env.PULLBOARD_RESIDENT_POOL);
  return Number.isSafeInteger(size) && size > 0 ? size : 4;
}

/**
 * The pool slot a command goes to: the first whose process is not busy with a long command. A slot with no process yet
 * is chosen like any other; the client then starts one there and runs this command in-process. Null without a board,
 * or when every slot is busy, so the command reads the board directly.
 */
export function residentPlace(cwd, entry, env) {
  for (let slot = 0; slot < residentPoolSize(env); slot += 1) {
    const place = residentSocket(cwd, entry, slot);
    if (!place) return null;
    // A command already running a while would hold this one behind it; the next slot, or a direct read, answers sooner.
    if (!residentBusy(place.pid, Date.now(), env)) return place;
  }
  return null;
}

/**
 * Start the resident process through spawnReachable, which runs it as a one-shot launchd job where launchd exists and
 * falls back to a plain detached spawn; the command in hand still runs in-process. Why: a resident started from an app
 * inherits that app's denied Local Network permission, so the board it serves cannot reach a runner [C7,#5760].
 * The launcher loads only when a process starts, so the thin path keeps its module count.
 *
 * @param {{ socket: string, pid: string, home: string }} place
 * @param {(command: string, args: string[], options: object) => Promise<unknown>} [launch] - The starter; spawnReachable by default.
 * @returns {Promise<unknown>} Settles once the process is started, so the command in hand runs in-process only then and the entry cannot exit first.
 */
export function startResident({ socket, pid, home }, entry, version, env, launch = launchReachable) {
  try {
    const args = [RESIDENT_ENTRY, socket, entry, version, pid], options = { cwd: existsSync(home) ? home : process.cwd(), env };
    return Promise.resolve(launch(process.execPath, args, options)).catch(() => detach(args, options));
  } catch { return Promise.resolve(); /* The command runs in-process either way. */ }
}

/** Load the reachable launcher and start the command; a launcher that will not load starts it as a plain detached child. */
async function launchReachable(command, args, options) {
  try { return await (await import('../commands/doctor.js')).spawnReachable(command, args, options); } catch { return detach(args, options); }
}

/** Start the resident process as a plain detached child. */
function detach(args, { cwd, env }) {
  try {
    const child = spawn(process.execPath, args, { cwd, env, detached: true, stdio: 'ignore' });
    child.on('error', () => {});
    child.unref();
  } catch { /* The command runs in-process either way. */ }
}

/**
 * Run one command through the resident process. Resolves to its exit code, or null when the entry must run it
 * in-process: no process yet (one starts), a process loaded from other code (it retires and a new one starts), or a
 * command the process hands back, every pool process busy with a long command, or a command not started within
 * RESIDENT_START_WAIT_MS. Once the process has started the command, its result is final. `test --status` uses a running
 * process but never starts one: it reads the run receipt in-process instead.
 *
 * Why: every agent polls `test --status`, and each poll that started a resident process cost 15-25% CPU [C7,#5888].
 */
export function runResident(argv, { entry = PULLBOARD_ENTRY, cwd = process.cwd(), env = process.env, stdout = process.stdout, stderr = process.stderr, start = startResident, call = null, payload = null, onResult = () => {} } = {}) {
  let code, place, starts;
  try {
    if (!call && !residentCommand(argv)) return Promise.resolve(null);
    // The environment alone can refuse (a test run, PULLBOARD_RESIDENT=0): answer that before codeVersion asks Git [C7].
    if (!residentAllowed(env, false)) return Promise.resolve(null);
    starts = !call && residentStarts(argv);
    code = codeVersion(entry);
    if (!residentAllowed(env, code.linked)) return Promise.resolve(null);
    place = residentPlace(cwd, entry, env);
    if (!place) return Promise.resolve(null);
  } catch { return Promise.resolve(null); }
  return new Promise((done) => {
    let started = false, finished = false, buffer = '';
    const socket = connect(place.socket);
    /** Settle once: null hands the command to the in-process path, optionally starting a fresh resident process. */
    const settle = (status, { restart = false } = {}) => {
      if (finished) return;
      finished = true;
      clearTimeout(waited);
      socket.destroy();
      // The start settles before the command runs in-process: a launchd job is loaded by a child the entry must outlive.
      if (restart && starts) Promise.resolve().then(() => start(place, entry, code.version, env)).catch(() => {}).finally(() => done(status));
      else done(status);
    };
    // A command that has not started by now waits behind another; the process never starts it past the cutoff, so
    // running it in-process cannot run it twice.
    const waited = setTimeout(() => { if (!started) settle(null); }, RESIDENT_START_WAIT_MS);
    waited.unref?.();
    socket.setEncoding('utf8');
    socket.on('connect', () => {
      socket.write(JSON.stringify({ version: 1, code: code.version, sentAt: Date.now(), argv, cwd, env, ...(call ? { call, payload } : {}),
        tty: { stdout: Boolean(stdout.isTTY), stderr: Boolean(stderr.isTTY), columns: stdout.columns ?? null } }) + '\n');
    });
    socket.on('data', (chunk) => {
      buffer += chunk;
      let newline;
      while (!finished && (newline = buffer.indexOf('\n')) >= 0) {
        const frame = JSON.parse(buffer.slice(0, newline));
        buffer = buffer.slice(newline + 1);
        if (frame.t === 'start') started = true;
        else if (frame.t === 'out') stdout.write(frame.d);
        else if (frame.t === 'err') stderr.write(frame.d);
        else if (frame.t === 'result') onResult(frame.value);
        else if (frame.t === 'exit') settle(frame.code);
        else if (frame.t === 'stale') settle(null, { restart: true });
        else settle(null);
      }
    });
    socket.on('error', () => {});
    socket.on('close', () => {
      if (finished) return;
      if (!started) return settle(null, { restart: true });
      // The command may have moved the board before the process stopped, so it is never run a second time.
      stderr.write('pullboard: the resident board process stopped during this command; check its effect with pullboard show, then run it again if needed\n');
      settle(1);
    });
  });
}

/**
 * Ask a running resident process to answer one check, for a caller that would otherwise start a node child for it [C7,#5330].
 * Never starts a process and never waits for one: null when none serves this checkout, it is busy, or it hands the call
 * back, and the caller then does the work itself, as it always did.
 *
 * @param {string} call - A name the resident process answers (see calls.js).
 * @param {object} payload - The call's JSON arguments.
 * @param {{ cwd?: string, env?: object, entry?: string }} [options]
 * @returns {Promise<object | null>} The call's answer, or null.
 */
export async function callResident(call, payload, { cwd = process.cwd(), env = process.env, entry = PULLBOARD_ENTRY } = {}) {
  let value = null;
  const code = await runResident([], { entry, cwd, env, call, payload, onResult: (answer) => { value = answer; } });
  return code === 0 ? value : null;
}
