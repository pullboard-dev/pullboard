/** A detached verifier clone reads a recorded trunk or its checked commit [D4,A5]. */
import assert from 'node:assert/strict';
import {
  runFixtureChild,
  runFixtureChild as spawnSync,
} from '../../tests/fixtures/child.js';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import { checkAtCommit } from '../../../runner/index.js';
import {
  BIN,
  DOCTRINE,
  renamedDoctrineFixture,
  sandbox,
  shellWord,
  specRows,
} from '../../tests/fixtures/doctrine-name.js';

test('[D4,A5] detached verifier clones use a recorded trunk or their checked commit', async function verifierCloneRetainsTrunkBaseline() {
  const box = sandbox();
  const source = renamedDoctrineFixture(box, 'detached-source');
  const initialized = await box.inProcess(source, 'init');
  assert.equal(initialized.status, 0, `${initialized.stdout}${initialized.stderr}`);
  box.git(source, 'add', '-A');
  box.git(source, 'commit', '-q', '-m', 'chore: initialize detached spec fixture');
  assert.equal(box.git(source, 'config', '--local', '--get', 'pullboard.trunk'), 'refs/heads/main', 'initialization records the actual source trunk');
  const commit = box.git(source, 'rev-parse', 'HEAD');
  const item = { item_id: 324, item_claim_head: commit, item_commit: commit,
    item_frozen: JSON.stringify({ check: `${shellWord(process.execPath)} ${shellWord(BIN)} spec check` }) };

  const checked = checkAtCommit(source, item);
  assert.equal(checked.state, 'pass', `${checked.stage}\n${checked.output}`);
  assert.match(checked.output, /SPEC\.md: \d+ rows, 0 errors, \d+ warnings/u);
  assert.match(checked.output, /DOCTRINE\.md: \d+ rows, 0 errors, \d+ warnings/u);
  assert.match(checked.output, /SPEC\.md:4 G1 warning: known duplicate id; also appears at DOCTRINE\.md:4/u);
  assert.match(checked.output, /DOCTRINE\.md:4 G1 warning: known duplicate id; also appears at SPEC\.md:4/u);

  const attached = await box.inProcess(source, 'spec', 'check');
  assert.equal(attached.status, 0, `${attached.stdout}${attached.stderr}`);
  const attachedRows = await specRows(box, source);
  const jsonFile = join(box.dir, 'verifier-spec-rows.json');
  const json = checkAtCommit(source, { ...item, item_frozen: JSON.stringify({ check: `${shellWord(process.execPath)} ${shellWord(BIN)} spec --json > ${shellWord(jsonFile)}` }) });
  assert.equal(json.state, 'pass', `${json.stage}\n${json.output}`);
  const rows = JSON.parse(readFileSync(jsonFile, 'utf8')).rows;
  assert.deepEqual(rows, attachedRows, 'the production verifier clone reports the same rows as attached main');
  assert.ok(rows.some(row => row.file === 'SPEC.md' && row.id === 'G1'));
  assert.ok(rows.some(row => row.file === DOCTRINE && row.id === 'G1'));

  const withoutTrunk = renamedDoctrineFixture(box, 'detached-source-without-trunk');
  const noTrunkInit = await box.inProcess(withoutTrunk, 'init');
  assert.equal(noTrunkInit.status, 0, `${noTrunkInit.stdout}${noTrunkInit.stderr}`);
  box.git(withoutTrunk, 'add', '-A');
  box.git(withoutTrunk, 'commit', '-q', '-m', 'chore: initialize no-trunk spec fixture');
  const noTrunkCommit = box.git(withoutTrunk, 'rev-parse', 'HEAD');
  // Init and the installed commit hook both remember the attached trunk; remove it only after them.
  box.git(withoutTrunk, 'config', '--local', '--unset-all', 'pullboard.trunk');
  assert.equal(runFixtureChild('git', ['config', '--local', '--get', 'pullboard.trunk'], {
    cwd: withoutTrunk, env: box.env,
  }).status, 1, 'the source actually has no retained trunk');
  const attachedWithoutTrunk = await box.inProcess(withoutTrunk, 'spec', 'check');
  assert.equal(attachedWithoutTrunk.status, 0, `${attachedWithoutTrunk.stdout}${attachedWithoutTrunk.stderr}`);
  assert.doesNotMatch(attachedWithoutTrunk.stdout, /collision baseline default: detached HEAD/u, 'an attached checkout keeps using its own branch');
  box.git(withoutTrunk, 'config', '--local', '--unset-all', 'pullboard.trunk');
  assert.equal(spawnSync('git', ['config', '--local', '--get', 'pullboard.trunk'], {
    cwd: withoutTrunk, env: box.env,
  }).status, 1, 'the source remains without a retained trunk for the detached verifier');
  const detachedWithoutTrunk = checkAtCommit(withoutTrunk, { ...item, item_claim_head: noTrunkCommit, item_commit: noTrunkCommit });
  assert.equal(detachedWithoutTrunk.state, 'pass', `${detachedWithoutTrunk.stage}\n${detachedWithoutTrunk.output}`);
  assert.match(detachedWithoutTrunk.output, /^collision baseline default: detached HEAD$/mu);
  assert.match(detachedWithoutTrunk.output, /SPEC\.md:4 G1 warning: known duplicate id; also appears at DOCTRINE\.md:4/u);
  assert.match(detachedWithoutTrunk.output, /DOCTRINE\.md:4 G1 warning: known duplicate id; also appears at SPEC\.md:4/u);
});
