/** Submit refuses a dirty tree, a main conflict and a static failure in its own process before any gate job is offered [V4,C7]. */
import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { readdirSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import {
  runFixtureChild,
  runFixtureGit,
} from '../../tests/fixtures/child.js';
import { MARK } from '../../tests/fixtures/submit/fail.js';
import { inProcess } from '../../tests/fixtures/submit/fail.js';
import { project } from '../../tests/fixtures/submit/fail.js';
import { commitAll } from '../../tests/fixtures/submit/gate.js';
import { put } from '../../tests/fixtures/submit/gate.js';

// Budget: the criterion's ten-second bound for a main conflict, which needs only a local merge-tree.
const CONFLICT_REFUSAL_BOUND_MS = 10_000;

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
  // Process-level: the conflict is refused by the submitting process before any gate job is offered, so it stays a child.
  const refused = box.run('submit', '1', '--json', '--no-next', '--infra', 'the fail-fast fixture');
  const elapsed = Date.now() - started;
  assert.notEqual(refused.code, 0);
  assert.match(refused.err + refused.out, /MERGE_CONFLICT/u);
  assert.ok(elapsed < CONFLICT_REFUSAL_BOUND_MS, `refused in ${elapsed}ms`); // budget: the criterion's bound, not a measured margin.
  for (const [name, path] of Object.entries(markers)) assert.equal(existsSync(path), false, `${name} did not run`);
  assert.equal(JSON.parse((await inProcess(box, box.root, 'show', '1', '--json')).out).item_status, 'claimed');
});

test('changed import style is refused while other stages may run [V4,C7]', async t => {
  const { box, markers } = await project(t, { staticLint: true });
  // The commit hook splits multi-binding imports under src, packages and apps, so the style violation lives in test, which it leaves alone; the build lane owns test.
  put(box.root, 'test/style-bad.js', "import { readFile, writeFile } from 'node:fs';\nexport { readFile, writeFile };\n");
  commitAll(box, 'feat(core): change source with bad import style [G1]');
  // Process-level: runs the static checker as its own node process, the way the submit static stage starts it.
  const checked = runFixtureChild(process.execPath, ['--experimental-vm-modules', 'tools/style-check.js'],
    { cwd: box.root, env: box.env, encoding: 'utf8' });
  const checkerOutput = checked.failure ?? checked.stderr ?? '';
  assert.notEqual(checked.status, 0, checkerOutput);
  assert.match(checkerOutput, /test\/style-bad\.js:1: one import binding per line/u);
  // Process-level: the static preflight refuses in the submitting process before any gate job is offered, so it stays a child.
  // The checker is not named apps/cli/src/io/static/checks.js: submit runs that path as Pullboard's own checker, not as configured.
  const result = box.run('submit', '1', '--json', '--no-next', '--infra', 'static preflight fixture');
  assert.equal(existsSync(markers.staticCheck), true, `the submit static stage actually ran: ${JSON.stringify(result)}`);
  assert.notEqual(result.code, 0, result.err + result.out);
  assert.match(result.err + result.out, /test\/style-bad\.js:1: one import binding per line/u);
  // The independent stages start beside the static check, so whether they ran before the refusal is not part of the contract.
  assert.equal(JSON.parse((await inProcess(box, box.root, 'show', '1', '--json')).out).item_status, 'claimed', 'a static refusal leaves the item claimed');
});
