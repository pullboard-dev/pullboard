/** A real project and board under gate.runnerDispatch pull, with accepted main's stand-in gate tooling, and its board job queue on loopback [P7]. */
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { spawn } from 'node:child_process';
import { mkdirSync } from 'node:fs';
import { readFileSync } from 'node:fs';
import { rmSync } from 'node:fs';
import { writeFileSync } from 'node:fs';
import { createServer } from 'node:http';
import { dirname } from 'node:path';
import { join } from 'node:path';
import { resolve } from 'node:path';
import { createE2eHelpers } from './e2e.js';
import { fixtureAdd } from './testkit.js';
import { fixtureMachineSettings } from './testkit.js';
import { openKitBoard } from './testkit.js';
import { privateFixtureFiles } from './child.js';
import { fetchFresh } from './http.js';
import { closeBoard } from '../../../lib/index.js';
import { createApiHandler } from '../../../../packages/api/index.js';
import { jobQueueCall } from '../../../../packages/api/index.js';

/** Accepted main's stand-in tooling: each part records its step, the job that ran it and its pid in the checkout it judged, or in PULLBOARD_FIXTURE_STEPS when a runner's checkout is a worktree. */
export const TOOLING = {
  'package.json': '{"type":"module"}\n',
  'bin/record.js': `import { appendFileSync } from 'node:fs';
import { join } from 'node:path';
import { resolve } from 'node:path';
export function record(root, step) { appendFileSync(process.env.PULLBOARD_FIXTURE_STEPS ?? join(root, '.git', 'gate-steps.jsonl'), JSON.stringify({ step, job: process.env.PULLBOARD_FIXTURE_JOB ?? null, pid: process.pid }) + '\\n'); }
`,
  'packages/items/index.js': `import { record } from '../../bin/record.js';
export function requirePlannedSource(root) { record(root, 'placement'); }
export function requireSubmitComposition(root) { record(root, 'composition'); }
`,
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
  'packages/codemap/src/io/cells/scripts/cache.js': 'export function transferredCellsInventories() { return null; }\n',
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
  // The proof holds its job open a moment, so the host is sampled while all the gates run at once.
  'bin/proof.js': `import { record } from './record.js';
record(process.cwd(), 'proof');
Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 400);
`,
  'DOCTRINE.md': '# Doctrine\n\n## D · Rules\n- D1 [approved, must] The fixture rule holds. | gate: check true | count: 0\n',
};

/** Processes on this host whose command line names the board's sandbox: a dispatcher, driver or worker the submit left behind. */
export function hostProcesses(dir) {
  return execFileSync('ps', ['-A', '-o', 'pid=,command='], { encoding: 'utf8' }).split('\n').filter(line => line.includes(dir)).length;
}

/** A real project and board under gate.runnerDispatch pull, whose main carries the stand-in tooling, and the board's loopback job API. */
export async function pullProject(t, count, { check = () => 'true' } = {}) {
  const helpers = createE2eHelpers();
  t.after(helpers.cleanup);
  const box = helpers.project('true', helpers.sandbox());
  mkdirSync(box.env.PULLBOARD_MACHINE_HOME, { recursive: true });
  fixtureMachineSettings(box.env.PULLBOARD_MACHINE_HOME, { gate: { runnerDispatch: 'pull' } });
  for (const [path, text] of Object.entries(TOOLING)) { mkdirSync(dirname(join(box.repo, path)), { recursive: true }); writeFileSync(join(box.repo, path), text); }
  const configFile = join(box.repo, 'pullboard.json');
  writeFileSync(configFile, JSON.stringify({ ...JSON.parse(readFileSync(configFile, 'utf8')), staticChecks: 'node apps/cli/src/io/static/checks.js' }, null, 2) + '\n');
  box.git(box.repo, 'add', '-A');
  box.git(box.repo, 'commit', '-q', '-m', 'chore: stand-in trusted tooling [G1]');
  box.git(box.web, 'merge', '-q', '--ff-only', 'main');
  const ids = [];
  for (let n = 1; n <= count; n++) {
    const added = fixtureAdd(box.run, box.repo, 'web', `Pulled gate ${n}`, '--specs', 'G1', '--criterion', `Gate ${n} runs on a runner.`, '--check', check(n), '--wait', '--json');
    assert.equal(added.code, 0, added.err);
    ids.push(JSON.parse(added.out).item.item_id);
  }
  const boardFile = join(box.repo, '.git', 'pullboard', 'board.sqlite');
  const runnerHome = privateFixtureFiles('pull-runner-').root;
  t.after(() => rmSync(runnerHome, { recursive: true, force: true }));
  return { ...box, helpers, ids, boardFile, runnerHome };
}

/** Claim, commit and submit one item from its own folder; the submit must return green at once. */
export function submitOne(box, id) {
  const claimed = box.run(box.web, 'claim', String(id), '--json');
  assert.equal(claimed.code, 0, claimed.err);
  const folder = JSON.parse(claimed.out).itemFolder ?? box.web;
  assert.equal(box.helpers.commitFile(box, folder, `web/${id}.txt`, `gate ${id}\n`, `feat(web): pulled gate ${id} [G1]`).status, 0);
  const submitted = box.run(folder, 'submit', String(id), '--json');
  assert.equal(submitted.code, 0, `${submitted.err}\n${submitted.out}`);
  return { folder, commit: box.git(folder, 'rev-parse', 'HEAD'), document: JSON.parse(submitted.out) };
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

/**
 * Run `pullboard runner serve <url> --once` as its own process, with no board environment, and resolve its exit and output.
 * The stand-in tooling records its steps beside the runner's cache, since a runner's checkout is a worktree whose .git is a file.
 */
export function serveOnce(box, url, runner, env = {}) {
  env = { PULLBOARD_FIXTURE_STEPS: join(box.runnerHome, `${runner}-steps.jsonl`), ...env };
  const clean = { ...box.env };
  for (const key of Object.keys(clean)) if (key.startsWith('PULLBOARD_')) delete clean[key];
  const child = spawn(process.execPath, [BIN, 'runner', 'serve', url, '--once', '--as', runner, '--directory', join(box.runnerHome, runner)],
    { cwd: box.runnerHome, env: { ...clean, ...env }, stdio: ['ignore', 'pipe', 'pipe'] });
  let output = '';
  child.stdout.on('data', chunk => { output += chunk; });
  child.stderr.on('data', chunk => { output += chunk; });
  return new Promise(done => child.once('close', code => done({ code, output })));
}
