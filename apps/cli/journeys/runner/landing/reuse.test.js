/** A land job reuses the ledger hits its gates recorded: the runner service's own environment never changes the proof's context key [P7]. */
import assert from 'node:assert/strict';
import { mkdirSync } from 'node:fs';
import { rmSync } from 'node:fs';
import { writeFileSync } from 'node:fs';
import { delimiter } from 'node:path';
import { dirname } from 'node:path';
import { join } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { pathToFileURL } from 'node:url';
import { git } from '../../../../../packages/git/index.js';
import { jobQueueCall } from '../../../../../packages/api/index.js';
import { offerLandingJob } from '../../../../../packages/api/index.js';
import { phaseLedger } from '../../../../../packages/gate/index.js';
import { planTestActions } from '../../../../../packages/gate/index.js';
import { childEnvironment } from '../../../../../packages/kernel/light.js';
import { takeLandingJob } from '../../../../../packages/landing/index.js';
import { recordTestResults } from '../../../../../packages/store/index.js';
import { cellBoard } from '../../../../../packages/store/tests/fixtures/cell.js';
import { fixtureCommittedGraph } from '../../../tests/fixtures/testkit.js';
import { privateFixtureFiles } from '../../../tests/fixtures/child.js';

const AS = ['-c', 'user.name=Tester', '-c', 'user.email=tester@example.com', '-c', 'core.hooksPath=/dev/null'];
const GATE = pathToFileURL(fileURLToPath(new URL('../../../../../packages/gate/index.js', import.meta.url))).href;
// The fixture's runner: plan with the ledger hits run-tests reads, then run only the misses, as the project runner does.
const RUNNER = `import { spawnSync } from 'node:child_process';
import { planTestActions } from ${JSON.stringify(GATE)};
const files = process.argv.slice(2);
const plan = await planTestActions(process.cwd(), files, { fullSuite: false, landing: true, listFiles: () => files });
const { NODE_TEST_CONTEXT, ...env } = process.env;
if (!plan.done) process.exitCode = spawnSync(process.execPath, ['--test', ...plan.args], { stdio: 'inherit', env }).status ?? 1;
`;
// What a launchd runner service carries: no TZ or LANG, and declared names a pulled job never inherits.
const SERVICE = { TZ: undefined, LANG: undefined, LC_ALL: 'C', PULLBOARD_TEST_TIMEOUT_MS: '600000' };

/** A trunk remote and a checkout with two sources, a test for each and the fixture runner. */
function project(t) {
  const { root } = privateFixtureFiles('pullboard-land-reuse-');
  const graph = fixtureCommittedGraph('pullboard-land-reuse-dev-');
  t.after(() => { rmSync(root, { recursive: true, force: true }); rmSync(graph.root, { recursive: true, force: true }); });
  const dev = graph.root;
  const put = (file, text) => { mkdirSync(dirname(join(dev, file)), { recursive: true }); writeFileSync(join(dev, file), text); git(dev, ['add', file]); };
  const commit = message => { git(dev, [...AS, 'commit', '-q', '-m', message]); return git(dev, ['rev-parse', 'HEAD']); };
  put('package.json', '{ "type": "module" }\n');
  put('bin/proof.mjs', RUNNER);
  put('src/a.js', 'export const a = 1;\n');
  put('src/b.js', 'export const b = 2;\n');
  put('test/a.test.js', "import { test } from 'node:test';\nimport { a } from '../src/a.js';\ntest('a', () => { if (a !== 1) throw new Error('a'); });\n");
  put('test/b.test.js', "import { test } from 'node:test';\nimport { b } from '../src/b.js';\ntest('b', () => { if (b !== 2) throw new Error('b'); });\n");
  const seed = commit('chore: seed');
  const remote = join(root, 'trunk.git');
  git(root, ['clone', '-q', '--bare', dev, remote]);
  git(dev, ['remote', 'add', 'origin', remote]);
  return { root, dev, remote, seed, put, commit };
}

/** Run the runner service under SERVICE's environment until the test ends. */
function serviceEnvironment(t) {
  const saved = Object.fromEntries(Object.keys(SERVICE).map(name => [name, process.env[name]]));
  const apply = values => { for (const [name, value] of Object.entries(values)) { if (value === undefined) delete process.env[name]; else process.env[name] = value; } };
  apply(SERVICE);
  t.after(() => apply(saved));
}

/** The item's gate as a pulled gate job runs it: under the runner's job environment, recorded as the board's ledger rows. */
async function proveItem(board, box, commit) {
  git(box.dev, ['checkout', '-q', '--detach', commit]);
  const folder = join(box.root, 'gate-env');
  for (const path of ['home', 'tmp']) mkdirSync(join(folder, path), { recursive: true });
  const job = childEnvironment({ safePath: [dirname(process.execPath), process.env.PATH].join(delimiter), workerId: 'gate' }, join(folder, 'home'), join(folder, 'tmp'));
  const env = { ...job, PULLBOARD_PULLED_JOB: '1', PULLBOARD_TEST_REUSE: 'record', PULLBOARD_TEST_RESULT_STORE: join(box.root, 'gate-store') };
  const files = ['./test/a.test.js', './test/b.test.js'], written = [];
  await planTestActions(box.dev, files, { fullSuite: false, listFiles: () => files, env, write: text => written.push(text) });
  const ledger = phaseLedger(written.join(''), { status: 0 });
  assert.equal(ledger?.files.length, 2, `the gate run printed keyed frames: ${written.join('').slice(0, 2000)}`);
  const rows = ledger.files.map(([file, inputKey, context, status]) => ({ file, inputKey, command: 'proof', context: ledger.contexts[context], status }));
  assert.equal(recordTestResults(board.db, { receipt: `gate:${commit.slice(0, 8)}#0`, origin: 'pulled:r-gate', commit, rows }), 2);
  return { contexts: ledger.contexts, env: job };
}

test('clause 1: a landing after an unrelated main move reruns 0 proven files, though the runner service has no TZ or LANG [P7]', { timeout: 120_000 }, async t => {
  serviceEnvironment(t);
  const box = project(t);
  const board = cellBoard(t, ':memory:');
  git(box.dev, ['checkout', '-q', '--detach', box.seed]);
  box.put('src/a.js', 'export const a = 1; // item\n');
  const item = box.commit('feat(core): item [P7]');
  git(box.dev, ['push', '-q', 'origin', `${item}:refs/heads/item/1`]);
  const { contexts, env } = await proveItem(board, box, item);
  assert.equal(contexts.length, 1, 'the gate recorded one context class');
  git(box.dev, ['checkout', '-q', '--detach', box.seed]);
  box.put('docs/notes.md', 'unrelated\n');
  git(box.dev, ['push', '-q', 'origin', `${box.commit('docs: unrelated [P7]')}:refs/heads/main`]);
  offerLandingJob(board.db, { items: [{ id: 1, commit: item, ref: 'refs/heads/item/1' }], expect: box.seed, config: { trunk: { remote: box.remote }, affectedTests: 'node bin/proof.mjs' } });
  const taken = await takeLandingJob({ call: body => jobQueueCall(board.db, body, { mode: 'pull' }), runner: 'r-land', workdir: join(box.root, 'runners', 'r-land'), env });
  assert.equal(taken.receipt.outcome, 'landed', taken.receipt.detail ?? '');
  assert.deepEqual(taken.receipt.proof, { files: 2, reused: 2, ran: 0 }, 'the proof keyed both files under the gate\'s context class, so none reran');
});
