/** Keep CLI-created test items and seats valid as add and join rules evolve [C7]. */
import assert from 'node:assert/strict';
import { mkdirSync } from 'node:fs';
import { readFileSync } from 'node:fs';
import { mkdtempSync } from 'node:fs';
import { rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { submitFixture } from '../../../store/tests/fixtures/submit.js';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  privateFixtureFiles,
  runFixtureGit,
} from './child.js';

export { FIXTURE_MODEL } from './child.js';
/** The model name fixture seats join with when a test passes `--model` itself: see FIXTURE_MODEL in child.js. */
import { FIXTURE_MODEL } from './child.js';
/** A second model name, so a later seat must register against the earlier one. */
export { FIXTURE_MODEL_EARLIER } from '../../../store/tests/fixtures/cell.js';

/** Normalize the two child-process result shapes used by CLI-backed fixtures. */
function fixtureResult(result) {
  return { code: result.code ?? result.status, out: result.out ?? result.stdout ?? '', err: result.err ?? result.stderr ?? '' };
}

/** Join a fixture worktree with the model and route required by current admission rules; an awaited runner gives an awaited result. */
export function joinFixtureSeat(box, root, lane, { model = 'Fixture Model', route = 'strong', lockLane = false, run = box.run } = {}) {
  const result = run(root, 'join', lane, '--model', model, '--route', route, ...(lockLane ? ['--lock-lane'] : []), '--json');
  return typeof result?.then === 'function' ? result.then(fixtureResult) : fixtureResult(result);
}

/**
 * Run a fixture add; when the likely-duplicate guard refuses it, file it again naming the item it resembles.
 *
 * Why: fixture boards file many near-identical items by design, and the guard is for people, so the kit answers it once
 * here instead of every journey inventing distinct titles [C7].
 */
function addAnsweringDuplicate(run, root, addArgs) {
  const nearest = raw => {
    const result = fixtureResult(raw);
    return result.code === 0 ? null : /DUPLICATE_LIKELY[\s\S]*?#(\d+)/u.exec(result.out + result.err)?.[1] ?? null;
  };
  const again = (raw, id) => id === null ? raw : run(root, ...addArgs.slice(0, -1), '--not-duplicate-of', `${id} fixture items repeat by design`, '--json');
  const first = run(root, ...addArgs);
  return typeof first?.then === 'function' ? first.then(raw => again(raw, nearest(raw))) : again(first, nearest(first));
}

/** Add a fixture item with a complete route-specific build brief and return its parsed item; a diagnosis fact routes the item light, so pass diagnose: false to keep the declared route. */
export function fileFixtureItem(box, root, { lane, title, criterion = 'The fixture item is valid.', check = 'true', route = 'strong', brief, diagnosis, diagnose = true, args = [], wait = false, run = box.run } = {}) {
  const buildBrief = brief ?? `Files:\n- ${lane}/fixture.js\nChange:\n- Keep the fixture valid.\nTest:\n- ${title} passes.`;
  const addArgs = ['add', lane, title, '--route', route, '--criterion', criterion];
  if (check !== null) addArgs.push('--check', check);
  if (check === 'true') addArgs.push('--accept-green', 'fixture check keeps passing');
  addArgs.push('--brief', buildBrief, ...args, '--json');
  if (wait) addArgs.splice(addArgs.length - 1, 0, '--wait');
  const added = addAnsweringDuplicate(run, root, addArgs);
  const afterAdd = raw => {
    const result = fixtureResult(raw);
    assert.equal(result.code, 0, `${result.out}\n${result.err}`);
    const item = JSON.parse(result.out).item;
    return { item, fact: check !== null && diagnose ? () => run(root, 'fact', String(item.item_id), 'diagnosis', diagnosis ?? buildBrief, '--json') : null };
  };
  const afterFact = raw => {
    const recorded = fixtureResult(raw);
    assert.equal(recorded.code, 0, `${recorded.out}\n${recorded.err}`);
  };
  // An awaited runner (box.runLocal) gets an awaited item; a synchronous runner keeps the synchronous answer.
  if (typeof added?.then === 'function') {
    return added.then(async raw => {
      const step = afterAdd(raw);
      if (step.fact) afterFact(await step.fact());
      return step.item;
    });
  }
  const step = afterAdd(added);
  if (step.fact) afterFact(step.fact());
  return step.item;
}

/** Create and join a fixture worktree with all current admission identity flags. */
export function createFixtureWorktree(box, root, lane, { model = 'Fixture Model', route = 'strong', run = box.run } = {}) {
  const result = run(root, 'worktree', lane, '--model', model, '--route', route, '--json');
  return typeof result?.then === 'function' ? result.then(fixtureResult) : fixtureResult(result);
}

/**
 * Run a fixture `pullboard add` through the kit and return the runner's result untouched.
 *
 * Why: every test that files an item reaches the CLI through this one seam, so a new add rule is met here
 * once instead of in hundreds of copies. Tests that assert a refusal keep their exact arguments.
 *
 * @param {(cwd: string, ...args: string[]) => unknown} run - The fixture's CLI runner, such as box.run.
 * @param {string} cwd - The checkout the command runs in.
 * @param {...string} args - Everything after `add`: lane, title words and flags.
 * @returns {unknown} Whatever the runner returns, a promise included.
 */
export function fixtureAdd(run, cwd, ...args) {
  return run(cwd, 'add', ...args);
}

/**
 * Run a fixture `pullboard join` through the kit and return the runner's result untouched.
 *
 * Why: seat admission rules (model, route, family) change; one seam lets the kit meet them for every test.
 *
 * @param {(cwd: string, ...args: string[]) => unknown} run - The fixture's CLI runner, such as box.run.
 * @param {string} cwd - The worktree that joins.
 * @param {...string} args - Everything after `join`: lane and flags.
 * @returns {unknown} Whatever the runner returns, a promise included.
 */
export function fixtureJoin(run, cwd, ...args) {
  return run(cwd, 'join', ...args);
}

/** The argv head for a spawned `pullboard add`: the CLI path then the verb, so spawned adds share the kit seam. */
export function fixtureAddArgv(cli) {
  return [cli, 'add'];
}

/** The argv head for a spawned `pullboard join`: the CLI path then the verb, so spawned joins share the kit seam. */
export function fixtureJoinArgv(cli) {
  return [cli, 'join'];
}

/**
 * Merge policy fields into a fixture project's committed pullboard.json on main.
 *
 * Why: policy files are written once here, so a test declares only the fields it needs and a policy rule change is
 * met in one place.
 *
 * @param {object} box - The e2e project (repo, git).
 * @param {object} fields - Top-level pullboard.json fields to set, such as affectedTests or submitGate.
 * @returns {object} The committed config.
 */
export function fixturePolicy(box, fields) {
  const path = join(box.repo, 'pullboard.json');
  const config = { ...JSON.parse(readFileSync(path, 'utf8')), ...fields };
  writeFileSync(path, JSON.stringify(config, null, 2) + '\n');
  box.git(box.repo, 'add', 'pullboard.json');
  box.git(box.repo, 'commit', '-q', '-m', 'chore: configure fixture policy [G1]');
  return config;
}

/**
 * Write a fixture project's policy files before its first commit, setting exactly the fields the test names.
 *
 * Why: the hand-policy check sends tests here instead of writing pullboard.json or SPEC.md by hand; unlike
 * fixtureHandoffPolicy it forces no gate and no hand-off, so a test keeps the policy it declares.
 *
 * @param {string} repo - The fixture repository root.
 * @param {{ config?: object, spec?: string }} policy - The pullboard.json object, and the SPEC.md text when the test needs one.
 * @returns {void}
 */
export function fixtureProjectPolicy(repo, { config = {}, spec } = {}) {
  writeFileSync(join(repo, 'pullboard.json'), JSON.stringify(config));
  if (spec !== undefined) writeFileSync(join(repo, 'SPEC.md'), spec);
}

/**
 * Make a fixture folder a repository on main and commit everything in it, so a policy and tests there are clean source.
 *
 * Why: the tempdir check sends repository creation here; hooks are skipped because a setup commit tests no hook [C7].
 *
 * @param {string} repo - The fixture folder.
 * @returns {void}
 */
export function fixtureCommitAll(repo) {
  const git = (...args) => runFixtureGit(['-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.test', '-c', 'core.hooksPath=/dev/null', ...args], { cwd: repo });
  git('init', '-q', '-b', 'main');
  git('add', '.');
  git('commit', '-q', '-m', 'fixture');
}

/**
 * Write a fixture's machine settings file with exactly the fields the test names.
 *
 * Why: the hand-policy check sends tests here instead of writing settings.json by hand.
 *
 * @param {string} machineHome - The fixture's machine home folder.
 * @param {object} settings - The settings object.
 * @returns {void}
 */
export function fixtureMachineSettings(machineHome, settings) {
  writeFileSync(join(machineHome, 'settings.json'), JSON.stringify(settings));
}

/**
 * The gate dispatch under which a fixture's submit, test run or comparison settles inside the command that started it.
 * Why one constant: fixtures name their dispatch here instead of inheriting the machine default. Pull is the only dispatch:
 * a plain fixture project is judged by the runner's installed Pullboard (#6265), on the loopback local runner [P7,#5821].
 */
export const FIXTURE_GATE_DISPATCH = Object.freeze({ runnerDispatch: 'pull' });

/**
 * Make a fixture machine home whose submits settle the same way whatever the machine's runnerDispatch default is:
 * the folder, and its settings with FIXTURE_GATE_DISPATCH under any gate fields the fixture names.
 *
 * @param {string} machineHome - The fixture's machine home folder.
 * @param {object} [settings] - Further machine settings; its gate fields keep their own values beside the dispatch.
 * @returns {void}
 */
export function fixtureSettledMachine(machineHome, settings = {}) {
  mkdirSync(machineHome, { recursive: true });
  fixtureMachineSettings(machineHome, { ...settings, gate: { ...settings.gate, ...FIXTURE_GATE_DISPATCH } });
}

/**
 * Write a file the repository's cells-plan tooling reads (packages/codemap/data/plan/cells.json) into a fixture project before its commit.
 *
 * Why: the hand-policy check sends tests here instead of writing packages/codemap/data/plan/cells.json by hand.
 *
 * @param {string} repo - The fixture repository root.
 * @param {string} text - The plan file's text.
 * @returns {void}
 */
export function fixtureCellsPlan(repo, text) {
  mkdirSync(join(repo, 'packages/codemap/data/plan'), { recursive: true });
  writeFileSync(join(repo, 'packages/codemap/data/plan/cells.json'), text);
}

/**
 * Commit the native submit hand-off policy into a fixture project and bring its web checkout up to date.
 *
 * Why: policy files are written once here, so a policy rule change is met for every test.
 *
 * @param {object} box - The e2e project (repo, web, git).
 * @param {object} config - The base pullboard.json config the project was built with.
 * @returns {string} The board file inside the repository's .git, where the native CLI keeps it.
 */
export function fixtureHandoffPolicy(box, config) {
  writeFileSync(join(box.repo, 'pullboard.json'), JSON.stringify({ ...config, gate: 'true', submit: { handoff: true } }, null, 2) + '\n');
  box.git(box.repo, 'add', 'pullboard.json');
  box.git(box.repo, 'commit', '-q', '-m', 'chore: configure native submit handoff [G1]');
  box.git(box.web, 'merge', '-q', '--ff-only', 'main');
  return join(box.repo, '.git', 'pullboard', 'board.sqlite');
}

/**
 * Commit the given pullboard.json fields into a fixture project and bring its web checkout up to date.
 *
 * Why: a test that needs its own gate, affectedTests or landing policy declares it here instead of writing
 * pullboard.json by hand, so a policy rule change is met in one place. Unlike fixtureHandoffPolicy it forces
 * neither the gate nor submit.handoff, so submit still submits. First half of #3730.
 *
 * @param {object} box - The e2e project (repo, web, git).
 * @param {object} policy - The pullboard.json fields to set over the project's current ones.
 * @returns {string} The board file inside the repository's .git.
 */
export function fixtureCommittedPolicy(box, policy) {
  const file = join(box.repo, 'pullboard.json');
  writeFileSync(file, JSON.stringify({ ...JSON.parse(readFileSync(file, 'utf8')), ...policy }, null, 2) + '\n');
  box.git(box.repo, 'add', 'pullboard.json');
  box.git(box.repo, 'commit', '-q', '-m', 'chore: configure the fixture project policy [G1]');
  box.git(box.web, 'merge', '-q', '--ff-only', 'main');
  return join(box.repo, '.git', 'pullboard', 'board.sqlite');
}

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

/**
 * Give a fixture `join` the strong route unless it names one or joins a light model, in place, and return args.
 * Why: the product maps an unlisted model to mid, while fixture items default strong, so a bare fixture join could not claim them [C7].
 */
export function fixtureJoinRoute(args, defaultModel) {
  if (args[0] !== 'join' || args.some(arg => arg === '--route' || arg.startsWith('--route='))) return args;
  const flag = args.findIndex(arg => arg === '--model' || arg.startsWith('--model='));
  const model = flag < 0 ? defaultModel : args[flag].startsWith('--model=') ? args[flag].slice(8) : args[flag + 1];
  if (!/haiku/iu.test(String(model ?? '')) && model !== 'gpt-6-luna') args.push('--route', 'strong');
  return args;
}

/**
 * Give a fixture `add` the strong route unless it names one, in place, and return args.
 * Why: an unrouted add is routed mid by the board, and a mid item must be buildable cold (Files, Test, criterion, check) and needs a mid seat; fixture items are bare rows built and verified by strong seats, as fixtureJoinRoute makes them [C7].
 */
export function fixtureAddRoute(args) {
  if (args[0] === 'add' && !args.some(arg => arg === '--route' || arg.startsWith('--route='))) args.push('--route', 'strong');
  return args;
}

/**
 * A private repository and board where tests submit and reject synthetic items through the normal board moves.
 *
 * Why: Rigor draft tests need real rejects and reopens on a real board; the raw repository and board setup lives in
 * this one kit seam instead of being copied into each test [C7].
 *
 * @param {object} store - The store module, passed in so the kit takes on no cell import.
 * @param {(file: string, clock?: object, options?: object) => object} openBoard - The board opener (openKitBoard from the board package's fixture), passed in so the kit takes on no board edge.
 * @returns {{ root: string, board: object, submit: (title: string) => number, reject: (id: number) => void, close: () => void }} The fixture.
 */
export function rigorFixtureBoard(store, openBoard) {
  const root = mkdtempSync(join(tmpdir(), 'pullboard-rigor-fixture-'));
  const env = { ...process.env, GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_NOSYSTEM: '1',
    GIT_AUTHOR_NAME: 'Rigor fixture', GIT_AUTHOR_EMAIL: 'rigor@example.invalid',
    GIT_COMMITTER_NAME: 'Rigor fixture', GIT_COMMITTER_EMAIL: 'rigor@example.invalid',
    PULLBOARD_FIXTURE_BOARD: '1', PULLBOARD_HOME: join(root, 'private-home'), PULLBOARD_MACHINE_HOME: join(root, 'private-machine') };
  const git = (...args) => runFixtureGit(args, { cwd: root, env, encoding: 'utf8' });
  git('init', '-q', '-b', 'main');
  writeFileSync(join(root, 'pullboard.json'), JSON.stringify({ name: 'Rigor fixture', gate: 'true', spec: 'SPEC.md',
    lanes: { app: { owns: ['src/'] } }, landing: { cadence: '1h' } }));
  writeFileSync(join(root, 'SPEC.md'), '# Spec\n\n## G · Goals\n- G1 [approved, must] Keep the product coherent. | gate: review\n');
  writeFileSync(join(root, 'DOCTRINE.md'), '# Doctrine\n\n## DR · Rulings\n');
  git('add', '.'); git('commit', '-q', '-m', 'chore: prepare isolated Rigor fixture');
  const policy = { version: 1, commit: git('rev-parse', 'HEAD').trim(), verify: { policy: 'any', family: 'off' } };
  mkdirSync(join(root, '.git', 'pullboard'), { recursive: true });
  const now = new Date('2026-10-24T12:00:00Z');
  const board = openBoard(join(root, '.git', 'pullboard', 'board.sqlite'), { now: () => new Date(now) }, { gitRoot: root });
  store.board_ensureCoordinator(board, root);
  const builder = store.register(board, { lane: 'app', path: join(root, 'builder'), model: 'Fixture builder' });
  const reviewer = store.register(board, { lane: 'app', path: join(root, 'reviewer'), model: 'Fixture reviewer' });
  let serial = 0;
  const submit = title => {
    const id = store.addItem(board, { by: 'coordinator', lane: 'app', title });
    store.claim(board, id, { agentId: builder, lane: 'app', leaseMs: 7_200_000,
      freeze: item => ({ text: JSON.stringify({ criterion: item.item_title, policy }), digest: `fixture:${item.item_title}` }) });
    submitFixture(board, id, { agentId: builder, commit: (++serial).toString(16).padStart(40, '0'), tree: 'e'.repeat(40) });
    return id;
  };
  const reject = id => { store.verify(board, id, { agentId: reviewer, decision: 'REJECT', reason: 'TEST_FAILURE',
    note: 'synthetic failure receipt', clause: store.getItem(board, id).item_title, head: store.getItem(board, id).item_commit,
    digest: store.getItem(board, id).item_frozen_digest, policy: 'any' }); };
  return { root, board, submit, reject, close: () => { store.closeBoard(board); rmSync(root, { recursive: true, force: true }); } };
}

/**
 * File `count` items on a joined project's board and give the seat a closed claim on each, so each has one usage revision pending.
 *
 * Why: a usage-drain journey needs many pending revisions on a real board; the raw board writes live in this one kit seam [C7].
 *
 * @param {object} store - The store module, passed in so the kit takes on no cell import.
 * @param {object} board - An open board of the project.
 * @param {{ agent: string, lane: string, main: string, count: number, now?: number }} seed - The seat, its lane, main's commit and the item count.
 * @returns {number[]} The item ids, oldest first.
 */
export function seedPendingUsage(store, board, { agent, lane, main, count, now = Date.now() - 100000 }) {
  const ids = [];
  store.atomic(board, () => {
    for (let n = 0; n < count; n++) {
      const id = store.addItem(board, { by: 'coordinator', lane, title: `Usage drain ${n}`, specIds: ['G1'],
        criterion: 'Usage stays attributed once.', check: 'test -f web/ready',
        checkBaseline: { command: 'test -f web/ready', result: 'red', main, seconds: 0 } });
      ids.push(id);
      store.logEvent(board, agent, 'claim', id, { model: 'unknown', leaseUntil: new Date(now + n * 100 + 90).toISOString() }, new Date(now + n * 100));
      store.logEvent(board, agent, 'release', id, {}, new Date(now + n * 100 + 50));
    }
  });
  return ids;
}

/** Commit in one checkout a pullboard.json asking for strict review.independence, so its seat is refused a verdict on its own session's work (#27). */
export function requireSessionIndependence(dir) {
  const file = join(dir, 'pullboard.json');
  writeFileSync(file, JSON.stringify({ ...JSON.parse(readFileSync(file, 'utf8')), review: { independence: 'session' } }, null, 2) + '\n');
  runFixtureGit(['-c', 'core.hooksPath=/dev/null', '-c', 'user.name=fixture', '-c', 'user.email=fixture@example.test', 'commit', '-qam', 'chore: ask for strict review independence'], { cwd: dir });
}
