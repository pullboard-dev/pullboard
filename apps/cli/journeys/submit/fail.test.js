/** Submit refuses main conflicts and static failures while independent gate stages run [V4,C7]. */
import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { readdirSync } from 'node:fs';
import { statSync } from 'node:fs';
import { rmSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import {
  runFixtureChild,
  runFixtureGit,
} from '../../tests/fixtures/child.js';
import { runCliInProcess } from '../../tests/fixtures/process.js';
import { builderRepo } from '../../tests/fixtures/submit/gate.js';
import { commitAll } from '../../tests/fixtures/submit/gate.js';
import { privateRepo } from '../../tests/fixtures/submit/gate.js';
import { put } from '../../tests/fixtures/submit/gate.js';
import { withBrief } from '../../tests/fixtures/submit/gate.js';

// Budget: the criterion's ten-second bound for a main conflict, which needs only a local merge-tree.
const CONFLICT_REFUSAL_BOUND_MS = 10_000;
const MARK = path => `node test/mark.mjs ${path}`;
const GATE_FRONT_DOOR = fileURLToPath(new URL('../../../../packages/gate/index.js', import.meta.url));

/** Run one public command in this process from a directory with the fixture's environment, in the child runner's result shape. */
async function inProcess(box, cwd, ...args) {
  const result = await runCliInProcess(withBrief(...args), { cwd, env: box.env });
  return { code: result.status, out: result.stdout, err: result.stderr };
}

/** A joined builder whose gate, static check and item check each leave their own marker when they run. */
async function project(t, { staticFails = false, staticLint = false, staticWaitsForDoctrine = false } = {}) {
  const box = privateRepo(t);
  const markers = { gate: join(box.dir, 'gate.log'), staticCheck: join(box.dir, 'static.log'), item: join(box.dir, 'item.log'), doctrine: join(box.dir, 'doctrine.log') };
  put(box.root, 'pullboard.json', JSON.stringify({ gate: MARK(markers.gate), affectedTests: 'node --test', submitGate: 'landing',
    staticChecks: `${MARK(markers.staticCheck)} && ${staticLint ? 'node --experimental-vm-modules apps/cli/src/io/static/checks.js' : staticFails ? 'node test/static-problem.mjs' : staticWaitsForDoctrine ? `node test/wait-for.mjs ${markers.doctrine}` : 'true'}`,
    shared: ['pullboard.json'] }));
  if (staticLint) {
    put(box.root, 'packages/gate/data/baselines/test-waits-baseline.json', '{}\n');
    put(box.root, 'apps/cli/src/io/static/checks.js', `import { readFileSync } from 'node:fs';
import { importStyleViolations } from ${JSON.stringify(GATE_FRONT_DOOR)};
const sources = ['test/style-bad.js'].map(file => ({ file, source: readFileSync(file, 'utf8') }));
const failures = importStyleViolations(sources);
for (const row of failures) console.error(row.file + ':' + row.line + ': one import binding per line (' + row.count + ' bindings)');
if (failures.length) process.exitCode = 1;
`);
  }
  put(box.root, 'src/a.js', 'export const value = 1;\n');
  put(box.root, 'test/mark.mjs', "import { appendFileSync } from 'node:fs';\nappendFileSync(process.argv[2], `ran ${Date.now()}\\n`);\n");
  // Exits 0 only once the named file exists, so a static check that finishes proves the doctrine rule was running beside it, whatever the load.
  put(box.root, 'test/wait-for.mjs', "import { existsSync } from 'node:fs';\nconst deadline = Date.now() + 60_000;\nwhile (!existsSync(process.argv[2])) {\n  if (Date.now() > deadline) { console.error('the doctrine rule never started beside the static check'); process.exit(1); }\n  await new Promise(resolve => setTimeout(resolve, 20));\n}\n");
  put(box.root, 'test/static-problem.mjs', "console.error('src/a.js:1: a static problem');\nprocess.exit(1);\n");
  put(box.root, 'DOCTRINE.md', `# Doctrine\n\n## D · Fail fast\n- D1 [approved, must] The fixture rule leaves a marker when it runs. | gate: check ${MARK(markers.doctrine)} | count: 0\n`);
  commitAll(box);
  const builder = builderRepo(box);
  assert.equal((await inProcess(builder, join(builder.dir, 'repo'), 'add', 'build', 'Fail fast fixture', '--criterion', 'the fixture change is submitted or refused', '--check', MARK(markers.item))).code, 0);
  assert.equal((await inProcess(builder, builder.root, 'claim', '1')).code, 0);
  // Adding the item ran its check once to baseline it; only runs after this point count.
  for (const path of Object.values(markers)) rmSync(path, { force: true });
  return { box: builder, markers };
}

test('submit precheck refuses a dirty tree without scanning cells or running a gate [V4,C7]', async t => {
  const { box, markers } = await project(t);
  const receiptDir = join(box.dir, 'repo', '.git', 'pullboard', 'gate-receipts');
  const receipts = () => existsSync(receiptDir) ? readdirSync(receiptDir).sort() : [];
  const before = receipts();
  put(box.root, 'src/a.js', 'export const value = 2;\n');
  const result = (await inProcess(box, box.root, 'submit', '1', '--precheck'));
  assert.equal(result.code, 1, result.out + result.err);
  assert.match(result.out + result.err, /\[DIRTY\]/u);
  assert.doesNotMatch(result.out + result.err, /submit cells inventory|submit cells:/u);
  assert.deepEqual(receipts(), before, 'precheck writes no gate receipt');
  for (const marker of Object.values(markers)) assert.equal(existsSync(marker), false, 'no check or gate ran');
});

test('submit precheck refuses a candidate stacked on an unverified item without scanning cells or running a gate [V4,V17,C7]', async t => {
  const { box, markers } = await project(t);
  put(box.root, 'src/a.js', 'export const value = 2;\n');
  commitAll(box, 'feat(core): the first item changes the source [G1]');
  const first = (await inProcess(box, box.root, 'submit', '1', '--json', '--infra', 'the fail-fast fixture'));
  assert.equal(first.code, 0, first.out + first.err);
  const firstCommit = JSON.parse((await inProcess(box, box.root, 'show', '1', '--json')).out).item_commit;
  assert.match(firstCommit, /^[0-9a-f]{40}$/u);
  assert.equal((await inProcess(box, join(box.dir, 'repo'), 'add', 'build', 'Stacked fixture', '--criterion', 'the stacked change is refused cheaply', '--check', MARK(markers.item))).code, 0);
  assert.equal((await inProcess(box, box.root, 'claim', '2')).code, 0);
  put(box.root, 'src/b.js', 'export const other = 1;\n');
  commitAll(box, 'feat(core): the stacked item adds a source [G1]');
  // Only runs from here on count: the first submit and the second add ran the markers on purpose.
  for (const path of Object.values(markers)) rmSync(path, { force: true });
  const receiptDir = join(box.dir, 'repo', '.git', 'pullboard', 'gate-receipts');
  const receipts = () => existsSync(receiptDir) ? readdirSync(receiptDir).sort() : [];
  const before = receipts();
  const result = (await inProcess(box, box.root, 'submit', '2', '--precheck', '--json'));
  assert.equal(result.code, 1, result.out + result.err);
  const error = JSON.parse(result.out).error;
  assert.equal(error.code, 'STACKED_ON_UNVERIFIED', result.out);
  assert.ok(error.message.includes(firstCommit), error.message);
  assert.doesNotMatch(result.out + result.err, /submit cells inventory|submit cells:/u, 'the stack refusal precedes any cell scan');
  assert.deepEqual(receipts(), before, 'precheck writes no gate receipt');
  for (const marker of Object.values(markers)) assert.equal(existsSync(marker), false, 'no check or gate ran');
});

test('a clean submit precheck completes without starting proof [V4,C7]', async t => {
  const { box, markers } = await project(t);
  put(box.root, 'src/a.js', 'export const value = 2;\n');
  commitAll(box, 'feat(core): change the source [G1]');
  const start = Date.now();
  const result = (await inProcess(box, box.root, 'submit', '1', '--precheck', '--json'));
  const elapsed = Date.now() - start;
  assert.equal(result.code, 0, result.out + result.err);
  assert.equal(JSON.parse(result.out).precheck, true);
  assert.ok(elapsed < 15_000, `precheck completed in ${elapsed}ms`); // budget: declared frozen precheck bound.
  for (const marker of Object.values(markers)) assert.equal(existsSync(marker), false, 'no check or gate ran');
});

test('a change that conflicts with main is refused in seconds, before any static, item or gate run [V4,C7]', async t => {
  const { box, markers } = await project(t);
  const mainRoot = join(box.dir, 'repo');
  put(mainRoot, 'src/a.js', 'export const value = "main";\n');
  runFixtureGit(['add', 'src/a.js'], { cwd: mainRoot, env: box.env });
  runFixtureGit(['commit', '-q', '-m', 'feat(core): main moves the same line [G1]'], { cwd: mainRoot, env: box.env });
  put(box.root, 'src/a.js', 'export const value = "branch";\n');
  commitAll(box, 'feat(core): the branch moves the same line [G1]');
  const started = Date.now();
  const refused = (await inProcess(box, box.root, 'submit', '1', '--json', '--infra', 'the fail-fast fixture'));
  const elapsed = Date.now() - started;
  assert.notEqual(refused.code, 0);
  assert.match(refused.err + refused.out, /MERGE_CONFLICT/u);
  assert.ok(elapsed < CONFLICT_REFUSAL_BOUND_MS, `refused in ${elapsed}ms`); // budget: the criterion's bound, not a measured margin.
  for (const [name, path] of Object.entries(markers)) assert.equal(existsSync(path), false, `${name} did not run`);
  assert.equal(JSON.parse((await inProcess(box, box.root, 'show', '1', '--json')).out).item_status, 'claimed');
});

test('a static failure is refused and a clean change reaches the gate [V4,C7]', async t => {
  const failing = await project(t, { staticFails: true });
  put(failing.box.root, 'src/a.js', 'export const value = 2;\n');
  commitAll(failing.box, 'feat(core): change the source [G1]');
  const refused = (await inProcess(failing.box, failing.box.root, 'submit', '1', '--json', '--infra', 'the fail-fast fixture'));
  assert.notEqual(refused.code, 0);
  assert.match(refused.err + refused.out, /a static problem/u);
  assert.equal(existsSync(failing.markers.staticCheck), true, 'the static check ran');

  const clean = await project(t, { staticWaitsForDoctrine: true });
  put(clean.box.root, 'src/a.js', 'export const value = 2;\n');
  commitAll(clean.box, 'feat(core): change the source [G1]');
  const accepted = (await inProcess(clean.box, clean.box.root, 'submit', '1', '--json', '--infra', 'the fail-fast fixture'));
  assert.equal(accepted.code, 0, accepted.err + accepted.out);
  assert.equal(existsSync(clean.markers.staticCheck), true, 'the static check ran');
  assert.equal(existsSync(clean.markers.doctrine), true, 'the doctrine rule ran');
  assert.equal(existsSync(clean.markers.item), true, 'the item check ran');
  // The static check only passes after the doctrine marker exists, so a green submit proves the two stages overlapped.
});


test('changed import style is refused while other stages may run [V4,C7]', async t => {
  const { box, markers } = await project(t, { staticLint: true });
  // The commit hook splits multi-binding imports under src, packages and apps, so the style violation lives in test, which it leaves alone; the build lane owns test.
  put(box.root, 'test/style-bad.js', "import { readFile, writeFile } from 'node:fs';\nexport { readFile, writeFile };\n");
  commitAll(box, 'feat(core): change source with bad import style [G1]');
  // Process-level: runs the static checker as its own node process, the way the submit static stage starts it.
  const checked = runFixtureChild(process.execPath, ['--experimental-vm-modules', 'apps/cli/src/io/static/checks.js'],
    { cwd: box.root, env: box.env, encoding: 'utf8' });
  const checkerOutput = checked.failure ?? checked.stderr ?? '';
  assert.notEqual(checked.status, 0, checkerOutput);
  assert.match(checkerOutput, /test\/style-bad\.js:1: one import binding per line/u);
  const result = (await inProcess(box, box.root, 'submit', '1', '--json', '--infra', 'static preflight fixture'));
  assert.equal(existsSync(markers.staticCheck), true, 'the submit static stage actually ran');
  assert.notEqual(result.code, 0, result.err + result.out);
  assert.match(result.err + result.out, /test\/style-bad\.js:1: one import binding per line/u);
  // The independent stages start beside the static check, so whether they ran before the refusal is not part of the contract.
  assert.equal(JSON.parse((await inProcess(box, box.root, 'show', '1', '--json')).out).item_status, 'claimed', 'a static refusal leaves the item claimed');
});
