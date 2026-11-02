/** Submit fails fast: a main conflict is refused before any check, then static problems before the runner gate [V4,C7]. */
import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { statSync } from 'node:fs';
import { rmSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import { runFixtureGit } from './fixture-child.js';
import { builderRepo } from './submit-gate-fixture.js';
import { commitAll } from './submit-gate-fixture.js';
import { privateRepo } from './submit-gate-fixture.js';
import { put } from './submit-gate-fixture.js';

// Budget: the criterion's ten-second bound for a main conflict, which needs only a local merge-tree.
const CONFLICT_REFUSAL_BOUND_MS = 10_000;
const MARK = path => `node test/mark.mjs ${path}`;

/** A joined builder whose gate, static check and item check each leave their own marker when they run. */
function project(t, { staticFails = false, staticLint = false } = {}) {
  const box = privateRepo(t);
  const markers = { gate: join(box.dir, 'gate.log'), staticCheck: join(box.dir, 'static.log'), item: join(box.dir, 'item.log'), doctrine: join(box.dir, 'doctrine.log') };
  put(box.root, 'pullboard.json', JSON.stringify({ gate: MARK(markers.gate), affectedTests: 'node --test', submitGate: 'landing',
    staticChecks: `${MARK(markers.staticCheck)} && ${staticLint ? 'node bin/static-style-checks.js' : staticFails ? 'node test/static-problem.mjs' : 'true'}`,
    shared: ['pullboard.json'] }));
  put(box.root, 'src/a.js', 'export const value = 1;\n');
  put(box.root, 'test/mark.mjs', "import { appendFileSync } from 'node:fs';\nappendFileSync(process.argv[2], `ran ${Date.now()}\\n`);\n");
  put(box.root, 'test/static-problem.mjs', "console.error('src/a.js:1: a static problem');\nprocess.exit(1);\n");
  put(box.root, 'DOCTRINE.md', `# Doctrine\n\n## D · Fail fast\n- D1 [approved, must] The fixture rule leaves a marker when it runs. | gate: check ${MARK(markers.doctrine)} | count: 0\n`);
  commitAll(box);
  const builder = builderRepo(box);
  assert.equal(builder.coordinator('add', 'build', 'Fail fast fixture', '--check', MARK(markers.item)).code, 0);
  assert.equal(builder.run('claim', '1').code, 0);
  // Adding the item ran its check once to baseline it; only runs after this point count.
  for (const path of Object.values(markers)) rmSync(path, { force: true });
  return { box: builder, markers };
}

test('a change that conflicts with main is refused in seconds, before any static, item or gate run [V4,C7]', t => {
  const { box, markers } = project(t);
  const mainRoot = join(box.dir, 'repo');
  put(mainRoot, 'src/a.js', 'export const value = "main";\n');
  runFixtureGit(['add', 'src/a.js'], { cwd: mainRoot, env: box.env });
  runFixtureGit(['commit', '-q', '-m', 'feat(core): main moves the same line [G1]'], { cwd: mainRoot, env: box.env });
  put(box.root, 'src/a.js', 'export const value = "branch";\n');
  commitAll(box, 'feat(core): the branch moves the same line [G1]');
  const started = Date.now();
  const refused = box.run('submit', '1', '--json', '--infra', 'the fail-fast fixture');
  const elapsed = Date.now() - started;
  assert.notEqual(refused.code, 0);
  assert.match(refused.err + refused.out, /MERGE_CONFLICT/u);
  assert.ok(elapsed < CONFLICT_REFUSAL_BOUND_MS, `refused in ${elapsed}ms`); // budget: the criterion's bound, not a measured margin.
  for (const [name, path] of Object.entries(markers)) assert.equal(existsSync(path), false, `${name} did not run`);
  assert.equal(JSON.parse(box.run('show', '1', '--json').out).item_status, 'claimed');
});

test('a static failure is refused before the item check and the runner gate, and a clean change reaches the gate [V4,C7]', t => {
  const failing = project(t, { staticFails: true });
  put(failing.box.root, 'src/a.js', 'export const value = 2;\n');
  commitAll(failing.box, 'feat(core): change the source [G1]');
  const refused = failing.box.run('submit', '1', '--json', '--infra', 'the fail-fast fixture');
  assert.notEqual(refused.code, 0);
  assert.match(refused.err + refused.out, /a static problem/u);
  assert.equal(existsSync(failing.markers.staticCheck), true, 'the static check ran');
  assert.equal(existsSync(failing.markers.doctrine), false, 'the doctrine rule did not run');
  assert.equal(existsSync(failing.markers.item), false, 'the item check did not run');
  assert.equal(existsSync(failing.markers.gate), false, 'the runner gate did not run');

  const clean = project(t);
  put(clean.box.root, 'src/a.js', 'export const value = 2;\n');
  commitAll(clean.box, 'feat(core): change the source [G1]');
  const accepted = clean.box.run('submit', '1', '--json', '--infra', 'the fail-fast fixture');
  assert.equal(accepted.code, 0, accepted.err + accepted.out);
  assert.equal(existsSync(clean.markers.staticCheck), true, 'the static check ran');
  assert.equal(existsSync(clean.markers.doctrine), true, 'the doctrine rule ran');
  assert.equal(existsSync(clean.markers.item), true, 'the item check ran');
  const when = path => statSync(path).mtimeMs;
  assert.ok(when(clean.markers.staticCheck) <= when(clean.markers.doctrine), 'static runs before doctrine');
  assert.ok(when(clean.markers.doctrine) <= when(clean.markers.item), 'doctrine runs before the runner gate');
});


test('changed import style is refused before cells or gate receipts [V4,C7]', t => {
  const { box, markers } = project(t, { staticLint: true });
  put(box.root, 'src/a.js', "import { readFile, writeFile } from 'node:fs';\nexport { readFile, writeFile };\n");
  commitAll(box, 'feat(core): change source with bad import style [G1]');
  const result = box.run('submit', '1', '--json', '--infra', 'static preflight fixture');
  assert.notEqual(result.code, 0);
  assert.match(result.err + result.out, /src\/a\.js:1: one import binding per line/u);
  assert.doesNotMatch(result.err + result.out, /submit cells inventory|submit cells:/u);
  for (const path of Object.values(markers)) assert.equal(existsSync(path), false);
  const receiptDir = join(box.dir, 'repo', '.git', 'pullboard', 'gate-receipts');
  assert.equal(existsSync(receiptDir), false, 'no gate receipt was written');
});
