/** Approved requirements change only through a visible person decision [P6,B23,N39]. */
import { loadDoctrine } from '../../../../packages/doctrine/index.js';
import assert from 'node:assert/strict';
import {
  mkdirSync,
  readFileSync,
  writeFileSync,
} from 'node:fs';
import { join } from 'node:path';
import {
  after,
  test,
} from 'node:test';
import { createE2eHelpers } from '../../tests/fixtures/e2e.js';
import { personNeedsState } from '../../../view/index.js';
import { parseSpec } from '../../../../packages/spec/index.js';
import { loadConfig } from '../../../../packages/config/index.js';
import {
  planSpecRevision,
  validSpecRevision,
} from '../../../../packages/spec/index.js';

const fixtures = createE2eHelpers();
after(fixtures.cleanup);

/** Require a successful real command and retain its diagnostics on failure. */
function succeeds(result) {
  assert.equal(result.code, 0, `${result.out}\n${result.err}`);
  return result;
}

/** Read one actual requirement from the fixture's current SPEC bytes. */
function row(box, id) {
  return parseSpec(readFileSync(join(box.repo, 'SPEC.md'), 'utf8')).rows.find(entry => entry.id === id);
}

test('cli.journeys-spec-revise.a-proposed-change-to-an-approved: a proposed change to an approved row waits in Needs you and applies only when the person approves it [P6,B23,N39]', { timeout: 120_000 }, async () => {
  const box = fixtures.project('true');
  const file = join(box.repo, 'SPEC.md');
  const original = readFileSync(file, 'utf8');
  const proposal = JSON.parse(succeeds(await box.runIn(box.web, 'spec', 'draft', 'The page renders accessibly.',
    '--revises', 'G1', '--gate', 'true', '--reason', 'The old gate was removed.', '--json')).out);
  assert.ok(proposal.id && proposal.id !== 'G1', 'the proposal has its own actionable identity');
  assert.equal(readFileSync(file, 'utf8'), original, 'proposing never edits the approved requirement');
  const need = personNeedsState(box.repo).needs.find(entry => entry.id === proposal.id);
  assert.ok(need, 'the person receives the proposed revision in Needs you');
  const shown = JSON.stringify(need);
  for (const text of ['The page renders.', 'The page renders accessibly.', 'web test', 'true', 'The old gate was removed.']) {
    assert.ok(shown.includes(text), `Needs you includes the old/new effect and reason: ${text}`);
  }
  const agentApproval = await box.runIn(box.web, 'spec', 'approve', proposal.id);
  assert.notEqual(agentApproval.code, 0, 'an agent cannot approve its proposal');
  succeeds(await box.runIn(box.repo, 'spec', 'apply'));
  assert.equal(readFileSync(file, 'utf8'), original, 'apply before a person decision leaves the row untouched');
  succeeds(await box.runIn(box.repo, 'spec', 'approve', proposal.id));
  assert.equal(readFileSync(file, 'utf8'), original, 'the person decision remains pending explicit apply');
  succeeds(await box.runIn(box.repo, 'spec', 'apply'));
  assert.equal(row(box, 'G1').text, 'The page renders accessibly.');
  assert.equal(row(box, 'G1').gate, 'true');
  assert.equal(row(box, 'G1').status, 'approved');
  assert.ok(!personNeedsState(box.repo).needs.some(entry => entry.id === proposal.id), 'the completed proposal leaves Needs you');
  const history = JSON.parse(succeeds(await box.runIn(box.repo, 'export')).out).tables.event;
  const decision = history.find(event => event.event_kind === 'row_decision' && JSON.stringify(event).includes(proposal.id));
  assert.ok(decision, 'durable row history identifies the proposal and person decision');
  assert.equal(decision.event_by, 'person', 'the approval history attributes the actual person');
  box.git(box.repo, 'add', 'SPEC.md');
  box.git(box.repo, 'commit', '-q', '-m', 'feat: apply the person-approved revision [G1]');
  box.git(box.web, 'merge', '-q', '--ff-only', 'main');

  const approved = readFileSync(file, 'utf8');
  const declined = JSON.parse(succeeds(await box.runIn(box.web, 'spec', 'draft', 'An unwanted replacement.',
    '--revises', 'G1', '--status', 'retired', '--reason', 'Consider retiring it.', '--json')).out);
  succeeds(await box.runIn(box.repo, 'spec', 'decline', declined.id, '--reason', 'Keep the existing requirement.'));
  succeeds(await box.runIn(box.repo, 'spec', 'apply'));
  assert.equal(readFileSync(file, 'utf8'), approved, 'declining a revision never retires or rejects its approved target');
  assert.ok(!personNeedsState(box.repo).needs.some(entry => entry.id === declined.id));

  writeFileSync(file, approved.replace('The page renders accessibly.', 'An agent silently changed it.'));
  box.git(box.repo, 'add', 'SPEC.md');
  const handEdit = box.tryGit(box.repo, 'commit', '-q', '-m', 'feat: silently rewrite the approved requirement [G1]');
  assert.notEqual(handEdit.status, 0, 'the real commit hook refuses a direct approved-row rewrite');
  assert.match(handEdit.stderr, /APPROVED_ROW_CHANGE|approved row|changes approved text/u);
  writeFileSync(file, approved);
  box.git(box.repo, 'add', 'SPEC.md');

  const retired = JSON.parse(succeeds(await box.runIn(box.web, 'spec', 'draft', 'The page renders accessibly.',
    '--revises', 'G1', '--status', 'retired', '--reason', 'The feature is no longer supported.', '--json')).out);
  succeeds(await box.runIn(box.repo, 'spec', 'approve', retired.id));
  succeeds(await box.runIn(box.repo, 'spec', 'apply'));
  assert.equal(row(box, 'G1').status, 'retired', 'the person can approve an explicit status revision');
  assert.ok(!personNeedsState(box.repo).needs.some(entry => [proposal.id, retired.id].includes(entry.id)), 'older applied revisions stay closed after the target gets a newer decision');
  box.git(box.repo, 'add', 'SPEC.md');
  box.git(box.repo, 'commit', '-q', '-m', 'chore: apply the person-approved retirement');
  box.git(box.web, 'merge', '-q', '--ff-only', 'main');
  assert.notEqual((await box.runIn(box.web, 'spec', 'draft', 'Change a retired row.', '--revises', 'G1', '--reason', 'Not approved.')).code, 0);

});

test('cli.journeys-spec-revise.p6-b23-n39-revisions-require-a: [P6,B23,N39] revisions require a reason and stale proposals cannot change a newer approved row', { timeout: 120_000 }, async () => {
  const box = fixtures.project('true');
  assert.notEqual((await box.runIn(box.web, 'spec', 'draft', 'Missing reason.', '--revises', 'G1')).code, 0);
  assert.notEqual((await box.runIn(box.web, 'spec', 'draft', 'Missing target.', '--revises', 'G99', '--reason', 'No such row.')).code, 0);
  const statusOnly = JSON.parse(succeeds(await box.runIn(box.web, 'spec', 'draft', '--revises', 'G1', '--status', 'retired', '--reason', 'Consider retirement.', '--json')).out);
  const statusNeed = personNeedsState(box.repo).needs.find(entry => entry.id === statusOnly.id);
  assert.equal(statusNeed.proposed.text, 'The page renders.', 'omitted text preserves the approved wording');
  succeeds(await box.runIn(box.repo, 'spec', 'decline', statusOnly.id, '--reason', 'Keep it.'));
  const first = JSON.parse(succeeds(await box.runIn(box.web, 'spec', 'draft', 'An obsolete proposal.', '--revises', 'G1', '--reason', 'First idea.', '--json')).out);
  const second = JSON.parse(succeeds(await box.runIn(box.web, 'spec', 'draft', 'The replacement the person chooses.', '--revises', 'G1', '--reason', 'Better idea.', '--json')).out);
  assert.notEqual((await box.runIn(box.repo, 'spec', 'approve', first.id, second.id)).code, 0, 'one batch cannot overwrite two proposals for the same target');
  for (const id of [first.id, second.id]) {
    assert.equal(personNeedsState(box.repo).needs.find(entry => entry.id === id).what, 'approve or decline revision', 'a refused batch records no partial approval');
  }
  succeeds(await box.runIn(box.repo, 'spec', 'approve', second.id));
  assert.notEqual((await box.runIn(box.repo, 'spec', 'approve', first.id)).code, 0, 'a later command cannot orphan an unapplied approval');
  succeeds(await box.runIn(box.repo, 'spec', 'apply'));
  const approved = readFileSync(join(box.repo, 'SPEC.md'), 'utf8');
  assert.notEqual((await box.runIn(box.repo, 'spec', 'approve', first.id)).code, 0, 'a stale source cannot be approved over a different current row');
  succeeds(await box.runIn(box.repo, 'spec', 'decline', first.id, '--reason', 'Superseded.'));
  succeeds(await box.runIn(box.repo, 'spec', 'apply'));
  assert.equal(readFileSync(join(box.repo, 'SPEC.md'), 'utf8'), approved);
  assert.ok(!personNeedsState(box.repo).needs.some(entry => entry.id === first.id));
});

test('cli.journeys-spec-revise.b23-n39-a-real-gate-rename: [B23,N39] a real gate rename gives the new path and an exact revision command', { timeout: 120_000 }, async () => {
  const box = fixtures.sandbox();
  const root = join(box.dir, 'existing-repo');
  mkdirSync(root);
  mkdirSync(join(root, 'test'));
  box.git(root, 'init', '-q', '-b', 'main');
  writeFileSync(join(root, 'pullboard.json'), JSON.stringify({ ...fixtures.CONFIG, gate: 'true' }));
  writeFileSync(join(root, 'SPEC.md'), '# Existing project\n\n## G · Goals\n- G1 [approved, must] The page renders. | gate: node --test test/old.test.js\n');
  writeFileSync(join(root, 'test/old.test.js'), '// A tracked test in the project before Pullboard was installed.\n');
  box.git(root, 'add', '-A');
  box.git(root, 'commit', '-q', '-m', 'test: establish the existing gate');
  box.git(root, 'mv', 'test/old.test.js', 'test/new.test.js');
  writeFileSync(join(root, 'test/new.test.js'), '// A tracked test in the project before Pullboard was installed.\n// Renamed with an edit, so the gate repoint needs a person.\n');
  box.git(root, 'add', '-A');
  box.git(root, 'commit', '-q', '-m', 'test: rename the gate');
  succeeds(await box.runIn(root, 'init'));
  const check = await box.runIn(root, 'spec', 'check');
  assert.notEqual(check.code, 0);
  const output = check.out + check.err;
  assert.match(output, /renamed to test\/new\.test\.js/u);
  assert.ok(output.includes("pullboard spec draft 'The page renders.' --revises 'G1' --gate 'node --test test/new.test.js' --reason 'Gate renamed from test/old.test.js to test/new.test.js.'"));
});

test('cli.journeys-spec-revise.p6-b23-revision-plans-preserve-omitted: [P6,B23] revision plans preserve omitted fields and refuse formatting-only changes', { timeout: 120_000 }, () => {
  const box = fixtures.project('true');
  const file = join(box.repo, 'SPEC.md');
  const source = readFileSync(file, 'utf8').replace('- G1 [approved, must] The page renders. | gate: web test',
    '- G1 [approved] The page renders. | gate: check node old | grep ok | count: 0 | serves: G2   ');
  writeFileSync(file, source);
  const config = loadConfig(box.repo);
  const unchanged = { revises: 'G1', reason: 'Explain a change.', taken: [] };
  assert.throws(() => planSpecRevision(box.repo, config, unchanged, { loadDoctrine }), error => error.code === 'SPEC_REVISION' && /unchanged/u.test(error.message));
  const text = planSpecRevision(box.repo, config, { ...unchanged, text: 'The page renders accessibly.' }, { loadDoctrine });
  assert.equal(text.replacement, text.source.replace('The page renders.', 'The page renders accessibly.'));
  assert.ok(validSpecRevision(text));
  const gate = planSpecRevision(box.repo, config, { ...unchanged, gate: 'true' }, { loadDoctrine });
  assert.equal(gate.replacement, gate.source.replace('check node old | grep ok', 'true'));
  assert.ok(validSpecRevision(gate));
  const status = planSpecRevision(box.repo, config, { ...unchanged, status: 'retired' }, { loadDoctrine });
  assert.equal(status.replacement, status.source.replace('[approved]', '[retired]'));
  assert.ok(validSpecRevision(status));
  assert.equal(validSpecRevision({ ...text, status: 'bogus',
    replacement: text.replacement.replace('[approved]', '[bogus]') }), false,
    'the ordered draft validator independently rejects syntactically parsed but unknown statuses');
  assert.equal(validSpecRevision({ ...text, replacement: `${text.replacement} | signers: someone-else` }), false,
    'a revision payload cannot silently introduce fields outside text, gate and status');
  assert.equal(readFileSync(file, 'utf8'), source, 'planning never writes the private row file');
});
