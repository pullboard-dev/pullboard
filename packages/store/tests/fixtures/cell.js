/** Cell-level project fixture: a real Git repo, its policy files and a real SQLite board, with no pullboard init, hooks or CLI [C7]. */
import { join } from 'node:path';
import { mkdirSync } from 'node:fs';
import { rmSync } from 'node:fs';
import { closeBoard } from '../../../../apps/lib/src/logic/native.js';
import { openBoard } from '../../../../apps/lib/src/logic/native.js';
import { FIXTURE_MODEL } from '../../../gate/tests/fixtures/child.js';
import { privateFixtureFiles } from '../../../gate/tests/fixtures/child.js';
import { runFixtureChild } from '../../../gate/tests/fixtures/child.js';
import { runFixtureGit } from '../../../gate/tests/fixtures/child.js';
import { AGENT_SHELL_MARKERS } from '../../../kernel/index.js';
import { SSH_SHELL_MARKERS } from '../../../kernel/index.js';
import { addItem } from '../../index.js';
import { agentById } from '../../index.js';
import { claim } from '../../index.js';
import { getItem } from '../../index.js';
import { register } from '../../index.js';
import { criterionFreezer } from '../../../moves/index.js';
import { loadConfig } from '../../../config/index.js';
import { headCommit } from '../../../git/index.js';
import { repoInfo } from '../../../git/index.js';

/**
 * A private Git repository for tests of how committed files are read: write files, commit them, repeat.
 *
 * Why: a selection or graph test needs real Git objects and nothing else, so the one raw `git init` lives in the cell fixture, which the CLI's test kit re-exports [C7].
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
 * A private Git repository holding pullboard.json and SPEC.md in one plain commit; git is isolated from the machine.
 * Cleanup goes through `t.after`. No hooks are installed and no `pullboard init` runs.
 *
 * @param {import('node:test').TestContext} t
 * @param {{ config?: object, spec?: string }} [policy] - The pullboard.json object and SPEC.md text; the e2e project's by default.
 * @returns {{ root: string, boardFile: string, commit: string, put: (path: string, body: string) => void, commitAll: () => string }}
 */
export function cellRepo(t, { config = CELL_CONFIG, spec = CELL_SPEC } = {}) {
  const graph = fixtureCommittedGraph('pullboard-cell-');
  t.after(() => rmSync(graph.root, { recursive: true, force: true }));
  graph.put('pullboard.json', JSON.stringify(config, null, 2) + '\n');
  graph.put('SPEC.md', spec);
  const commit = graph.commit();
  mkdirSync(join(graph.root, '.git', 'pullboard'), { recursive: true });
  return { root: graph.root, boardFile: join(graph.root, '.git', 'pullboard', 'board.sqlite'), commit, put: graph.put, commitAll: graph.commit };
}

/**
 * Open a real board through the board composition root (never the library front door, which also exports the CLI's main),
 * creating the production schema the way any first open does, and close it after the test.
 *
 * @param {import('node:test').TestContext} t
 * @param {string} file - A board.sqlite path, a cellRepo's boardFile, or ':memory:'.
 * @param {{ now: () => Date }} [clock]
 * @param {object} [options] - openBoard options such as gitRoot.
 * @returns {object} The open board.
 */
export function cellBoard(t, file, clock, options) {
  const board = openBoard(file, clock, options);
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
  return openBoard(file, clock, options);
}

export { closeBoard as closeCellBoard };

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
    PULLBOARD_MODEL: model,
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
 * @param {{ gate?: string, config?: object, spec?: string, model?: string }} [options]
 * @returns {{ dir: string, repo: string, boardFile: string, env: Record<string, string>, git: (cwd: string, ...args: string[]) => string, tryGit: (cwd: string, ...args: string[]) => object }}
 */
export function cellProject(t, { gate = PROJECT_GATE, config = {}, spec = CELL_SPEC, model = FIXTURE_MODEL } = {}) {
  const sandbox = cellSandbox(t, { model });
  const repo = cellRepo(t, { config: { ...CELL_CONFIG, gate, ...config }, spec });
  return { dir: sandbox.dir, repo: repo.root, boardFile: repo.boardFile, env: sandbox.env, git: sandbox.git, tryGit: sandbox.tryGit };
}

/**
 * Register a seat the way `pullboard join` does: the same store register move with the same fields.
 *
 * @param {object} board - A cellBoard.
 * @param {{ lane: string, path: string, route?: string, family?: string, model?: string }} seat
 * @returns {object} The agent row, with `id` and `lane` for cellClaim.
 */
export function cellSeat(board, { lane, path, route = 'strong', family, model = FIXTURE_MODEL }) {
  const id = register(board, { lane, path, route, family, model });
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
