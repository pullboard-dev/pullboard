/** Complete setup with only its own writes, keeping the user's index and identity [I1,I2]. */
import {
  createHash,
  randomUUID,
} from 'node:crypto';
import { spawnSync } from './windows-child-process.js';
import {
  lstatSync,
  mkdirSync,
  readFileSync,
  realpathSync,
  renameSync,
  writeFileSync,
} from 'node:fs';
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
} from './git.js';
import { loadConfig } from './config.js';
import {
  CODEX_MANUAL_NOTE,
  mcpSetup,
} from './init.js';
import {
  alreadyAddedLine,
  initWaitingRows,
  waitingRowLines,
} from './blueprint-report.js';
import {
  initBlueprintLines,
  initBlueprintResult,
} from './blueprint-set.js';
import {
  askedLaneNotes,
  proposeLanes,
  refreshInitPermissions,
  relayOfferAtInit,
} from './init.js';
import { Refused } from './refused.js';
import { HOSTED_ORIGIN } from './serve.js';

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
    const stat = lstatSync(path);
    if (!stat.isFile()) return null;
    const physical = relative(root, realpathSync(path));
    if (physical === '..' || physical.startsWith('..' + sep)) return null;
    return setupFingerprint(stat.mode & 0o111 ? '100755' : '100644', readFileSync(path));
  } catch (error) { if (error.code === 'ENOENT') return null; throw error; }
}

/** Read a regular stage-zero index entry without replacing either version of a partial edit. */
function indexedSetupFile(root, name) {
  const entry = tryGit(root, ['ls-files', '--stage', '-z', '--', `:(literal)${name}`]);
  const match = /^(100644|100755) ([a-f0-9]{40,64}) 0\t[^\0]+\0$/u.exec(entry.stdout);
  if (entry.status !== 0 || !match) return null;
  const blob = spawnSync('git', ['--no-replace-objects', 'cat-file', 'blob', match[2]],
    { cwd: root, maxBuffer: 32 * 1024 * 1024 });
  return blob.status === 0 ? setupFingerprint(match[1], blob.stdout) : null;
}

/** Capture existing edits before init writes, and retain only unchanged previous setup receipts. */
export function beginInitCommit(info) {
  const status = spawnSync('git', ['--no-replace-objects', 'status', '--porcelain=v1', '-z', '--untracked-files=all', '--ignored=matching'],
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
    const saved = JSON.parse(readFileSync(file, 'utf8'));
    if (saved.version === 1 && saved.root === info.root && saved.files && typeof saved.files === 'object') previous = saved.files;
  } catch (error) { if (error.code !== 'ENOENT' && !(error instanceof SyntaxError)) throw error; }
  const files = new Map(), skipped = new Set();
  for (const [name, hash] of Object.entries(previous)) {
    const actual = setupFile(info.root, name);
    if (hash && actual === hash && (!staged.has(name) || indexedSetupFile(info.root, name) === hash)) files.set(name, hash);
    else if (actual) skipped.add(name);
  }
  const owned = new Set(files.keys());
  const initialIndex = new Map();
  /** Retain the exact bytes init wrote, without adopting a file that already held user edits. */
  function written(name) {
    if (typeof name !== 'string') return;
    if (!owned.has(name) && [...blocked].some(path => path === name || (path?.endsWith('/') && name.startsWith(path)))) { skipped.add(name); return; }
    if (!initialIndex.has(name)) initialIndex.set(name, tryGit(info.root, ['ls-files', '--stage', '-z', '--', `:(literal)${name}`]).stdout);
    const hash = setupFile(info.root, name);
    if (hash) { owned.add(name); files.set(name, hash); }
  }
  for (const name of files.keys()) if (!initialIndex.has(name)) initialIndex.set(name, tryGit(info.root, ['ls-files', '--stage', '-z', '--', `:(literal)${name}`]).stdout);
  return { info, file, files, written, skipped, initialIndex };
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
  mkdirSync(dirname(plan.file), { recursive: true });
  const temporary = plan.file + '.' + randomUUID();
  writeFileSync(temporary, JSON.stringify({ version: 1, root: info.root, files: Object.fromEntries(retained) }) + '\n', { mode: 0o600 });
  renameSync(temporary, plan.file);
  const head = tryGit(info.root, ['rev-parse', '--verify', 'HEAD']);
  /** Observe Git's content and mode differences without touching the user's index. */
  const differs = name => head.status !== 0
    || tryGit(info.root, ['diff', '--quiet', 'HEAD', '--', `:(literal)${name}`]).status !== 0
    || !tryGit(info.root, ['ls-tree', 'HEAD', '--', `:(literal)${name}`]).stdout;
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
  if (changed.some(([name, hash]) => {
    const index = tryGit(info.root, ['ls-files', '--stage', '-z', '--', `:(literal)${name}`]);
    return index.status !== 0 || (index.stdout !== plan.initialIndex.get(name) && indexedSetupFile(info.root, name) !== hash);
  })) {
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
