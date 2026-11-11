/** @pullboard-test-input source-tree */
/** A green native test account covers every selected file even when its reporter emits no case timings [C7,V4]. */
import assert from 'node:assert/strict';
import { mkdirSync } from 'node:fs';
import { existsSync } from 'node:fs';
import { readFileSync } from 'node:fs';
import { readdirSync } from 'node:fs';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { resolve } from 'node:path';
import { test } from 'node:test';
import { createE2eHelpers } from '../../tests/fixtures/e2e.js';
import { runCliInProcess } from '../../tests/fixtures/process.js';
import { writeTestTiers } from '../../../../packages/gate/index.js';
import { requireTestTierAccount } from '../../../../packages/gate/index.js';
import { waitForCondition } from '../../tests/fixtures/runner/holders.js';

/** Commit real fixture source through its ordinary installed hooks. */
function commit(box, cwd, message) {
  box.git(cwd, 'add', '-A');
  box.git(cwd, 'commit', '-q', '-m', message);
  return box.git(cwd, 'rev-parse', 'HEAD');
}

/** Keep installed tool paths literal when the real shell executes the fixture's gate. */
function shellWord(value) { return `'${value.replaceAll("'", "'\\''")}'`; }

/** Run production parsing, native moves and actual check execution, without unrelated next-work dispatch. */
async function json(box, cwd, ...args) {
  const result = await runCliInProcess([...args, '--json'], { cwd, env: box.env });
  assert.equal(result.code, 0, result.err + result.out);
  return JSON.parse(result.out);
}

test('a green dot-reporter gate records both selected files and accepts with its native test account [C7,V4]', async t => {
  const helpers = createE2eHelpers();
  let box;
  t.after(() => helpers.cleanup());
  box = helpers.project('true');
  const runner = `${shellWord(process.execPath)} ${shellWord(resolve(import.meta.dirname, '../../../../packages/gate/src/io/run/tests.js'))} --test-reporter=dot`;
  const check = `node -e "if (!require('node:fs').readFileSync('packages/alpha/index.js', 'utf8').includes('value = 2')) process.exit(1)"`;
  writeFileSync(join(box.repo, 'package.json'), '{"type":"module"}\n');
  const config = { ...helpers.CONFIG, gate: runner, affectedTests: runner, submitGate: 'landing',
    submitInvariants: [], registryGuards: [], submit: { handoff: false },
    lanes: { ...helpers.CONFIG.lanes, web: { owns: ['packages/', 'test/'], specs: ['G1'] } } };
  writeFileSync(join(box.repo, 'pullboard.json'), JSON.stringify(config));
  mkdirSync(join(box.repo, 'packages/alpha'), { recursive: true });
  mkdirSync(join(box.repo, 'test'), { recursive: true });
  writeFileSync(join(box.repo, 'packages/alpha/index.js'), 'export const value = 1;\n\n\n\n\n');
  const files = ['test/alpha-one.test.js', 'test/alpha-two.test.js'];
  for (const file of files) writeFileSync(join(box.repo, file), `import assert from 'node:assert/strict';
import { test } from 'node:test';
import { value } from '../packages/alpha/index.js';
test('${file} preserves its package value [G1]', () => assert.equal(value, 2));
`);
  writeTestTiers(box.repo);
  commit(box, box.repo, 'test: configure two selected native accounts [G1]');
  box.git(box.web, 'merge', '-q', '--ff-only', 'main');
  const id = (await json(box, box.repo, 'add', 'web', 'Native account covers both files', '--specs', 'G1',
    '--criterion', 'Both selected unit files pass.', '--check', check, '--wait')).item.item_id;
  await json(box, box.web, 'claim', String(id));
  const builtInput = join(box.web, 'packages/alpha/index.js');
  writeFileSync(builtInput, readFileSync(builtInput, 'utf8').replace('value = 1', 'value = 2'));
  const head = commit(box, box.web, 'feat(web): satisfy both unit files [G1]');
  const submitted = await json(box, box.web, 'submit', String(id), '--wait', '--no-next');
  assert.equal(submitted.gate.green, true);
  assert.deepEqual(submitted.gate.files, files);
  const account = JSON.parse(readFileSync(submitted.gate.profilePath, 'utf8'));
  assert.deepEqual([...new Set(account.testOutcomes.map(row => row.file))].sort(), files);

  // Finish the detached diagnostic while this case still owns its active-test budget.
  // An after hook otherwise waits after Node announces test completion, hitting the file-exit guard.
  const comparisons = join(box.repo, '.git/pullboard/review-comparisons');
  const jobs = existsSync(comparisons) ? readdirSync(comparisons).map(job => join(comparisons, job)) : [];
  await waitForCondition(() => jobs.every(job => existsSync(join(job, 'result.json'))),
    'owned automatic comparison to finish before advancing main', { signal: t.signal });
  const observed = await json(box, box.repo, 'show', String(id));
  assert.equal(observed.comparison.status, 'unavailable', 'an empty runner pool cannot invent a diagnostic account');
  assert.match(observed.comparison.error, /no configured runner/u);


  // Move a checked input on accepted main so a private review cannot reuse the earlier submit proof.
  mkdirSync(join(box.repo, 'docs'), { recursive: true });
  writeFileSync(join(box.repo, 'docs/account.txt'), 'Review against the current accepted main.\n');
  const input = join(box.repo, 'packages/alpha/index.js');
  writeFileSync(input, readFileSync(input, 'utf8') + '// main changed this checked input\n');
  commit(box, box.repo, 'docs: advance main after the selected gate [G1]');
  const reviewer = join(box.dir, 'account-review');
  box.git(box.repo, 'worktree', 'add', '-q', '--detach', reviewer, head);
  await json(box, reviewer, 'join', 'api', '--model', 'Private account reviewer', '--route', 'strong');
  const accepted = await json(box, reviewer, 'verify', String(id), 'accept', '--no-next',
    '--note', 'Both selected files have a native source-bound account.');
  assert.equal(accepted.decision, 'ACCEPT');
  const directory = join(box.repo, '.git/pullboard/check-output');
  const profiles = readdirSync(directory).filter(file => file.endsWith('.profile.json'))
    .map(file => JSON.parse(readFileSync(join(directory, file), 'utf8')));
  const checked = profiles.find(profile => profile.tests.length === 0 && profile.testOutcomes?.length === files.length);
  assert.ok(checked, 'private review persists its structured account even with no TAP/JUnit case timings');
  assert.deepEqual([...new Set(checked.testOutcomes.map(row => row.file))].sort(), files);
  assert.throws(() => requireTestTierAccount({ green: true, profile: { ...checked,
    testOutcomes: checked.testOutcomes.filter(row => row.file === files[0]) } }, files),
  { code: 'TEST_SELECTION_UNVERIFIED' }, 'an account missing the other selected file still refuses');
  assert.throws(() => requireTestTierAccount({ green: true, profile: { tests: [] } }, files),
    { code: 'TEST_SELECTION_UNVERIFIED' }, 'a green shell exit alone cannot invent an account');
});
