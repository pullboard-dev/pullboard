/** Complete setup with only its own writes, keeping the user's index and identity [I1,I2]. */
import {
  createHash,
  randomUUID,
} from 'node:crypto';
import {
  dirname,
  isAbsolute,
  join,
  relative,
  resolve,
  sep,
} from 'node:path';
import { createInterface } from 'node:readline';
import {
  git,
  tryGit,
} from '../../../../../packages/git/index.js';
import { loadConfig } from '../../../../../packages/config/index.js';
import {
  CODEX_MANUAL_NOTE,
  mcpSetup,
} from '../init.js';
import {
  alreadyAddedLine,
  initWaitingRows,
  waitingRowLines,
} from '../../../../../packages/blueprints/index.js';
import {
  initBlueprintLines,
  initBlueprintResult,
} from '../../../../../packages/blueprints/index.js';
import {
  askedLaneNotes,
  proposeLanes,
  refreshInitPermissions,
  relayOfferAtInit,
} from '../init.js';
import { Refused } from '../../../../../packages/kernel/index.js';
import { HOSTED_ORIGIN } from '../../../../view/index.js';
import { gitSpawnSync } from '../../../../../packages/git/index.js';
import { fileSystemAdapter } from '../../../../../packages/fs/index.js';

const fs = fileSystemAdapter();

export const SETUP_COMMIT_QUESTION = 'Commit Pullboard setup now? [Y/n] ';
export const SETUP_COMMIT_LATER = "To commit Pullboard's files: pullboard init --yes";

/** End setup with one action; the agent reads the remaining questions through resume. */
export function initNextLine(agentSession, { verbose = false } = {}) {
  if (verbose) return agentSession
    ? 'Next: run pullboard resume now to continue setup in this session; the new skills load next session, and setup does not need them.'
    : 'Next: ask your agent to set up Pullboard here; in Claude Code, start a new session first so it loads the Pullboard skills.';
  return agentSession ? 'Next: run pullboard resume to continue setup in this session.'
    : 'Next: ask your agent to run pullboard resume to finish setup.';
}

/**
 * Describe the view without suggesting process termination, including when its port belongs to another program.
 * A running view is named by app.pullboard.dev, never its bare address, which opens only to a refusal without the key.
 */
export function initViewLine(view, { verbose = false } = {}) {
  if (['started', 'running'].includes(view.state)) return `Pullboard view is running; open ${HOSTED_ORIGIN} to see your board.${verbose && view.log ? ` Log: ${view.log}` : ''}`;
  if (view.state === 'busy') return `Port ${view.port} is in use; the background view did not start.`;
  if (view.state === 'failed') return verbose
    ? `The background view did not start: ${view.message}${view.log ? ` (log: ${view.log})` : ''}`
    : 'The background view did not start; setup is ready.';
  return null;
}

/** Bind content to the executable mode Git records. */
function setupFingerprint(mode, content) {
  return createHash('sha256').update(mode + ':').update(content).digest('hex');
}

/** Hash regular files and Git's executable bit, refusing external paths and symlink targets. */
function setupFile(root, name) {
  if (typeof name !== 'string' || isAbsolute(name) || name.includes('\0')) return null;
  const path = resolve(root, name), inside = relative(root, path);
  if (!inside || inside === '..' || inside.startsWith('..' + sep)) return null;
  try {
    const stat = fs.lstat(path);
    if (!stat.isFile()) return null;
    const physical = relative(root, fs.realpath(path));
    if (physical === '..' || physical.startsWith('..' + sep)) return null;
    return setupFingerprint(stat.mode & 0o111 ? '100755' : '100644', fs.readFile(path, null));
  } catch (error) { if (error.code === 'ENOENT') return null; throw error; }
}

/** Read a regular stage-zero index entry without replacing either version of a partial edit. */
function indexedSetupFile(root, name) {
  const entry = tryGit(root, ['ls-files', '--stage', '-z', '--', `:(literal)${name}`]);
  const match = /^(100644|100755) ([a-f0-9]{40,64}) 0\t[^\0]+\0$/u.exec(entry.stdout);
  if (entry.status !== 0 || !match) return null;
  const blob = gitSpawnSync(['--no-replace-objects', 'cat-file', 'blob', match[2]],
    { cwd: root, maxBuffer: 32 * 1024 * 1024 });
  return blob.status === 0 ? setupFingerprint(match[1], blob.stdout) : null;
}

/** A literal pathspec for one setup path. */
const literal = name => `:(literal)${name}`;

/**
 * Every stage entry Git's index holds for each path, as `ls-files --stage -z -- <path>` prints it ('' for none).
 * Why: one Git call for all setup paths; init writes about thirty files and a call per path cost a process each [C7].
 * Null when Git cannot list them, so the caller asks per path instead.
 */
function indexEntries(root, names) {
  if (!names.length) return new Map();
  const listed = tryGit(root, ['ls-files', '--stage', '-z', '--', ...names.map(literal)]);
  if (listed.status !== 0) return null;
  const entries = new Map(names.map(name => [name, '']));
  for (const entry of listed.stdout.split('\0')) {
    const name = entry.slice(entry.indexOf('\t') + 1);
    if (entry && entries.has(name)) entries.set(name, entries.get(name) + entry + '\0');
  }
  return entries;
}

/** Capture existing edits before init writes, and retain only unchanged previous setup receipts. */
export function beginInitCommit(info) {
  const status = gitSpawnSync(['--no-replace-objects', 'status', '--porcelain=v1', '-z', '--untracked-files=all', '--ignored=matching'],
    { cwd: info.root, encoding: 'utf8', maxBuffer: 32 * 1024 * 1024 });
  if (status.status !== 0) throw new Refused('NOT_COMMITTED', 'Git could not read the existing changes; fix Git before running pullboard init again');
  const entries = status.stdout.split('\0'), blocked = new Set(), staged = new Set();
  for (let index = 0; index < entries.length; index++) {
    const entry = entries[index];
    if (!entry) continue;
    const name = entry.slice(3), indexChanged = ![' ', '?', '!'].includes(entry[0]);
    blocked.add(name);
    if (indexChanged) staged.add(name);
    if (/[RC]/u.test(entry.slice(0, 2))) {
      const previousName = entries[++index];
      blocked.add(previousName);
      if (indexChanged) staged.add(previousName);
    }
  }
  const file = join(info.commonDir, 'pullboard', 'setup-written-files.json');
  let previous = {};
  try {
    const saved = JSON.parse(fs.readFile(file, 'utf8'));
    if (saved.version === 1 && saved.root === info.root && saved.files && typeof saved.files === 'object') previous = saved.files;
  } catch (error) { if (error.code !== 'ENOENT' && !(error instanceof SyntaxError)) throw error; }
  const files = new Map(), skipped = new Set();
  for (const [name, hash] of Object.entries(previous)) {
    const actual = setupFile(info.root, name);
    if (hash && actual === hash && (!staged.has(name) || indexedSetupFile(info.root, name) === hash)) files.set(name, hash);
    else if (actual) skipped.add(name);
  }
  const owned = new Set(files.keys());
  const initialIndex = new Map(), unread = new Set();
  /** Retain the exact bytes init wrote, without adopting a file that already held user edits. */
  function written(name) {
    if (typeof name !== 'string') return;
    if (!owned.has(name) && [...blocked].some(path => path === name || (path?.endsWith('/') && name.startsWith(path)))) { skipped.add(name); return; }
    if (!initialIndex.has(name)) unread.add(name);
    const hash = setupFile(info.root, name);
    if (hash) { owned.add(name); files.set(name, hash); }
  }
  for (const name of files.keys()) if (!initialIndex.has(name)) unread.add(name);
  /** Read every recorded path's index entry in one call; init stages nothing until its commit, so this is the index before init. */
  function readInitialIndex() {
    const names = [...unread].filter(name => !initialIndex.has(name));
    unread.clear();
    const entries = indexEntries(info.root, names);
    for (const name of names) initialIndex.set(name, entries ? entries.get(name) : tryGit(info.root, ['ls-files', '--stage', '-z', '--', literal(name)]).stdout);
  }
  return { info, file, files, written, skipped, initialIndex, readInitialIndex };
}

/** Ask once; closing stdin is a decline, while Enter accepts the displayed file list. */
function askCommit(io) {
  return new Promise(resolveAnswer => {
    const reader = createInterface({ input: io.stdin, output: io.stdout, terminal: false });
    let answer = null;
    reader.once('line', line => { answer = line; reader.close(); });
    reader.once('close', () => { io.stdin.pause?.(); resolveAnswer(answer); });
    io.stdout.write(SETUP_COMMIT_QUESTION);
  });
}

/** Confirm and commit exact setup paths through ordinary hooks, never unrelated staged files. */
export async function finishInitCommit(plan, { io, yes, landed, permissions }) {
  const { info, files } = plan;
  if (landed.some(added => !added.marked)) {
    const config = loadConfig(info.root);
    for (const name of ['pullboard.json', config.spec, config.practice]) plan.written(name);
    if (permissions) refreshInitPermissions(info.root, plan.written);
  }
  const retained = [...files].filter(([name, hash]) => setupFile(info.root, name) === hash);
  fs.mkdir(dirname(plan.file), { recursive: true });
  const temporary = plan.file + '.' + randomUUID();
  const descriptor = fs.open(temporary, 'w', 0o600);
  try { fs.write(descriptor, JSON.stringify({ version: 1, root: info.root, files: Object.fromEntries(retained) }) + '\n'); } finally { fs.close(descriptor); }
  fs.rename(temporary, plan.file);
  // The index before any confirmation prompt, so an edit staged while it is open is detected below.
  plan.readInitialIndex();
  const head = tryGit(info.root, ['rev-parse', '--verify', 'HEAD']);
  /** Observe Git's content and mode differences without touching the user's index. */
  const differsOne = name => head.status !== 0
    || tryGit(info.root, ['diff', '--quiet', 'HEAD', '--', literal(name)]).status !== 0
    || !tryGit(info.root, ['ls-tree', 'HEAD', '--', literal(name)]).stdout;
  // One diff and one tree listing answer every path; a failed batch call falls back to asking per path [C7].
  const asked = [...new Set([...retained.map(([name]) => name), ...plan.skipped])];
  const names = (args) => {
    const listed = head.status === 0 && asked.length ? tryGit(info.root, [...args, '--', ...asked.map(literal)]) : null;
    return listed?.status === 0 ? new Set(listed.stdout.split('\0').filter(Boolean)) : null;
  };
  const modified = names(['diff', '--no-ext-diff', '--no-renames', '--name-only', '-z', 'HEAD']);
  const committed = modified && names(['ls-tree', '-r', '--name-only', '-z', 'HEAD']);
  const differs = name => (committed ? head.status !== 0 || modified.has(name) || !committed.has(name) : differsOne(name));
  const changed = retained.filter(([name]) => differs(name));
  const skipped = [...plan.skipped].filter(differs);
  if (!changed.length) return { state: 'unchanged', files: [], skipped };
  const paths = changed.map(([name]) => name);
  let accepted = Boolean(yes);
  if (!accepted && !io.json && relayOfferAtInit({ enabled: true, shared: false, stdin: io.stdin, stdout: io.stdout }) === 'ask') {
    io.say('Pullboard setup files: ' + paths.join(', '));
    const answer = await askCommit(io);
    accepted = answer !== null && ['', 'y', 'yes'].includes(answer.trim().toLowerCase());
  }
  if (!accepted) return { state: 'pending', files: paths, skipped };
  if (changed.some(([name, hash]) => setupFile(info.root, name) !== hash)) {
    throw new Refused('NOT_COMMITTED', 'a setup file changed while confirmation was open; review the change and run pullboard init --yes again');
  }
  const nowIndexed = indexEntries(info.root, paths);
  if (nowIndexed === null || changed.some(([name, hash]) => nowIndexed.get(name) !== plan.initialIndex.get(name) && indexedSetupFile(info.root, name) !== hash)) {
    throw new Refused('NOT_COMMITTED', 'a setup file was staged differently while confirmation was open; your index is unchanged; review it, then run pullboard init --yes again');
  }
  try {
    git(info.root, ['add', '-f', '--', ...paths.map(name => `:(literal)${name}`)]);
    const identity = { ...process.env };
    for (const name of ['GIT_AUTHOR_NAME', 'GIT_AUTHOR_EMAIL', 'GIT_COMMITTER_NAME', 'GIT_COMMITTER_EMAIL', 'EMAIL']) delete identity[name];
    git(info.root, ['commit', '--only', '-q', '-m', 'chore: set up Pullboard', '--', ...paths.map(name => `:(literal)${name}`)], { env: identity });
  } catch (error) {
    // Every selected path was clean or absent before init; restore only those index entries.
    if (head.status === 0) tryGit(info.root, ['reset', '-q', head.stdout, '--', ...paths.map(name => `:(literal)${name}`)]);
    else tryGit(info.root, ['rm', '--cached', '-q', '--ignore-unmatch', '--', ...paths.map(name => `:(literal)${name}`)]);
    throw new Refused('NOT_COMMITTED', `Git did not commit Pullboard setup: ${String(error.stderr ?? error.message).trim()}; fix the reported identity or hook problem, then run pullboard init --yes`, 'fix the Git error above, then run pullboard init --yes');
  }
  return { state: 'committed', files: paths, skipped, commit: git(info.root, ['rev-parse', 'HEAD']) };
}

/** Report setup and blueprint notes together, keeping the CLI command itself bounded. */
export function reportInitSetup(io, info, notes, landed, { verbose = false } = {}) {
  const fresh = landed.filter(added => !added.marked);
  const waiting = landed.length ? initWaitingRows(info.root, { rows: fresh.flatMap(added => added.rows) }) : [];
  /** Give each blueprint the same complete list of still-undecided rows. */
  const blueprintResult = added => ({ ...initBlueprintResult(added), marked: added.marked, waitingRows: waiting });
  const result = { root: info.root, notes, proposedLanes: proposeLanes(info.root), mcp: mcpSetup(notes),
    ...(landed.length ? { blueprint: blueprintResult(landed[0]), blueprints: landed.map(blueprintResult) } : {}) };
  io.result?.(result);
  const staging = notes.at(-1)?.startsWith('git add -f -- ') ? notes.at(-1) : null;
  if (!verbose) {
    io.say('Set up Pullboard: board, project rules, Git hooks and agent instructions.');
    const missingGate = notes.find(note => note.startsWith('gate command "'));
    if (missingGate) io.say(missingGate.split(';')[0] + '.');
    // An empty gate proves no code, and the first submit refuses NO_GATE: name the exact step now, not at that refusal [C7,#7753].
    if (notes.some(note => note.startsWith('no test command detected'))) {
      io.say("No test command found, so the gate is empty. Set it in this checkout: pullboard gate set '<command>', then commit pullboard.json.");
      io.say('Put a real test command there (for example npm test or pytest); the gate is what proves a build works.');
    }
    if (landed.length) io.say(`Blueprints: ${landed.length}; ${waiting.length} rows waiting for a decision.`);
    // Codex needs the person when its config writes mcp_servers inline: the exact block shows even without --verbose (#961).
    const codexManual = notes.find(note => note.startsWith(CODEX_MANUAL_NOTE));
    if (codexManual) io.say(codexManual);
    return { result, staging };
  }
  io.say('Setup details:');
  (staging ? notes.slice(0, -1) : notes).forEach(note => io.say(note));
  for (const added of landed) {
    if (added.marked) io.say(alreadyAddedLine(added.blueprint));
    else initBlueprintLines(added, askedLaneNotes(added.items, loadConfig(info.root))).forEach(line => io.say(line));
  }
  if (fresh.length) waitingRowLines(waiting).forEach(line => io.say(line));
  return { result, staging };
}
