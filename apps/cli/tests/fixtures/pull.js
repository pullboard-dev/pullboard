/** A real project and board under gate.runnerDispatch pull, with accepted main's stand-in gate tooling, and its board job queue on loopback [P7]. */
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { spawn } from 'node:child_process';
import { appendFileSync } from 'node:fs';
import { existsSync } from 'node:fs';
import { mkdirSync } from 'node:fs';
import { readFileSync } from 'node:fs';
import { rmSync } from 'node:fs';
import { watch } from 'node:fs';
import { writeFileSync } from 'node:fs';
import { createServer } from 'node:http';
import { dirname } from 'node:path';
import { join } from 'node:path';
import { resolve } from 'node:path';
import { createE2eHelpers } from './e2e.js';
import { JOURNEY_MODE } from './e2e.js';
import { parityRecord } from './e2e.js';
import { fixtureAdd } from './testkit.js';
import { fixtureMachineSettings } from './testkit.js';
import { openKitBoard } from './board.js';
import { privateFixtureFiles } from './child.js';
import { fetchFresh } from './http.js';
import { closeBoard } from '../../../lib/index.js';
import { createApiHandler } from '../../../../packages/api/index.js';
import { jobQueueCall } from '../../../../packages/api/index.js';
import { getItem } from '../../../../packages/store/index.js';
import { verify } from '../../../../packages/store/index.js';
import { GATE_RECEIPT } from '../../src/io/submit/pull.js';

/** Accepted main's stand-in tooling: each part records its step, the job that ran it and its pid in the checkout it judged, or in PULLBOARD_FIXTURE_STEPS when a runner's checkout is a worktree. */
export const TOOLING = {
  'package.json': '{"type":"module"}\n',
  'bin/record.js': `import { appendFileSync } from 'node:fs';
import { join } from 'node:path';
import { resolve } from 'node:path';
export function record(root, step) { appendFileSync(process.env.PULLBOARD_FIXTURE_STEPS ?? join(root, '.git', 'gate-steps.jsonl'), JSON.stringify({ step, job: process.env.PULLBOARD_FIXTURE_JOB ?? null, pid: process.pid }) + '\\n'); }
`,
  'packages/items/index.js': `import { record } from '../../bin/record.js';
export function requireSubmitComposition(root) { record(root, 'composition'); }
`,
  'packages/gate/heavy.js': "export * from './index.js';\n",
  'packages/gate/index.js': `import { record } from '../../bin/record.js';
export function importsIn() {} export function commonJsIn() {} export function withImportParseCache() {}
export function foreignNodeOptions() { return false; }
export function submitGatePlan(root, config, options) {
  record(root, 'selection');
  return { check: options.check, selection: { full: false, reason: 'fixture', files: ['web/proof'] }, proofFiles: ['web/proof'], proofCommand: 'node bin/proof.js ./web' };
}
export async function submitGateAdmission(root) { record(root, 'admission'); return { browser: false, gui: false }; }
`,
  'packages/landing/index.js': 'export function withMainCheckout() {}\n',
  'apps/cli/src/io/cells/cache.js': 'export function transferredCellsInventories() { return null; }\n',
  'bin/cells-submit-checks.js': `import { record } from './record.js';
export async function requireSubmitCells(root) { record(root, 'cells'); return { cells: ['fixture'], existingCuts: [] }; }
`,
  'packages/sandbox/index.js': `import { record } from '../../bin/record.js';
export function submissionPaths(root, item) { record(root, 'authorization'); return ['web/' + item.item_id]; }
`,
  'packages/doctrine/index.js': `import { record } from '../../bin/record.js';
export async function holdDoctrineAsync(root) { record(root, 'doctrine'); return [{ id: 'D1', problems: [] }]; }
`,
  'apps/cli/src/io/static/checks.js': `import { record } from '../../../../../bin/record.js';
record(process.cwd(), 'static');
`,
  // A phase's timing profile sits beside its kept log, named for it, as the gate's own does: `<log>.profile.json` in the runner's kept folder, which a loopback runner makes the job's checkout; written only in a pulled job (the gate entry sets PULLBOARD_PULLED_JOB for its phases), so an item add or inline gate leaves no file [C7,#7301].
  'bin/profile.js': `import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
export function writeProfile(role) { if (process.env.PULLBOARD_PULLED_JOB) writeFileSync(join(process.cwd(), role + '.log.profile.json'), JSON.stringify({ phase: role, standIn: true })); }
`,
  // The proof holds its job open a moment, so the host is sampled while all the gates run at once; it writes the ACCEPT timing profile.
  'bin/proof.js': `import { record } from './record.js';
import { writeProfile } from './profile.js';
record(process.cwd(), 'proof');
writeProfile('proof');
Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 400);
`,
  'DOCTRINE.md': '# Doctrine\n\n## D · Rules\n- D1 [approved, must] The fixture rule holds. | gate: check true | count: 0\n',
};

/** The item check that makes the stand-in gate write the check phase's timing profile; pass it as pullProject's `check`. Why inline: a bar naming a file path must be one a lane owns, so the check names none. */
export const PROFILED_CHECK = `node -e 'process.env.PULLBOARD_PULLED_JOB && require("node:fs").writeFileSync(["check", "log", "profile", "json"].join("."), JSON.stringify({ phase: "check", standIn: true }))'`;

/** Processes on this host whose command line names the board's sandbox: a dispatcher, driver or worker the submit left behind. */
export function hostProcesses(dir) {
  return execFileSync('ps', ['-A', '-o', 'pid=,command='], { encoding: 'utf8' }).split('\n').filter(line => line.includes(dir)).length;
}

/**
 * A real project and board under gate.runnerDispatch pull (or the given gate settings), whose main carries the stand-in
 * tooling (with `tooling` files over it), and the board's loopback job API. The machine's local runner stays off unless
 * the gate settings turn it on, since these journeys drive their own runners [P7].
 */
export async function pullProject(t, count, { check = () => 'true', gate = { runnerDispatch: 'pull' }, tooling = {} } = {}) {
  const helpers = createE2eHelpers();
  t.after(helpers.cleanup);
  const box = helpers.project('true', helpers.sandbox());
  // No local runner takes the offered jobs: the journey serves its own, so commands must not wait for the queue to empty.
  box.env.PULLBOARD_FIXTURE_UNSETTLED = '1';
  mkdirSync(box.env.PULLBOARD_MACHINE_HOME, { recursive: true });
  fixtureMachineSettings(box.env.PULLBOARD_MACHINE_HOME, { gate: { localRunner: false, ...gate } });
  for (const [path, text] of Object.entries({ ...TOOLING, ...tooling })) { mkdirSync(dirname(join(box.repo, path)), { recursive: true }); writeFileSync(join(box.repo, path), text); }
  const configFile = join(box.repo, 'pullboard.json');
  const config = JSON.parse(readFileSync(configFile, 'utf8'));
  // A pulled gate holds its item claimed until a runner serves it, so a journey with several items needs a claim for each.
  writeFileSync(configFile, JSON.stringify({ ...config, claims: { ...config.claims, perSeat: Math.max(1, count) }, staticChecks: 'node apps/cli/src/io/static/checks.js' }, null, 2) + '\n');
  box.git(box.repo, 'add', '-A');
  box.git(box.repo, 'commit', '-q', '-m', 'chore: stand-in trusted tooling [G1]');
  box.git(box.web, 'merge', '-q', '--ff-only', 'main');
  /** Add item n; every item after the first names the first as no duplicate. */
  const add = (n, first) => fixtureAdd(box.runIn, box.repo, 'web', `Pulled gate ${n}`, '--specs', 'G1', '--criterion', `Gate ${n} runs on a runner.`, '--check', check(n), '--accept-green', 'stand-in check keeps passing', '--wait', '--json', ...(first ? ['--not-duplicate-of', `${first} numbered fixture item`] : []));
  const ids = [];
  const head = await add(1);
  assert.equal(head.code, 0, head.err);
  ids.push(JSON.parse(head.out).item.item_id);
  // The rest are added at once: ten sequential add commands were most of a ten-item journey's setup.
  for (const added of await Promise.all(Array.from({ length: count - 1 }, (_, n) => add(n + 2, ids[0])))) {
    assert.equal(added.code, 0, added.err);
    ids.push(JSON.parse(added.out).item.item_id);
  }
  ids.sort((a, b) => a - b);
  const boardFile = join(box.repo, '.git', 'pullboard', 'board.sqlite');
  const runnerHome = privateFixtureFiles('pull-runner-').root;
  t.after(() => rmSync(runnerHome, { recursive: true, force: true }));
  return { ...box, helpers, ids, boardFile, runnerHome };
}

/**
 * A quick board move (claim, bar) answered by the box's warm worker thread, or by a real process under PULLBOARD_JOURNEY_MODE=process,
 * with a parity record per call when PULLBOARD_PARITY_RECORD is set. Why: a sync helper cannot await runIn, and a claim costs a Node start-up [C7,U149].
 * Submit stays a real process: it hands the gate job on and can outlast runSync's wait.
 */
function quick(box, cwd, ...args) {
  const result = JOURNEY_MODE === 'process' ? box.run(cwd, ...args) : box.runSync(cwd, ...args);
  if (process.env.PULLBOARD_PARITY_RECORD) appendFileSync(process.env.PULLBOARD_PARITY_RECORD, `${JSON.stringify(parityRecord({ dir: box.dir, env: box.env, cwd, args, result: { ...result, status: result.code, stdout: result.out, stderr: result.err } }))}\n`);
  return result;
}

/**
 * Claim, commit and submit one item from its own folder; the submit must return green at once.
 * `change` names the one file the item commits; by default a fresh web/<id>.txt. `compose` turns bar readiness on after the
 * claim (a bar frozen before activation stays claimable), so the gate composes the change with main on the runner [C7].
 */
export function submitOne(box, id, change = { path: `web/${id}.txt`, body: `gate ${id}\n`, subject: `feat(web): pulled gate ${id} [G1]` }, { compose = false } = {}) {
  const claimed = quick(box, box.web, 'claim', String(id), '--json');
  assert.equal(claimed.code, 0, `${claimed.err}\n${claimed.out}`);
  if (compose) assert.equal(quick(box, box.repo, 'bar', 'ready', 'on').code, 0);
  const folder = JSON.parse(claimed.out).itemFolder ?? box.web;
  assert.equal(box.helpers.commitFile(box, folder, change.path, change.body, change.subject).status, 0);
  // Real process: submit hands the gate job on and can outlast the worker's wait.
  const submitted = box.run(folder, 'submit', String(id), '--json');
  assert.equal(submitted.code, 0, `${submitted.err}\n${submitted.out}`);
  return { folder, commit: box.git(folder, 'rev-parse', 'HEAD'), document: JSON.parse(submitted.out) };
}

/**
 * Claim, commit and submit each item at once, every one from its own folder; each submit must return green at once.
 * Why at once: a submit is a real CLI process, and ten run one after another were most of a ten-item journey's time.
 *
 * @param {Awaited<ReturnType<typeof pullProject>>} box
 * @param {number[]} ids
 * @returns {Promise<{ folder: string, commit: string, document: object }[]>} One entry per id, in id order.
 */
export function submitAll(box, ids) {
  return Promise.all(ids.map(async id => {
    const claimed = await box.runIn(box.web, 'claim', String(id), '--json');
    assert.equal(claimed.code, 0, claimed.err);
    const folder = JSON.parse(claimed.out).itemFolder ?? box.web;
    assert.equal(box.helpers.commitFile(box, folder, `web/${id}.txt`, `gate ${id}\n`, `feat(web): pulled gate ${id} [G1]`).status, 0);
    // Real process: submit hands the gate job on and can outlast the worker's wait.
    const submitted = await box.runAsync(folder, 'submit', String(id), '--json');
    assert.equal(submitted.code, 0, `${submitted.err}\n${submitted.out}`);
    return { folder, commit: box.git(folder, 'rev-parse', 'HEAD'), document: JSON.parse(submitted.out) };
  }));
}

/**
 * The board's job queue on loopback, as the board API serves it under pull, with the project as its trunk remote.
 * Returns the board host's own connection, the board URL a runner is given, and a call helper for direct queue calls.
 *
 * @param {import('node:test').TestContext} t
 * @param {Awaited<ReturnType<typeof pullProject>>} box
 * @param {{ queue?: (board: object, body: object) => object }} [options] - queue answers each call; default jobQueueCall on the board's db.
 */
export async function pullQueue(t, box, { queue } = {}) {
  // @pullboard-board-file journey: the board host's own connection, serving the job queue the real CLI wrote rows to.
  const board = openKitBoard(box.boardFile, undefined, { gitRoot: box.repo });
  t.after(() => closeBoard(board));
  const answer = queue ?? ((current, body) => jobQueueCall(current.db, body, { mode: 'pull', trunk: () => box.repo }));
  const handler = createApiHandler({ refusalDocument: error => ({ error: { code: error.code ?? 'INTERNAL', message: String(error.message) } }),
    authenticate: () => ({ local: true }), board: id => ({ id }), jobs: (_board, body) => answer(board, body) });
  const server = createServer(handler);
  await new Promise(done => server.listen(0, '127.0.0.1', done));
  t.after(() => new Promise(done => { handler.close(); server.close(done); server.closeIdleConnections(); }));
  const url = `http://127.0.0.1:${server.address().port}/api/v1/boards/fixture`;
  const call = async body => {
    const response = await fetchFresh(`${url}/jobs`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
    const document = await response.json();
    assert.equal(response.status, 200, JSON.stringify(document));
    return document;
  };
  return { board, url, call };
}

const BIN = resolve(import.meta.dirname, '../../pullboard.js');

/** Start a real census controller against this fixture board, so a journey can signal it. */
export function startCensusController(box, out) {
  return spawn(process.execPath, [BIN, 'test', '--census', '--out', out], { cwd: box.repo, env: box.env, stdio: ['ignore', 'pipe', 'pipe'] });
}

/**
 * The environment a served runner starts with: the box's own, with every PULLBOARD_ variable removed so it sees a clean
 * machine, plus `env`. Only when `machineSettings` is given does it also get a machine home of its own holding exactly
 * those settings, so a journey can switch one machine setting on in the runner process and nothing else [P7,#7301].
 *
 * @param {object} box - The fixture box.
 * @param {string} runner - The runner name; its settings home is `<name>-machine` in the box's runner home.
 * @param {Record<string, string>} [env] - Extra variables.
 * @param {object} [machineSettings] - Machine settings for the runner process, such as `{ gate: { pulledProfilePaths: true } }`.
 * @returns {Record<string, string>}
 */
export function runnerEnv(box, runner, env = {}, machineSettings) {
  const clean = { ...box.env };
  for (const key of Object.keys(clean)) if (key.startsWith('PULLBOARD_')) delete clean[key];
  const extra = { PULLBOARD_FIXTURE_STEPS: join(box.runnerHome, `${runner}-steps.jsonl`), ...env };
  if (machineSettings) {
    const home = join(box.runnerHome, `${runner}-machine`);
    mkdirSync(home, { recursive: true });
    fixtureMachineSettings(home, machineSettings);
    extra.PULLBOARD_MACHINE_HOME = home;
  }
  return { ...clean, ...extra };
}

/**
 * Run `pullboard runner serve <url> --once` as its own process, with no board environment, and resolve its exit and output.
 * The stand-in tooling records its steps beside the runner's cache, since a runner's checkout is a worktree whose .git is a file.
 * Why it serves again: --once exits on an empty queue, and a test's seat may offer its job only after the serve starts.
 */
export async function serveOnce(box, url, runner, env = {}, { deadlineMs = 120_000, machineSettings } = {}) {
  const clean = runnerEnv(box, runner, env, machineSettings);
  const until = Date.now() + deadlineMs;
  for (;;) {
    const child = spawn(process.execPath, [BIN, 'runner', 'serve', url, '--once', '--as', runner, '--directory', join(box.runnerHome, runner)],
      { cwd: box.runnerHome, env: clean, stdio: ['ignore', 'pipe', 'pipe'] });
    let output = '';
    child.stdout.on('data', chunk => { output += chunk; });
    child.stderr.on('data', chunk => { output += chunk; });
    const served = await new Promise(done => child.once('close', code => done({ code, output })));
    // Each new process is its own pause: its startup takes longer than a seat takes to offer its job.
    if (served.code !== 0 || !/nothing to claim/u.test(served.output) || Date.now() > until) return served;
  }
}

/**
 * Start `pullboard runner serve <url> --as <runner>` as its own process that keeps serving, for a journey that acts while it serves.
 * Resolves once the serve prints its first line (its stop handlers are on by then) with the runner's pid and environment, a
 * stop() that signals that one pid, and closed, which resolves with the serve's exit code after it ends. The environment is
 * runnerEnv's, so machineSettings reach the runner process as serveOnce passes them [P7,#7301,#9880].
 *
 * @param {object} box - The fixture box.
 * @param {string} url - The board URL the runner is given.
 * @param {string} runner - The runner name.
 * @param {Record<string, string>} [env] - Extra variables.
 * @param {{ machineSettings?: object, readyMs?: number }} [options]
 * @returns {Promise<{ pid: number, env: Record<string, string>, output: () => string, stop: () => void, closed: Promise<number | null> }>}
 */
export async function serveBackground(box, url, runner, env = {}, { machineSettings, readyMs = 60_000 } = {}) {
  const clean = runnerEnv(box, runner, env, machineSettings);
  const child = spawn(process.execPath, [BIN, 'runner', 'serve', url, '--as', runner, '--directory', join(box.runnerHome, runner)],
    { cwd: box.runnerHome, env: clean, stdio: ['ignore', 'pipe', 'pipe'] });
  let output = '';
  const closed = new Promise(done => child.once('close', code => done(code)));
  const first = new Promise(done => {
    const heard = chunk => { output += chunk; done(); };
    child.stdout.on('data', heard); child.stderr.on('data', heard);
    child.once('close', done);
  });
  await Promise.race([first, new Promise(done => setTimeout(done, readyMs).unref())]);
  return { pid: child.pid, env: clean, output: () => output, stop: () => { try { process.kill(child.pid, 'SIGTERM'); } catch { /* it already exited */ } }, closed };
}

/**
 * A gate receipt's phase rows with `profileKept` on each row whose timing profile sits beside its kept log in `folder`:
 * `<kept>.profile.json`, as the gate writes it. A row with no kept log, or no profile there, comes back unchanged.
 * Why: the shipped runner names the profiles it kept the same way, and the board reads them back by role [C7,#7301].
 *
 * @param {string} folder - The job's kept folder.
 * @param {{ phases?: object[] }} gate - The parsed gate receipt.
 * @returns {object} The receipt, with profileKept on the rows whose profile is in the folder.
 */
function keepProfiles(folder, gate) {
  if (!Array.isArray(gate?.phases)) return gate;
  return { ...gate, phases: gate.phases.map(phase => {
    const name = typeof phase?.kept === 'string' ? `${phase.kept}.profile.json` : null;
    return name && existsSync(join(folder, name)) ? { ...phase, profileKept: name } : phase;
  }) };
}

/**
 * The board's job queue served on loopback, as the board API serves it, and a small runner client of it: claim, read the
 * request, fetch the candidate from the trunk remote into its own cache, run the job's argv with the request's input
 * on stdin, and post one receipt. Why in the fixture: the shipped runner loop is #5690's; the pull journeys share this one client and stay off it.
 */
export async function loopbackRunner(t, box) {
  const { board, call } = await pullQueue(t, box, { queue: (current, body) => jobQueueCall(current.db, body, { mode: 'pull' }) });
  const env = { ...box.env };
  for (const key of Object.keys(env)) if (key.startsWith('PULLBOARD_')) delete env[key];
  /** Claim one job and check its candidate out; null when the queue is empty. */
  const take = async runner => {
    const { claim } = await call({ action: 'claim', runner, capabilities: ['node22'] });
    if (!claim) return null;
    const held = { job: claim.job, runner, token: claim.token };
    const input = await call({ action: 'request', ...held });
    const folder = join(box.runnerHome, claim.job.replace(/[^\w.-]/gu, '-'));
    execFileSync('git', ['clone', '-q', '--no-checkout', '--no-tags', box.repo, folder], { env });
    execFileSync('git', ['fetch', '-q', '--no-tags', 'origin', `refs/pullboard/gate/${input.item}`], { cwd: folder, env });
    execFileSync('git', ['-c', 'advice.detachedHead=false', 'checkout', '-q', '--detach', input.candidate], { cwd: folder, env });
    return { held, input, folder };
  };
  /** Run a taken job's argv in its checkout and post its one receipt; observe() runs on each event the job's process emits. */
  const run = async ({ held, input, folder }, observe = () => {}) => {
    const { run: argv, input: stdin } = input.request;
    // The job's kept folder is its checkout, so each phase's sanitized log and timing profile land beside each other there [C7,#7301].
    const child = spawn(argv[0] === 'node' ? process.execPath : argv[0], argv.slice(1), { cwd: folder, env: { ...env, PULLBOARD_FIXTURE_JOB: held.job, PULLBOARD_RUNNER_OUTPUT: folder }, stdio: ['pipe', 'pipe', 'pipe'] });
    const out = [];
    // Each step a part records is written while the job's processes are alive, so a sample there sees them running.
    const steps = watch(join(folder, '.git'), observe);
    child.once('spawn', observe);
    child.stdout.on('data', chunk => { out.push(chunk); observe(); });
    child.stderr.on('data', chunk => { out.push(chunk); observe(); });
    child.stdin.end(JSON.stringify(stdin));
    const status = await new Promise(done => child.once('close', done)).finally(() => steps.close());
    const line = Buffer.concat(out).toString('utf8').split('\n').find(row => row.startsWith(GATE_RECEIPT));
    assert.ok(line, `job ${held.job} printed no receipt:\n${Buffer.concat(out).toString('utf8').slice(-4000)}`);
    const gate = keepProfiles(folder, JSON.parse(line.slice(GATE_RECEIPT.length)));
    const receipt = { status, gate, output: { runner: held.runner, folder } };
    await call({ action: 'receipt', ...held, receipt });
    return { job: held.job, folder, status, gate, receipt };
  };
  return { board, take, run };
}

/**
 * Serve one item's pulled gate on a runner started with PULLBOARD_CHROME=none, the item committing `change`; resolves the
 * posted receipt's gate. Why: a runner without a browser must never read a browser journey's skip as a green proof [C7,P7].
 */
export async function servedWithoutBrowser(t, change, tooling = {}) {
  const box = await pullProject(t, 1, { tooling });
  const [id] = box.ids;
  submitOne(box, id, { ...change, subject: `feat(web): pulled gate ${id} [G1]` });
  const queue = await pullQueue(t, box);
  const served = await serveOnce(box, queue.url, 'r-nobrowser', { PULLBOARD_CHROME: 'none' });
  assert.equal(served.code, 0, served.output);
  const row = queue.board.db.prepare("SELECT job_step_payload FROM job_step WHERE job_step_job LIKE ? AND job_step_name = 'receipt' ORDER BY job_step_seq DESC LIMIT 1").get(`gate:${id}:%`);
  assert.ok(row, served.output);
  return JSON.parse(row.job_step_payload).receipt.gate;
}

/**
 * Accept a gated item on the board with the review `pullboard verify` seals: the submitted commit, the trunk it was judged
 * against and the paths it changed since its merge-base with that trunk. Why: an unsealed verdict is judged by the
 * conservative claim-base bound, under which the fixture's own trunk policy commit reads as a main change to the item, and
 * the pulled lander rightly holds it stale [B3,E8,#7269].
 *
 * @param {object} board - The fixture board.
 * @param {string} root - The board host's main checkout.
 * @param {number} id - The item.
 * @param {string} head - The submitted commit the verdict accepts.
 * @returns {ReturnType<typeof verify>}
 */
export function acceptGated(board, root, id, head) {
  const git = (...args) => execFileSync('git', args, { cwd: root, encoding: 'utf8' }).trim();
  const trunk = git('rev-parse', 'refs/heads/main');
  const paths = [...new Set(git('diff', '--no-renames', '--name-only', git('merge-base', trunk, head), head).split('\n').filter(Boolean))].sort();
  return verify(board, id, { agentId: 'coordinator', decision: 'ACCEPT', note: 'fixture acceptance of a gated item', head, digest: getItem(board, id).item_frozen_digest,
    policy: 'any', review: { commit: head, head, trunk, paths } });
}
