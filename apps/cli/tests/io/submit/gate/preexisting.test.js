/** @pullboard-test-input source-cell apps/cli apps/lib */
/**
 * An item claimed before the gate existed still submits once the accepted main configures one [C7,B26].
 */
import assert from 'node:assert/strict';
import { runFixtureGit } from '../../../fixtures/child.js';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import { coordinatorLocal } from '../../../fixtures/submit/local.js';
import { runLocal } from '../../../fixtures/submit/local.js';
import { submitWithEnv } from '../../../fixtures/submit/local.js';
import { privateRepo } from '../../../fixtures/submit/gate.js';
import { builderRepo } from '../../../fixtures/submit/gate.js';
import { put } from '../../../fixtures/submit/gate.js';
import { commitAll } from '../../../fixtures/submit/gate.js';

test('cli.journeys-submit-gate-selection-preexisting.an-item-claimed-before-the-gate: an item claimed before the gate existed submits once a gate exists [C7,B26]', async (t) => {
  let box = privateRepo(t);
  put(box.root, 'pullboard.json', JSON.stringify({ gate: '', shared: ['pullboard.json'] }));
  put(box.root, 'src/a.js', 'export const value = 1;\n');
  put(box.root, 'test/a.test.js', [
    "import assert from 'node:assert/strict';",
    "import { appendFileSync } from 'node:fs';",
    "import { value } from '../src/a.js';",
    "appendFileSync(process.env.FIXTURE_GATE_MARKER, 'accepted-main\\n');",
    'assert.equal(value, 2);',
  ].join('\n'));
  box = builderRepo(box);
  assert.equal((await coordinatorLocal(box, 'add', 'build', 'Claim before setup', '--specs', 'G1')).code, 0);
  assert.equal((await runLocal(box, 'claim', '1')).code, 0);
  put(box.root, 'src/a.js', 'export const value = 2;\n');
  commitAll(box, 'feat(core): build the claimed item [G1]');
  const missing = await submitWithEnv(t, box, (...args) => runLocal(box, ...args));
  assert.equal(missing.code, 1, missing.err || missing.out);
  assert.equal(JSON.parse(missing.out).error.code, 'NO_GATE', 'an unconfigured board still refuses');
  const before = JSON.parse((await runLocal(box, 'show', '1', '--json')).out);
  const mainRoot = join(box.dir, 'repo');
  const accepted = JSON.parse(readFileSync(join(mainRoot, 'pullboard.json'), 'utf8'));
  accepted.gate = 'node --test --test-reporter=tap';
  put(mainRoot, 'pullboard.json', JSON.stringify(accepted));
  runFixtureGit(['add', 'pullboard.json'], { cwd: mainRoot, env: box.env });
  runFixtureGit(['commit', '-q', '-m', 'chore: configure the project gate'], { cwd: mainRoot, env: box.env });
  box.git('merge', '--no-edit', 'main');
  const candidate = JSON.parse(readFileSync(join(box.root, 'pullboard.json'), 'utf8'));
  candidate.gate = `node -e "require('node:fs').appendFileSync(process.env.FIXTURE_GATE_MARKER, 'candidate')"`;
  put(box.root, 'pullboard.json', JSON.stringify(candidate));
  commitAll(box, 'chore: expose an untrusted candidate gate');
  const marker = join(box.dir, 'gate-ran.log');
  box.env.FIXTURE_GATE_MARKER = marker;
  const submitted = await submitWithEnv(t, box, (...args) => runLocal(box, ...args), ['--infra', 'the gate was configured after the claim']);
  assert.equal(submitted.code, 0, `${submitted.out}\n${submitted.err}`);
  const receipt = submitted.receipt;
  assert.equal(receipt.gate.green, true);
  assert.equal(receipt.gate.full, true, 'the newly configured gate really runs');
  assert.equal(readFileSync(marker, 'utf8'), 'accepted-main\n', 'only committed accepted-Main policy supplies the missing gate');
  const after = JSON.parse((await runLocal(box, 'show', '1', '--json')).out);
  assert.equal(after.item_frozen_digest, before.item_frozen_digest, 'recovery needs no criterion change or refreeze');
});
