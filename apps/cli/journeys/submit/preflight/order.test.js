/** Submit stage one is preflight: a static failure queues no runner, and a clean change proceeds to the proof [V4,C7]. */
import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { rmSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { builderRepo } from '../../../tests/fixtures/submit/gate.js';
import { commitAll } from '../../../tests/fixtures/submit/gate.js';
import { privateRepo } from '../../../tests/fixtures/submit/gate.js';
import { put } from '../../../tests/fixtures/submit/gate.js';

const MARK = path => `node test/mark.mjs ${path}`;
const GATE_FRONT_DOOR = fileURLToPath(new URL('../../../../../packages/gate/index.js', import.meta.url));

/** A joined builder whose gate, item check, doctrine rule and configured static check each leave a marker when they run. */
function project(t) {
  const box = privateRepo(t);
  const markers = { gate: join(box.dir, 'gate.log'), staticCheck: join(box.dir, 'static.log'), item: join(box.dir, 'item.log'), doctrine: join(box.dir, 'doctrine.log') };
  put(box.root, 'pullboard.json', JSON.stringify({ gate: MARK(markers.gate), affectedTests: 'node --test', submitGate: 'landing',
    staticChecks: `${MARK(markers.staticCheck)} && node --experimental-vm-modules apps/cli/src/io/static/checks.js`, shared: ['pullboard.json'] }));
  put(box.root, 'packages/gate/data/baselines/test-waits-baseline.json', '{}\n');
  put(box.root, 'apps/cli/src/io/static/checks.js', `import { importStyleViolations } from ${JSON.stringify(GATE_FRONT_DOOR)};\nprocess.exitCode = importStyleViolations([]).length;\n`);
  put(box.root, 'src/a.js', 'export const a = 1;\n');
  put(box.root, 'test/mark.mjs', "import { appendFileSync } from 'node:fs';\nappendFileSync(process.argv[2], `ran ${Date.now()}\\n`);\n");
  put(box.root, 'DOCTRINE.md', `# Doctrine\n\n## D · Order\n- D1 [approved, must] The fixture rule leaves a marker when it runs. | gate: check ${MARK(markers.doctrine)} | count: 0\n`);
  commitAll(box);
  const builder = builderRepo(box);
  assert.equal(builder.coordinator('add', 'build', 'Preflight order fixture', '--criterion', 'the fixture change is submitted or refused', '--brief', 'Files: src/a.js\nTest: submit refuses or reaches the gate', '--check', MARK(markers.item), '--route', 'mid', '--wait').code, 0);
  assert.equal(builder.run('claim', '1').code, 0);
  // Adding the item ran its check once to baseline it; only runs after this point count.
  for (const path of Object.values(markers)) rmSync(path, { force: true });
  return { box: builder, markers };
}

test('clause 1: a static failure in preflight refuses before the static, doctrine, item-check and gate stages start [V4,C7]', { timeout: 180_000 }, t => {
  const { box, markers } = project(t);
  // A fixed wait in a test is a registered static failure, and test is the build lane's own folder.
  put(box.root, 'test/w.test.js', 'await new Promise(resolve => setTimeout(resolve, 500));\n');
  commitAll(box, 'feat(core): add a test with a fixed wait [G1]');
  const refused = box.run('submit', '1', '--json', '--infra', 'preflight order fixture');
  assert.notEqual(refused.code, 0, refused.err + refused.out);
  assert.match(refused.err + refused.out, /preflight is red; no runner was queued[\s\S]*test-waits: /u);
  for (const [name, path] of Object.entries(markers)) assert.equal(existsSync(path), false, `${name} never started after a preflight red`);
  assert.equal(JSON.parse(box.run('show', '1', '--json').out).item_status, 'claimed');
});

test('clause 2: a clean change passes preflight and proceeds to the item check and the doctrine rule [V4,C7]', { timeout: 180_000 }, t => {
  const { box, markers } = project(t);
  put(box.root, 'src/a.js', 'export const a = 2;\n');
  commitAll(box, 'feat(core): change source cleanly [G1]');
  const accepted = box.run('submit', '1', '--json', '--infra', 'preflight order fixture');
  assert.equal(accepted.code, 0, accepted.err + accepted.out);
  assert.equal(existsSync(markers.staticCheck), true, 'the static stage ran after preflight');
  assert.equal(existsSync(markers.doctrine), true, 'the doctrine stage ran after preflight');
  assert.equal(existsSync(markers.item), true, 'the item check ran after preflight');
});
