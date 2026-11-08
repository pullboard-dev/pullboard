/** Smoke the candidate's own CLI on a scratch board before main moves: help, init, add, list, show, claim, next and status [C7]. */
import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { mkdirSync } from 'node:fs';
import { mkdtempSync } from 'node:fs';
import { realpathSync } from 'node:fs';
import { rmSync } from 'node:fs';
import { writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Refused } from '../../../kernel/index.js';
import { gitSpawnSync } from '../../../git/index.js';

/** Each command gets this long; the whole smoke is about 15 s, so a hung command is a failure, not a wait. */
const COMMAND_MS = 30_000;
const SPEC = '# Smoke spec\n\n## G · Goals\n- G1 [approved, must] The smoke item exists. | gate: smoke\n';
const CONFIG = { gate: 'true', spec: 'SPEC.md', verify: 'any', lease: '2h', lanes: { core: { owns: ['core/'], specs: ['G1'] } } };

/** Where a green smoke is remembered: one ref per tree id, in the repository every worktree shares [C7]. */
const RECEIPT_REF = 'refs/pullboard/landing-smoke/';

/**
 * Remember that the candidate's tree passed the smoke, so `pullboard merged` for the same tree runs no second one.
 * Only a clean checkout is recorded (a dirty tree is not the committed tree) and a failed write only costs the reuse.
 *
 * @param {string} candidate - The checkout that just passed the smoke.
 * @param {typeof gitSpawnSync} [git] - Git launcher, replaceable in tests.
 * @returns {boolean} Whether a receipt was written.
 */
export function recordSmokeReceipt(candidate, git = gitSpawnSync) {
  const options = { cwd: candidate, encoding: 'utf8' };
  const clean = git(['status', '--porcelain'], options);
  const tree = git(['rev-parse', 'HEAD^{tree}'], options);
  const head = git(['rev-parse', 'HEAD'], options);
  if (clean.status !== 0 || String(clean.stdout).trim() !== '' || tree.status !== 0 || head.status !== 0) return false;
  return git(['update-ref', `${RECEIPT_REF}${String(tree.stdout).trim()}`, String(head.stdout).trim()], options).status === 0;
}

/**
 * Whether a green smoke receipt exists for this commit's tree id.
 *
 * @param {string} root - Any checkout of the repository holding the commit.
 * @param {string} commit
 * @param {typeof gitSpawnSync} git
 * @returns {boolean}
 */
function smokeReceiptExists(root, commit, git) {
  const options = { cwd: root, encoding: 'utf8' };
  const tree = git(['rev-parse', '--verify', '--quiet', `${commit}^{tree}`], options);
  if (tree.status !== 0) return false;
  return git(['rev-parse', '--verify', '--quiet', `${RECEIPT_REF}${String(tree.stdout).trim()}`], options).status === 0;
}

/** An environment that carries no seat, board or token of the caller, only what a fresh checkout would see. */
function scratchEnvironment(home) {
  const env = {};
  for (const [key, value] of Object.entries(process.env)) if (!key.startsWith('PULLBOARD_') && !key.startsWith('GIT_') && !/^(?:CLAUDE|CODEX|SSH_)/u.test(key)) env[key] = value;
  return { ...env, GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_NOSYSTEM: '1', GIT_AUTHOR_NAME: 'Smoke', GIT_AUTHOR_EMAIL: 'smoke@example.invalid',
    GIT_COMMITTER_NAME: 'Smoke', GIT_COMMITTER_EMAIL: 'smoke@example.invalid', PULLBOARD_HOME: join(home, 'pullboard-home'),
    PULLBOARD_MACHINE_HOME: join(home, 'machine-home'), PULLBOARD_USAGE_CHECKPOINT: 'inline' };
}

/**
 * Run the candidate's CLI through its everyday commands on a scratch board and refuse the landing on the first
 * non-zero exit, naming the command. No skip list applies. A candidate that ships no bin/pullboard.js has no CLI to smoke.
 *
 * It runs in the checkout it is given, which for a landing is the batch worktree that already holds the tree: the scratch
 * board, home and repository live under the OS temp folder, so nothing is written into the checkout's tracked files.
 *
 * @param {string} candidate - A checkout of the candidate tree, normally the landing worktree.
 * @param {{ record?: boolean, git?: typeof gitSpawnSync }} [options] - record: remember a green result for `pullboard merged`; git: launcher, replaceable in tests.
 * @returns {{ ran: string[] }} The commands that exited 0, in order.
 */
export function runLandingCliSmoke(candidate, { record = false, git: launch = gitSpawnSync } = {}) {
  const entry = join(candidate, 'bin', 'pullboard.js');
  if (!existsSync(entry)) return { ran: [] };
  const home = realpathSync(mkdtempSync(join(tmpdir(), 'pullboard-landing-smoke-')));
  try {
    mkdirSync(join(home, 'machine-home'));
    // A background view would outlive the smoke; the scratch machine keeps it off.
    writeFileSync(join(home, 'machine-home', 'settings.json'), JSON.stringify({ view: { background: false } }));
    const env = scratchEnvironment(home), repo = join(home, 'repo'), seat = join(home, 'seat');
    const git = (cwd, ...args) => {
      // init installs this repository's hooks, which call a pullboard that is not installed here; the scratch repository runs none.
      const result = launch(['-c', 'core.hooksPath=/dev/null', ...args], { cwd, env, encoding: 'utf8' });
      if (result.status !== 0) throw new Refused('LAND_CLI_SMOKE', `the landing smoke could not prepare its scratch repository (git ${args[0]}): ${result.stderr.trim()}`);
    };
    mkdirSync(repo);
    git(repo, 'init', '-q', '-b', 'main');
    const ran = [];
    const pullboard = (cwd, label, ...args) => {
      const result = spawnSync(process.execPath, [entry, ...args], { cwd, env, encoding: 'utf8', timeout: COMMAND_MS });
      if (result.status !== 0) {
        const lines = (result.error?.message ?? result.stderr ?? '').trim().split('\n').filter(line => line.trim() && !/ExperimentalWarning|trace-warnings/u.test(line));
        // Node prints the throwing source line and a caret first; lead with the line naming the error, such as the missing module's path.
        const named = lines.findIndex(line => /^\w*Error\b/u.test(line.trim()));
        const why = (named > 0 ? [lines[named], ...lines.slice(0, named)] : lines).slice(0, 3).join(' ');
        throw new Refused('LAND_CLI_SMOKE', `the candidate's \`pullboard ${label}\` exits ${result.status ?? result.signal ?? 'with an error'} on a scratch board: ${why}; fix it before landing`);
      }
      ran.push(label);
    };
    pullboard(repo, 'help', 'help');
    pullboard(repo, 'init', 'init');
    writeFileSync(join(repo, 'pullboard.json'), JSON.stringify(CONFIG, null, 2));
    writeFileSync(join(repo, 'SPEC.md'), SPEC);
    git(repo, 'add', '-A');
    git(repo, 'commit', '-q', '-m', 'chore: set up pullboard');
    git(repo, 'worktree', 'add', '-q', seat, '-b', 'core/smoke');
    pullboard(seat, 'join', 'join', 'core', '--model', 'smoke', '--route', 'strong');
    pullboard(repo, 'add', 'add', 'core', 'Smoke item', '--specs', 'G1', '--criterion', 'the smoke item exists');
    pullboard(seat, 'list', 'list');
    pullboard(seat, 'show', 'show', '1');
    pullboard(seat, 'claim', 'claim', '1');
    pullboard(seat, 'next', 'next');
    pullboard(seat, 'status', 'status');
    if (record) recordSmokeReceipt(candidate, launch);
    return { ran };
  } finally { rmSync(home, { recursive: true, force: true }); }
}

/**
 * Smoke a commit that is not checked out, as `pullboard merged` records one: extract its tree to a private directory
 * with git archive, which leaves the repository's worktrees and refs untouched, and run the same smoke there.
 * A tree whose landing batch already recorded a green smoke receipt is not smoked again.
 *
 * @param {string} root - Any checkout of the repository holding the commit.
 * @param {string} commit - The candidate commit.
 * @param {{ git?: typeof gitSpawnSync }} [options] - git: launcher, replaceable in tests.
 * @returns {{ ran: string[], reused?: boolean }}
 */
export function runCommitCliSmoke(root, commit, { git = gitSpawnSync } = {}) {
  if (smokeReceiptExists(root, commit, git)) return { ran: [], reused: true };
  const exists = git(['cat-file', '-e', `${commit}:bin/pullboard.js`], { cwd: root });
  if (exists.status !== 0) return { ran: [] };
  const directory = realpathSync(mkdtempSync(join(tmpdir(), 'pullboard-landing-tree-')));
  try {
    const archive = git(['archive', '--format=tar', commit], { cwd: root, maxBuffer: 1024 ** 3 });
    const unpacked = archive.status === 0 ? spawnSync('tar', ['-x', '-C', directory], { input: archive.stdout }) : archive;
    if (unpacked.status !== 0) {
      // Name the step that failed: git archive when it failed, else tar, whose error may be a spawn error with no stderr.
      const tool = archive.status === 0 ? 'tar' : 'git archive';
      const reason = String(unpacked.stderr ?? '').trim() || unpacked.error?.message || `exit ${unpacked.status ?? unpacked.signal}`;
      throw new Refused('LAND_CLI_SMOKE', `the landing smoke could not read commit ${commit.slice(0, 12)}: ${tool} failed: ${reason}`);
    }
    return runLandingCliSmoke(directory, { git });
  } finally { rmSync(directory, { recursive: true, force: true }); }
}
