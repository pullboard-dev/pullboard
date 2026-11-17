/** @pullboard-test-input packages/kernel/src/logic/seal.js */
/** Outside-source intake/guards use real Git/SQLite and declared transport stand-ins [V1,V2,V3,B26]. */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { runCliInProcess } from '../../tests/fixtures/process.js';
import {
  readFileSync,
  writeFileSync,
} from 'node:fs';
import {
  advanceOutsideFixture,
  calls,
  configureFixtureSandbox,
  fixtureJSON,
  intakeFixture,
} from "../../tests/fixtures/intake.js";

/** Parse a private native refusal without treating transport stand-ins as execution evidence. */
function refusal(result, expected) {
  assert.notEqual(result.code, 0, 'the unsafe operation must refuse');
  assert.equal(JSON.parse(result.out || result.err).error.code, expected, result.out + result.err);
}

test('an intaken pull request is verified only in the sandbox [V1,V2,V3,B26]', async t => {
  const box = intakeFixture(t);
  const filed = fixtureJSON(box, box.repo, 'intake', box.pull.html_url,
    '--criterion', 'The contributed behavior works.', '--check', 'node --test test/contribution.test.js');
  const id = String(filed.item?.item_id ?? filed.id);
  let item = fixtureJSON(box, box.repo, 'show', id);
  assert.equal(item.item_status, 'submitted');
  assert.equal(item.item_commit, box.commit);
  assert.equal(item.item_tree, box.tree);
  assert.match(item.item_built_by, /outside-contributor/u);
  assert.equal(item.outside.kind, 'pull-request');
  assert.equal(item.outside.number, 7);
  assert.equal(item.outside.author, 'outside-contributor');
  assert.equal(item.outside.state, 'open');
  assert.equal(item.outside.maintainerReplied, true);
  assert.equal(item.outside.sensitive, true, 'relay code requires owner approval');
  assert.equal(box.git(box.repo, 'rev-parse', 'HEAD'), box.base, 'intake never checks out or executes the PR');
  refusal(await runCliInProcess(['verify', id, 'accept', '--note', 'unsafe host path', '--json'], { cwd: box.web, env: box.env }), 'OUTSIDE_SANDBOX_REQUIRED');
  refusal(await runCliInProcess(['verify', id, 'accept', '--sandbox', '--note', 'missing provider', '--json'], { cwd: box.web, env: box.env }), 'SANDBOX_PROVIDER_REQUIRED');

  // These simulated image versions/TAP rows prove adapter/receipt protocol only, never real containment.
  const provider = configureFixtureSandbox(box);
  const verdict = fixtureJSON(box, box.web, 'verify', id, 'accept', '--sandbox', '--note', 'private stand-in provider protocol');
  assert.equal(verdict.decision, 'ACCEPT');
  item = fixtureJSON(box, box.repo, 'show', id);
  assert.equal(item.item_status, 'verified');
  assert.equal(item.outside.sandbox.commit, box.commit);
  assert.equal(item.outside.sandbox.tree, box.tree);
  assert.deepEqual(item.outside.sandbox.runs.map(run => run.environment.node), ['22.13.1', '24.21.0']);
  assert.equal(item.outside.ownerApproval, null);
  // Landing is a runner job now: `land` only offers it, and the job's publish step refuses an unapproved outside item (publish.js publicationInputs) [C7].
  await runCliInProcess(['land', '--json'], { cwd: box.repo, env: box.env });
  assert.equal(box.git(box.repo, 'rev-parse', 'HEAD') === box.commit, false, 'sensitive PR never reaches the local trunk without its owner');
  fixtureJSON(box, box.repo, 'intake', 'approve', id);
  item = fixtureJSON(box, box.repo, 'show', id);
  assert.equal(item.outside.ownerApproval.commit, box.commit, 'person approval binds this exact outside commit');
  assert.equal(item.outside.ownerApproval.by, 'person');

  const transport = calls(provider.dockerLog);
  assert.ok(transport.some(call => call.args[0] === 'run'), 'the configured provider really receives the sandbox requests');
  for (const call of transport.filter(call => call.args[0] === 'run')) {
    assert.equal(call.args[call.args.indexOf('--network') + 1], 'none');
    assert.ok(call.args.includes('--read-only'));
    assert.ok(call.args.some(arg => arg.includes('target=/source') && arg.includes('readonly')), 'only a read-only private export is mounted as source');
    assert.equal(call.secret, null, 'no inherited host secret reaches the Docker client');
    assert.equal(call.credential, null, 'no inherited GitHub credential reaches the Docker client');
  }
  assert.equal(calls(box.ghLog).some(args => args.includes('-X') || args.includes('--method') && args[args.indexOf('--method') + 1] !== 'GET'), false, 'no outside reply is posted without a separate person action');
});


test('outside issue intake retains source state and distinguishes a maintainer reply [V2,N2]', t => {
  const box = intakeFixture(t);
  const first = fixtureJSON(box, box.repo, 'intake', 'https://github.com/fixture/project/issues/6');
  const id = String(first.item?.item_id ?? first.id);
  let item = fixtureJSON(box, box.repo, 'show', id);
  assert.equal(item.outside.kind, 'issue');
  assert.equal(item.outside.author, 'issue-author');
  assert.equal(item.outside.state, 'open');
  assert.equal(item.outside.maintainerReplied, false);
  const facts = JSON.parse(readFileSync(box.facts, 'utf8'));
  facts.issueComments = [{ user: { login: 'another-outsider' }, author_association: 'CONTRIBUTOR', body: 'Following.' }];
  writeFileSync(box.facts, JSON.stringify(facts));
  fixtureJSON(box, box.repo, 'intake', 'https://github.com/fixture/project/issues/6');
  item = fixtureJSON(box, box.repo, 'show', id);
  assert.equal(item.outside.maintainerReplied, false, 'an arbitrary comment is not a maintainer response');
  facts.issue.state = 'closed';
  facts.issueComments.push({ user: { login: 'maintainer' }, author_association: 'MEMBER', body: 'Recorded on our board.' });
  writeFileSync(box.facts, JSON.stringify(facts));
  const refreshed = fixtureJSON(box, box.repo, 'intake', 'https://github.com/fixture/project/issues/6');
  assert.equal(String(refreshed.item?.item_id ?? refreshed.id), id, 'refresh updates the existing outside-source record');
  item = fixtureJSON(box, box.repo, 'show', id);
  assert.equal(item.outside.state, 'closed');
  assert.equal(item.outside.maintainerReplied, true);
  assert.equal(item.item_status, 'open', 'GitHub closure alone does not verify or land a local board item');
});


test('the lower sealing definition still requires outside owner approval [B26,V3]', t => {
  const box = intakeFixture(t);
  const path = 'packages/kernel/src/logic/seal.js';
  advanceOutsideFixture(box, path, 'export const sealFixture = true;\n', ['apps/relay/src/io/deploy/outside.js']);
  const filed = fixtureJSON(box, box.repo, 'intake', box.pull.html_url, '--criterion', 'the fixture behavior works', '--check', 'node --test test/contribution.test.js');
  const source = fixtureJSON(box, box.repo, 'show', String(filed.item.item_id)).outside;
  assert.equal(source.sensitive, true);
  assert.ok(source.sensitivity.some(reason => reason.path === path && reason.rule === 'declared-sensitive-path'));
});

test('outside sealing and command-bearing changes require owner approval [B26,V3]', t => {
  const box = intakeFixture(t);
  // Remove the original relay path so it cannot conceal an omitted sealing classification.
  advanceOutsideFixture(box, 'packages/kernel/src/logic/seal.js', 'export const sealFixture = true;\n', ['apps/relay/src/io/deploy/outside.js']);
  const filed = fixtureJSON(box, box.repo, 'intake', box.pull.html_url, '--criterion', 'the fixture behavior works', '--check', 'node --test test/contribution.test.js');
  const id = String(filed.item.item_id);
  const source = fixtureJSON(box, box.repo, 'show', id).outside;
  assert.equal(source.sensitive, true, 'the existing sealing boundary needs owner approval even without a relay change');
  assert.ok(source.sensitivity.some(reason => reason.path === 'packages/kernel/src/logic/seal.js' && reason.rule === 'declared-sensitive-path'));
});
