/** @pullboard-module-loads bin/resident-board.js */
/**
 * The thin side of the pullboard command: hand a board command to this checkout's resident board process over a
 * local socket and stream back its output and exit code [H24,C7]. A fresh node process loads 900-1,300 modules
 * before any work; the resident process has them loaded already. This module loads only node: built-ins, so the
 * thin path stays under 20 modules, and every case it cannot serve returns null so the entry runs the command
 * in-process exactly as before.
 */
import { spawn, spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import {
  existsSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  statSync,
} from 'node:fs';
import { connect } from 'node:net';
import {
  dirname,
  join,
  resolve,
} from 'node:path';
import { fileURLToPath } from 'node:url';

/** The CLI entry this client serves; the resident process runs its code. */
export const PULLBOARD_ENTRY = fileURLToPath(new URL('./pullboard.js', import.meta.url));
/** The resident process's entry, started detached on first use. */
export const RESIDENT_ENTRY = fileURLToPath(new URL('./resident-board.js', import.meta.url));

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

/** The busy file a resident process writes beside its pid file while a command runs: `<pid> <started ms>`. */
export function residentBusyFile(pidFile) {
  return pidFile.replace(/\.pid$/u, '') + '.busy';
}

/**
 * Whether the resident process has been running one command for longer than RESIDENT_BUSY_DIRECT_MS. Read from a file
 * so it holds while that command blocks the process's event loop, which then answers nothing on its socket.
 */
export function residentBusy(pidFile, now = Date.now()) {
  try {
    const [pid, at] = readFileSync(residentBusyFile(pidFile), 'utf8').trim().split(' ').map(Number);
    if (!Number.isSafeInteger(pid) || !Number.isFinite(at) || now - at <= RESIDENT_BUSY_DIRECT_MS) return false;
    process.kill(pid, 0);
    return true;
  } catch (error) { return error?.code === 'EPERM'; }
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

/**
 * Name the code in a checkout's HEAD: a hash of the Git tree ids of the paths the CLI loads. A landing commit that
 * only changes tests, docs or the spec leaves the name alone, so the warm resident process keeps serving [C7,#3249].
 * Null when Git cannot answer.
 */
function codeTreeName(root, commit) {
  try {
    const listed = spawnSync('git', ['ls-tree', commit, '--', ...CODE_PATHS], { cwd: root, encoding: 'utf8', timeout: 5000 });
    if (listed.status !== 0 || !listed.stdout) return null;
    return createHash('sha256').update(listed.stdout).digest('hex').slice(0, 24);
  } catch { return null; }
}

/**
 * Name the code an entry would run: the Git tree ids of its checkout's code paths at HEAD, or for an installed package
 * the package and entry file stamps. A resident process loaded from different code is retired, so changed code reaches
 * the next command, while a commit that leaves the code alone does not retire it.
 */
export function codeVersion(entry) {
  const codeRoot = dirname(dirname(entry));
  const location = gitLocation(codeRoot, { walk: false });
  if (location) {
    const commit = headCommit(location);
    const tree = codeTreeName(location.root, commit);
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
  if (!RESIDENT_COMMANDS.has(argv[0])) return false;
  for (let index = 1; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === '--') return false;
    if (arg === '--wait' || arg.startsWith('--wait=')) return false;
    if (arg === '--as' && argv[index + 1] === 'person' || arg === '--as=person') return false;
  }
  return true;
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
 * board here.
 */
export function residentSocket(cwd, entry) {
  const location = gitLocation(cwd);
  if (!location) return null;
  const folder = join(location.commonDir, 'pullboard');
  if (!existsSync(join(folder, 'board.sqlite'))) return null;
  const name = createHash('sha256').update(resolve(entry)).digest('hex').slice(0, 12);
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

/** Start the resident process detached; the command in hand still runs in-process. */
export function startResident({ socket, pid, home }, entry, version, env) {
  try {
    const child = spawn(process.execPath, [RESIDENT_ENTRY, socket, entry, version, pid],
      { cwd: existsSync(home) ? home : process.cwd(), env, detached: true, stdio: 'ignore' });
    child.on('error', () => {});
    child.unref();
  } catch { /* The command runs in-process either way. */ }
}

/**
 * Run one command through the resident process. Resolves to its exit code, or null when the entry must run it
 * in-process: no process yet (one starts), a process loaded from other code (it retires and a new one starts), or a
 * command the process hands back, a process busy with a long command, or a command not started within
 * RESIDENT_START_WAIT_MS. Once the process has started the command, its result is final.
 */
export function runResident(argv, { entry = PULLBOARD_ENTRY, cwd = process.cwd(), env = process.env, stdout = process.stdout, stderr = process.stderr } = {}) {
  let code, place;
  try {
    if (!residentCommand(argv)) return Promise.resolve(null);
    code = codeVersion(entry);
    if (!residentAllowed(env, code.linked)) return Promise.resolve(null);
    place = residentSocket(cwd, entry);
    if (!place) return Promise.resolve(null);
    // A command already running a while would hold this one behind it; reading the board directly costs about 1 s.
    if (residentBusy(place.pid)) return Promise.resolve(null);
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
      if (restart) startResident(place, entry, code.version, env);
      done(status);
    };
    // A command that has not started by now waits behind another; the process never starts it past the cutoff, so
    // running it in-process cannot run it twice.
    const waited = setTimeout(() => { if (!started) settle(null); }, RESIDENT_START_WAIT_MS);
    waited.unref?.();
    socket.setEncoding('utf8');
    socket.on('connect', () => {
      socket.write(JSON.stringify({ version: 1, code: code.version, sentAt: Date.now(), argv, cwd, env,
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
