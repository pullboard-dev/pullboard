/** Cell-level project fixture: the in-memory Git and board stand-ins by default, a real repo or board on request, with no pullboard init, hooks or CLI [C7]. */
import { join } from 'node:path';
import { resolve } from 'node:path';
import { mkdirSync } from 'node:fs';
import { rmSync } from 'node:fs';
import { closeBoard } from '../../index.js';
import { submitFixture } from './submit.js';
import { writeBoardMeta } from '../../index.js';
import { FIXTURE_MODEL } from '../../../../apps/cli/tests/fixtures/child.js';
// The board composition root through the board package's fixture, which tests already use (#8202).
import { openKitBoard } from '../../../../apps/cli/tests/fixtures/child.js';
import { privateFixtureFiles } from '../../../../apps/cli/tests/fixtures/child.js';
import { runFixtureChild } from '../../../../apps/cli/tests/fixtures/child.js';
import { runFixtureGit } from '../../../../apps/cli/tests/fixtures/child.js';
import { AGENT_SHELL_MARKERS } from '../../../kernel/index.js';
import { SSH_SHELL_MARKERS } from '../../../kernel/index.js';
import { addItem } from '../../index.js';
import { agentById } from '../../index.js';
import { claim } from '../../index.js';
import { getItem } from '../../index.js';
import { register } from '../../index.js';
import { criterionFreezer } from '../../../moves/index.js';
import { readSubmitRecords } from '../../../moves/index.js';
export { readSubmitRecords };
import { loadConfig } from '../../../config/index.js';
import { headCommit } from '../../../git/index.js';
import { repoInfo } from '../../../git/index.js';
import { createMemoryGitAdapter } from '../../../git/index.js';
import { enterGitAdapter } from '../../../git/index.js';

export { FIXTURE_MODEL, openKitBoard, runFixtureGit };
/** A second model name, so a later seat must register against the earlier one. */
export const FIXTURE_MODEL_EARLIER = 'Earlier Fixture Model';

/**
 * A private Git repository for tests of how committed files are read: write files, commit them, repeat.
 *
 * Why: a selection or graph test needs real Git objects and nothing else, so the one raw `git init` lives here with the
 * rest of the fixture seam instead of being copied into each test.
 *
 * @param {string} [prefix] - Lowercase name prefix of the private folder.
 * @returns {{ root: string, put: (path: string, body: string) => void, commit: () => string }} The repo root, a writer, and a committer that returns the new commit id.
 */
export function fixtureCommittedGraph(prefix = 'pullboard-graph-') {
  const files = privateFixtureFiles(prefix), root = files.root;
  const env = { ...process.env, GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_NOSYSTEM: '1',
    GIT_AUTHOR_NAME: 'Test Agent', GIT_AUTHOR_EMAIL: 'agent@example.com',
    GIT_COMMITTER_NAME: 'Test Agent', GIT_COMMITTER_EMAIL: 'agent@example.com' };
  const git = (...args) => runFixtureGit(args, { cwd: root, env });
  git('init', '-q', '-b', 'main');
  return { root, put: (path, body) => files.write(path, body), commit: () => { git('add', '-A'); git('commit', '-qm', 'chore: fixture graph'); return git('rev-parse', 'HEAD').trim(); } };
}

/** The two-lane policy the e2e project uses, so a converted test keeps the project it asserted against. */
export const CELL_CONFIG = Object.freeze({
  gate: 'true',
  spec: 'SPEC.md',
  verify: 'any',
  lease: '2h',
  landing: { perItem: false, manualOverride: true },
  lanes: { web: { owns: ['web/'], specs: ['G1'] }, api: { owns: ['api/'], specs: ['G2'] } },
  shared: ['docs/'],
});

export const CELL_SPEC = `# Demo spec

## G · Goals
- G1 [approved, must] The page renders. | gate: web test
- G2 [approved, must] The API answers. | gate: api test
`;

/**
 * Whether the running test file lives under packages/, where the stand-ins are the default [C7].
 *
 * Why: apps/ journeys start the real CLI on the repository and board, and other lanes own those files, so they keep real
 * Git and boards until each asks for the stand-ins with `real: false`. node --test runs each file as its own process, so
 * its argv names the file.
 */
const STAND_IN_DEFAULT = /[\\/]packages[\\/]/u.test(process.argv[1] ?? '');

/** The fixed identity every stand-in commit signs as, matching the real fixture's. */
const STAND_IN_IDENTITY = Object.freeze({ GIT_AUTHOR_NAME: 'Test Agent', GIT_AUTHOR_EMAIL: 'agent@example.com',
  GIT_COMMITTER_NAME: 'Test Agent', GIT_COMMITTER_EMAIL: 'agent@example.com' });

/**
 * The in-memory half of cellRepo: the policy files on disk (config readers read files) and every Git object in the
 * stand-in adapter, installed as the Git adapter of the calling test.
 *
 * Why: a test that reads committed state needs no `git init` process; the stand-in is proved equal to real Git by the
 * contract in packages/git/tests/io/journey-contract.test.js (#8086).
 */
function memoryRepo(t, files, tracked) {
  const root = files.root;
  const adapter = createMemoryGitAdapter([]);
  let tick = 0;
  const git = (...args) => {
    const date = `${1_700_000_000 + tick++} +0000`;
    return adapter.execFileSync(args, { cwd: root, env: { ...STAND_IN_IDENTITY, GIT_AUTHOR_DATE: date, GIT_COMMITTER_DATE: date }, encoding: 'utf8' });
  };
  git('init', '-q', '-b', 'main');
  const put = (path, body) => { files.write(path, body); adapter.write(root, path, Buffer.from(body)); };
  for (const [path, body] of tracked) put(path, body);
  const commitAll = () => { git('add', '-A'); git('commit', '-q', '-m', 'chore: fixture graph'); return git('rev-parse', 'HEAD').trim(); };
  enterGitAdapter(adapter);
  return { adapter, put, commitAll };
}

/**
 * A private repository holding pullboard.json and SPEC.md in one plain commit; Git is isolated from the machine.
 * In a test under packages/ the repository lives, by default, in the in-memory Git stand-in, which is installed as this test's Git adapter, so no
 * Git process starts. A test that needs real Git objects, a Git process of its own or a real `.git` folder asks with
 * `real: true` and gets a real repository. Cleanup goes through `t.after`. No hooks are installed and no `pullboard init` runs.
 *
 * @param {import('node:test').TestContext} t
 * @param {{ config?: object, spec?: string, real?: boolean }} [policy] - The pullboard.json object and SPEC.md text (the e2e project's by default), and whether to build a real repository.
 * @returns {{ root: string, boardFile: string, commit: string, real: boolean, adapter: object | null, put: (path: string, body: string) => void, commitAll: () => string }}
 */
export function cellRepo(t, { config = CELL_CONFIG, spec = CELL_SPEC, real = !STAND_IN_DEFAULT } = {}) {
  const tracked = [['pullboard.json', JSON.stringify(config, null, 2) + '\n'], ['SPEC.md', spec]];
  if (real) {
    const graph = fixtureCommittedGraph('pullboard-cell-');
    t.after(() => rmSync(graph.root, { recursive: true, force: true }));
    for (const [path, body] of tracked) graph.put(path, body);
    const commit = graph.commit();
    mkdirSync(join(graph.root, '.git', 'pullboard'), { recursive: true });
    return { root: graph.root, boardFile: join(graph.root, '.git', 'pullboard', 'board.sqlite'), commit, real: true, adapter: null, put: graph.put, commitAll: graph.commit };
  }
  const files = privateFixtureFiles('pullboard-cell-');
  t.after(() => rmSync(files.root, { recursive: true, force: true }));
  const memory = memoryRepo(t, files, tracked);
  const commit = memory.commitAll();
  mkdirSync(join(files.root, '.git', 'pullboard'), { recursive: true });
  return { root: files.root, boardFile: join(files.root, '.git', 'pullboard', 'board.sqlite'), commit, real: false, adapter: memory.adapter, put: memory.put, commitAll: memory.commitAll };
}

/**
 * Open a board through the board composition root (never the library front door, which also exports the CLI's main),
 * creating the production schema the way any first open does, and close it after the test.
 *
 * In a test under packages/ the board is, by default, the in-memory stand-in (`:memory:`), proved equal to an on-disk board by the contract in
 * packages/store/tests/board-contract.test.js (#8087), whatever `file` names. A test that needs the file itself, because
 * it starts a process on it, reads it back or watches it on disk, asks with `options.real: true`.
 *
 * @param {import('node:test').TestContext} t
 * @param {string} file - A board.sqlite path, a cellRepo's boardFile, or ':memory:'; only used when `real` is true.
 * @param {{ now: () => Date }} [clock]
 * @param {object} [options] - openBoard options such as gitRoot, plus `real` to open `file` on disk.
 * @returns {object} The open board.
 */
export function cellBoard(t, file, clock, { real = !STAND_IN_DEFAULT, ...options } = {}) {
  const board = openKitBoard(real ? file : ':memory:', clock, options);
  t.after(() => { try { closeBoard(board); } catch { /* A test that closed it itself already released it. */ } });
  return board;
}

/**
 * Open a board the test closes itself, for tests that reopen a file to prove what persisted.
 *
 * @param {string} file
 * @param {{ now: () => Date }} [clock]
 * @param {object} [options] - openBoard options such as gitRoot.
 * @returns {object} The open board.
 */
export function openCellBoard(file, clock, options) {
  return openKitBoard(file, clock, options);
}

export { closeBoard as closeCellBoard };

/**
 * Seed weekly capacity rows on a board file, the way `pullboard capacity` records them: one `capacity.week.<week>` record each.
 * Why: a test of what health says about a worsened week needs weeks whose measures it chooses, which a real run cannot give it.
 *
 * @param {string} file - The board file.
 * @param {{ week: string, at: string }[]} rows - The weekly rows to record.
 * @returns {void}
 */
export function seedCapacityWeeks(file, rows) {
  const board = openKitBoard(file);
  try { for (const row of rows) writeBoardMeta(board.db, `capacity.week.${row.week}`, JSON.stringify({ runs: 1, ...row })); }
  finally { closeBoard(board); }
}

/** The e2e project's default gate, so a converted test keeps the gate it ran against. */
const PROJECT_GATE = 'test ! -f RED';

/**
 * A private scratch folder and the isolated environment a cell test runs git in: the machine's PULLBOARD_* variables and
 * agent and SSH shell markers are stripped, git reads no machine config and signs as a fixed identity, and PULLBOARD_HOME,
 * PULLBOARD_MACHINE_HOME, the usage checkpoint, the infrastructure back-off and the model are fixed. There is no
 * `pullboard` shim on PATH. Cleanup goes through `t.after` and waits for a detached writer a fixture command started. It is the one source of this environment, so cellProject
 * and a test that needs no project share it and cannot drift apart.
 *
 * @param {import('node:test').TestContext | { after: (cleanup: () => void) => void }} t
 * @param {{ model?: string }} [options]
 * @returns {{ dir: string, env: Record<string, string>, git: (cwd: string, ...args: string[]) => string, tryGit: (cwd: string, ...args: string[]) => object }}
 */
export function cellSandbox(t, { model = FIXTURE_MODEL } = {}) {
  const scratch = privateFixtureFiles('pullboard-cell-project-');
  t.after(() => rmSync(scratch.root, { recursive: true, force: true, maxRetries: 150, retryDelay: 200 }));
  const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.startsWith('PULLBOARD_')
    && !AGENT_SHELL_MARKERS.includes(key) && !SSH_SHELL_MARKERS.includes(key)));
  Object.assign(env, {
    GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_NOSYSTEM: '1',
    GIT_AUTHOR_NAME: 'Test Agent', GIT_AUTHOR_EMAIL: 'agent@example.com',
    GIT_COMMITTER_NAME: 'Test Agent', GIT_COMMITTER_EMAIL: 'agent@example.com',
    PULLBOARD_HOME: join(scratch.root, 'pullboard-home'),
    PULLBOARD_MACHINE_HOME: join(scratch.root, 'machine-home'),
    PULLBOARD_USAGE_CHECKPOINT: 'inline',
    PULLBOARD_INFRA_RETRY_BACKOFF_MS: '0',
    PULLBOARD_CLAIM_BEATER: '0',
    // A fixture board's nested pullboard test starts at once, as in the e2e sandbox (#7257).
    PULLBOARD_FIXTURE_BOARD: '1',
    PULLBOARD_MODEL: model,
    // Fixture items carry near-identical numbered titles, so add's duplicate guard stays off, as in the e2e sandbox (#6864).
    PULLBOARD_FIXTURE_ADD_DISTINCT: '1',
    // The loopback runner a pull submit starts stops with this test process, as in the e2e sandbox [P7].
    ...(process.env.PULLBOARD_TEST_RUNNER_PID ? { PULLBOARD_TEST_RUNNER_PID: process.env.PULLBOARD_TEST_RUNNER_PID } : {}),
  });
  const git = (cwd, ...args) => runFixtureGit(args, { cwd, env });
  const tryGit = (cwd, ...args) => runFixtureChild('git', args, { cwd, env, encoding: 'utf8' });
  return { dir: scratch.root, env, git, tryGit };
}

/**
 * A cell-level stand-in for the e2e project: the same policy files in a real Git repo, the same isolated Git identity
 * and private PULLBOARD_HOME and PULLBOARD_MACHINE_HOME, with no `pullboard init`, no hooks, no CLI shim on PATH and no
 * joined worktree. `dir` is a private scratch folder for the test's own files. Cleanup goes through `t.after`.
 *
 * @param {import('node:test').TestContext} t
 * @param {{ gate?: string, config?: object, spec?: string, model?: string, real?: boolean }} [options] - `real: true` builds a real repository, as cellRepo does.
 * @returns {{ dir: string, repo: string, boardFile: string, real: boolean, adapter: object | null, env: Record<string, string>, git: (cwd: string, ...args: string[]) => string, tryGit: (cwd: string, ...args: string[]) => object }}
 */
export function cellProject(t, { gate = PROJECT_GATE, config = {}, spec = CELL_SPEC, model = FIXTURE_MODEL, real = !STAND_IN_DEFAULT } = {}) {
  const sandbox = cellSandbox(t, { model });
  const repo = cellRepo(t, { config: { ...CELL_CONFIG, gate, ...config }, spec, real });
  if (real) return { dir: sandbox.dir, repo: repo.root, boardFile: repo.boardFile, env: sandbox.env, git: sandbox.git, tryGit: sandbox.tryGit, real: true, adapter: null };
  // The repository's own folder answers from the stand-in; any other folder (a clone, a worktree) is still real Git.
  const own = (cwd, run, stand) => resolve(cwd) === repo.root ? stand : run;
  const stamp = () => { const date = `${1_800_000_000 + (stampTick += 1)} +0000`; return { ...STAND_IN_IDENTITY, GIT_AUTHOR_DATE: date, GIT_COMMITTER_DATE: date }; };
  let stampTick = 0;
  const git = (cwd, ...args) => own(cwd, () => sandbox.git(cwd, ...args), () => repo.adapter.execFileSync(args, { cwd, env: stamp(), encoding: 'utf8' }).trim())();
  const tryGit = (cwd, ...args) => own(cwd, () => sandbox.tryGit(cwd, ...args), () => repo.adapter.spawnSync(args, { cwd, env: stamp(), encoding: 'utf8' }))();
  return { dir: sandbox.dir, repo: repo.root, boardFile: repo.boardFile, env: sandbox.env, git, tryGit, real: false, adapter: repo.adapter };
}

/**
 * Register a seat the way `pullboard join` does: the same store register move with the same fields.
 *
 * @param {object} board - A cellBoard.
 * @param {{ lane: string, path: string, route?: string, family?: string, model?: string, reviewLimits?: string[] }} seat
 * @returns {object} The agent row, with `id` and `lane` for cellClaim.
 */
export function cellSeat(board, { lane, path, route = 'strong', family, model = FIXTURE_MODEL, reviewLimits }) {
  const id = register(board, { lane, path, route, family, model, ...(reviewLimits ? { reviewLimits } : {}) });
  return { ...agentById(board, id), id, lane };
}

/**
 * File an item the way `pullboard add` does: the same store addItem move with the same fields.
 *
 * @param {object} board - A cellBoard.
 * @param {{ lane: string, title: string, by?: string, criterion?: string, specIds?: string[], route?: string, check?: string, brief?: string, after?: number[] }} item
 * @returns {object} The item row.
 */
export function cellItem(board, { by = 'coordinator', ...item }) {
  const id = addItem(board, { by, ...item });
  return getItem(board, id);
}

/**
 * Claim an item for a seat the way `pullboard claim` does: the same store claim move with the seat, its lane, the lease,
 * the checkout's HEAD and the claim move's one criterion freezer, so the frozen text and digest match the command's.
 *
 * @param {object} board - A cellBoard.
 * @param {number} id - The item id.
 * @param {{ id: string, lane: string }} seat - A cellSeat.
 * @param {{ root: string, leaseMs?: number }} options - root is the checkout the claim is made from, as the command's cwd.
 * @returns {object} The claim result.
 */
export function cellClaim(board, id, seat, { root, leaseMs = 2 * 60 * 60 * 1000, ...options }) {
  const info = repoInfo(root);
  const freeze = criterionFreezer({ root: info.root, isMain: info.isMain, config: loadConfig(info.root) }, { board });
  return claim(board, id, { agentId: seat.id, lane: seat.lane, leaseMs, freeze, head: headCommit(info.root), ...options });
}

/**
 * Seed a board file with one submitted item whose builder declared a family, and review seats of that family that declared not-same-family.
 * Why: a test of what health says about review supply needs seats and a waiting review without running a gate.
 *
 * @param {string} file - The board file.
 * @param {{ lane: string, family: string, reviewers: number }} shape
 * @returns {number} The submitted item's id.
 */
export function seedLimitedReviewQueue(file, { lane, family, reviewers }) {
  const board = openKitBoard(file);
  try {
    const builder = register(board, { lane, path: '/seeded/builder', route: 'strong', family, model: FIXTURE_MODEL });
    for (let index = 0; index < reviewers; index++) register(board, { lane, path: `/seeded/reviewer-${index}`, route: 'strong', family, model: FIXTURE_MODEL, reviewLimits: ['not-same-family'] });
    const id = addItem(board, { by: 'coordinator', lane, title: 'Seeded review waits', route: 'strong' });
    claim(board, id, { agentId: builder, lane, leaseMs: 3_600_000, freeze: row => ({ text: row.item_title, digest: `digest:${row.item_title}` }) });
    submitFixture(board, id, { agentId: builder, commit: '1'.repeat(40), tree: '1'.repeat(40) });
    return id;
  } finally { closeBoard(board); }
}
