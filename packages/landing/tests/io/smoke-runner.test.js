/** @pullboard-test-input source-cell landing */
/** @pullboard-world-pin: clause 1 reads the smoke source as committed, to prove which functions its runner path can reach. */
/** With gate.runnersOnly on, the landing CLI smoke is a runner job and never a local process [C7,#3011]. */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import { smokeCandidate } from '../../src/io/smoke.js';

const SMOKE = readFileSync(join(import.meta.dirname, '../../src/io/smoke.js'), 'utf8');

/** The body of one exported function in smoke.js, from its signature to the next top-level doc comment. */
function bodyOf(name) {
  const start = SMOKE.indexOf(`export async function ${name}(`);
  assert.notEqual(start, -1, `smoke.js exports ${name}`);
  const end = SMOKE.indexOf('\n/**', start);
  return SMOKE.slice(start, end === -1 ? undefined : end);
}

/** What follows the early local return, the only path gate.runnersOnly leaves reachable. */
function runnerPath(name) {
  const body = bodyOf(name);
  const guard = body.indexOf('if (admission.runnerOnly !== true) return ');
  assert.notEqual(guard, -1, `${name} branches on admission.runnerOnly before doing any work`);
  return body.slice(body.indexOf('\n', guard));
}

test('clause 1: with runnersOnly on, smokeCandidate runs the smoke through runCheckOnRunner and starts no local process [C7]', () => {
  const path = runnerPath('smokeCandidate');
  assert.match(path, /await runCheckOnRunner\(/u);
  for (const local of ['runLandingCliSmoke', 'runCommitCliSmoke', 'spawnSync', 'spawn(', 'execSync']) assert.ok(!path.includes(local), `the runner path never calls ${local}`);
  assert.match(SMOKE, /const RUNNER_SMOKE = `node --input-type=module -e "const \{ runLandingCliSmoke \} = await import\('\.\/packages\/landing\/src\/io\/smoke\.js'\)/u, 'the runner runs the candidate\'s own smoke module');
});

test('clause 1: with runnersOnly on, smokeCommit reaches the smoke only through smokeCandidate on a runner [C7]', () => {
  const path = runnerPath('smokeCommit');
  assert.match(path, /smokeCandidate\(checkout, \{ admission \}\)/u);
  for (const local of ['runLandingCliSmoke', 'runCommitCliSmoke', 'spawnSync', 'spawn(']) assert.ok(!path.includes(local), `the runner path never calls ${local}`);
});

test('clause 1: with runnersOnly on, a candidate that ships no CLI is not smoked locally or on a runner [C7]', async () => {
  assert.deepEqual(await smokeCandidate(import.meta.dirname, { admission: { runnerOnly: true } }), { ran: [] });
});
