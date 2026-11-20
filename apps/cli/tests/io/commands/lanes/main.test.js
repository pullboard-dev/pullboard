/** Drives the real CLI (hooks, claim, submit, refreeze) over lane policies and checks lane ownership, refusals and exit codes end to end [L1,L2,L3]. */
import assert from 'node:assert/strict';
import { mkdirSync } from 'node:fs';
import { readFileSync } from 'node:fs';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import { createE2eHelpers } from '../../../fixtures/e2e.js';
import { crossLaneFixture } from '../../../fixtures/e2e.js';
import { runFixtureChild } from '../../../fixtures/child.js';
import { specGateMoveOnly } from '../../../../../../packages/spec/index.js';
import { submissionPaths } from '../../../../../../packages/sandbox/index.js';

test('cli.journeys-lanes-main.a-lane-commits-only-exact-gate: a lane commits only exact gate paths for its staged test rename [L3,B34]', async t => {
  const helpers = createE2eHelpers();
  t.after(helpers.cleanup);
  const box = helpers.project('true');
  mkdirSync(join(box.repo, 'web'), { recursive: true });
  writeFileSync(join(box.repo, 'web/old.test.js'), 'export const fixture = true;\n');
  writeFileSync(join(box.repo, 'web/kept.test.js'), 'export const kept = true;\n');
  const spec = readFileSync(join(box.repo, 'SPEC.md'), 'utf8').replace('gate: web test', 'gate: node web/old.test.js,  web/kept.test.js');
  writeFileSync(join(box.repo, 'SPEC.md'), spec);
  box.git(box.repo, 'add', '-A');
  box.git(box.repo, 'commit', '-q', '-m', 'test: seed renamed gate fixture');
  box.git(box.web, 'merge', '--ff-only', 'main');
  const moved = spec.replace('web/old.test.js', 'web/new.test.js');
  writeFileSync(join(box.web, 'SPEC.md'), moved);
  box.git(box.web, 'add', 'SPEC.md');
  assert.equal(specGateMoveOnly(box.web, 'SPEC.md'), false, 'a gate edit without an actual staged rename stays foreign');
  box.git(box.web, 'mv', 'web/old.test.js', 'web/new.test.js');
  assert.equal(specGateMoveOnly(box.web, 'SPEC.md'), true);
  // A valid gate change never authorizes extra wording, headers, status, IDs or unrelated gates.
  for (const changed of [moved.replace('The page renders.', 'Different rule.'), moved + '\nextra prose\n', moved + '\n', moved + ' ',
    moved.replace('approved, must', 'draft, must'), moved.replace('- G1 ', '- G3 '),
    moved.replace('gate: api test', 'gate: true')]) {
    writeFileSync(join(box.web, 'SPEC.md'), changed);
    box.git(box.web, 'add', 'SPEC.md');
    assert.equal(specGateMoveOnly(box.web, 'SPEC.md'), false);
    const refused = await box.runLocal(box.web, 'hook', 'pre-commit');
    assert.equal(refused.code, 1, refused.out + refused.err);
    assert.match(refused.out + refused.err, /outside the web lane: SPEC\.md/u);
  }
  writeFileSync(join(box.web, 'SPEC.md'), moved);
  box.git(box.web, 'add', 'SPEC.md');
  // Process-level case: a real git commit runs the installed pre-commit hook as its own process.
  const committed = runFixtureChild('git', ['commit', '-q', '-m', 'test: move exact gate fixture'],
    { cwd: box.web, env: box.env, encoding: 'utf8' });
  assert.equal(committed.status, 0, committed.stdout + committed.stderr);
  assert.equal(specGateMoveOnly(box.web, 'SPEC.md', 'HEAD^', 'HEAD'), true);
  const base = box.git(box.web, 'rev-parse', 'HEAD^');
  const commit = box.git(box.web, 'rev-parse', 'HEAD');
  assert.ok(submissionPaths(box.web, { item_lane: 'web', item_claim_head: base,
    item_frozen: JSON.stringify({ policy: { commit: base } }) }, commit, { mainCommit: base }).includes('SPEC.md'),
  'the exact committed gate move also passes native submission ownership');
});

test('cli.journeys-lanes-main.wrong-lane-names-a-clean-native: WRONG_LANE names a clean native lane checkout and the claim there retains its lane hook [L2,B13,N2]', async t => {
  const box = crossLaneFixture(t);
  const web = box.seat('claim-web', 'web', box.session);
  const api = box.seat('claim api', 'api', box.session);
  const id = box.add('api', 'Build only in the API lane');
  const wrong = await box.runAsLocal(box.session, web.root, 'claim', String(id), '--json');
  assert.equal(wrong.code, 1);
  const refusal = JSON.parse(wrong.out).error;
  assert.equal(refusal.code, 'WRONG_LANE');
  assert.equal(refusal.next, `cd '${api.root}' && pullboard claim ${id}`);
  assert.equal(box.json(await box.runLocal(box.repo, 'show', String(id), '--json')).item_status, 'open');
  box.json(await box.runAsLocal(box.session, api.root, 'claim', String(id), '--json'));
  mkdirSync(join(api.root, 'api'), { recursive: true });
  writeFileSync(join(api.root, 'api/proof.js'), 'export const proof = true;\n');
  box.git(api.root, 'add', 'api/proof.js');
  const allowed = await box.runAsLocal(box.session, api.root, 'hook', 'pre-commit', '--json');
  assert.equal(allowed.code, 0, allowed.out + allowed.err);
  mkdirSync(join(api.root, 'web'), { recursive: true });
  writeFileSync(join(api.root, 'web/forbidden.js'), 'export const forbidden = true;\n');
  box.git(api.root, 'add', 'web/forbidden.js');
  const refused = await box.runAsLocal(box.session, api.root, 'hook', 'pre-commit', '--json');
  assert.equal(refused.code, 1);
  const hookRefusal = JSON.parse(refused.out).error;
  assert.equal(hookRefusal.code, 'COMMAND_FAILED', 'the native hook returns a nonzero command result rather than throwing a board refusal');
  assert.match(hookRefusal.message, /outside the api lane: web\/forbidden\.js \(web's\); shout its owner instead/u);
});


test('cli.journeys-lanes-main.lane-hook-permits-only-an-owned: lane hook permits only an owned rename and its exact foreign import repoint [L3]', async t => {
  const helpers = createE2eHelpers();
  t.after(helpers.cleanup);
  const box = helpers.project('true');
  mkdirSync(join(box.repo, 'web'), { recursive: true });
  mkdirSync(join(box.repo, 'api'), { recursive: true });
  writeFileSync(join(box.repo, 'web/old.js'), 'export const value = 1;\n');
  const before = "import { value } from '../../../../journeys/web/old.js';\nexport const result = value;\n";
  writeFileSync(join(box.repo, 'api/view.js'), before);
  box.git(box.repo, 'add', '-A');
  box.git(box.repo, 'commit', '-q', '-m', 'test: seed import fixture');
  box.git(box.web, 'merge', '--ff-only', 'main');
  box.git(box.web, 'mv', 'web/old.js', 'web/new.js');
  const view = join(box.web, 'api/view.js');
  writeFileSync(view, before.replace('old.js', 'other.js'));
  box.git(box.web, 'add', 'api/view.js');
  assert.equal((await box.runLocal(box.web, 'hook', 'pre-commit')).code, 1, 'unrelated path refuses');
  writeFileSync(view, before.replace('old.js', 'new.js').replace('result = value', 'result = 2'));
  box.git(box.web, 'add', 'api/view.js');
  assert.equal((await box.runLocal(box.web, 'hook', 'pre-commit')).code, 1, 'logic edit refuses');
  writeFileSync(view, before.replace('old.js', 'new.js'));
  box.git(box.web, 'add', 'api/view.js');
  const accepted = await box.runLocal(box.web, 'hook', 'pre-commit');
  assert.equal(accepted.code, 0, accepted.out + accepted.err);
  const base = box.git(box.web, 'rev-parse', 'HEAD');
  box.git(box.web, 'commit', '-q', '-m', 'test: move module');
  const commit = box.git(box.web, 'rev-parse', 'HEAD');
  assert.ok(submissionPaths(box.web, { item_lane: 'web', item_claim_head: base,
    item_frozen: JSON.stringify({ policy: { commit: base } }) }, commit, { mainCommit: base }).includes('api/view.js'));
});

test('cli.journeys-lanes-main.lane-hook-accepts-a-deleted-shim: lane hook accepts a deleted shim repoint only to its exact body [L3]', async t => {
  const helpers = createE2eHelpers();
  t.after(helpers.cleanup);
  const box = helpers.project('true');
  mkdirSync(join(box.repo, 'web'), { recursive: true });
  mkdirSync(join(box.repo, 'api'), { recursive: true });
  writeFileSync(join(box.repo, 'web/body.js'), 'export const value = 1;\n');
  writeFileSync(join(box.repo, 'web/shim.js'), "export { value } from '../../../../journeys/lanes/body.js';\n");
  const before = "import { value } from '../../../../journeys/web/shim.js';\nexport const result = value;\n";
  writeFileSync(join(box.repo, 'api/view.js'), before);
  box.git(box.repo, 'add', '-A');
  box.git(box.repo, 'commit', '-q', '-m', 'test: seed shim fixture');
  box.git(box.web, 'merge', '--ff-only', 'main');
  box.git(box.web, 'rm', 'web/shim.js');
  const view = join(box.web, 'api/view.js');
  writeFileSync(view, before.replace('shim.js', 'body.js').replace('result = value', 'result = 2'));
  box.git(box.web, 'add', 'api/view.js');
  assert.equal((await box.runLocal(box.web, 'hook', 'pre-commit')).code, 1, 'additional logic edit refuses');
  writeFileSync(view, before.replace('shim.js', 'body.js'));
  box.git(box.web, 'add', 'api/view.js');
  const accepted = await box.runLocal(box.web, 'hook', 'pre-commit');
  assert.equal(accepted.code, 0, accepted.out + accepted.err);
  const base = box.git(box.web, 'rev-parse', 'HEAD');
  box.git(box.web, 'commit', '-q', '-m', 'test: remove shim');
  const commit = box.git(box.web, 'rev-parse', 'HEAD');
  assert.ok(submissionPaths(box.web, { item_lane: 'web', item_claim_head: base,
    item_frozen: JSON.stringify({ policy: { commit: base } }) }, commit, { mainCommit: base }).includes('api/view.js'));
});


test('cli.journeys-lanes-main.cross-lane-import-edits-follow-only: cross-lane import edits follow only same-item moves or removed forwarding shims [L3]', async () => {
  const { movedImportOnlyChange, movedImportTargets } = await import('../../../../../../packages/commits/src/logic/import-only-change.js');
  const diff = 'R100\0api/old.js\0api/new.js\0D\0api/shim.js\0';
  const moves = movedImportTargets(diff, path => path === 'api/shim.js' ? "export { value } from '../../../../journeys/lanes/new.js';\n" : null, path => path === 'api/new.js');
  const before = "import { value } from '../../../../journeys/api/old.js';\nexport const result = value;\n";
  const after = before.replace('../api/old.js', '../api/new.js');
  assert.equal(movedImportOnlyChange(before, after, 'web/view.js', moves), true);
  assert.equal(movedImportOnlyChange(before, after.replace('result = value', 'result = 1'), 'web/view.js', moves), false);
  assert.equal(movedImportOnlyChange(before, before.replace('../api/old.js', '../api/other.js'), 'web/view.js', moves), false);
  const shim = before.replace('../api/old.js', '../api/shim.js');
  assert.equal(movedImportOnlyChange(shim, after, 'web/view.js', moves), true);
  const input = '/** @pullboard-test-input api/old.js */\nexport const ok = true;\n';
  assert.equal(movedImportOnlyChange(input, input.replace('api/old.js', 'api/new.js'), 'web/test.js', moves), true);
  const lookalike = `const text = "@pullboard-test-input api/old.js";\n`;
  assert.equal(movedImportOnlyChange(lookalike, lookalike.replace('api/old.js', 'api/new.js'), 'web/test.js', moves), false);
});
