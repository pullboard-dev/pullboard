/** @pullboard-test-input source-tree */
/** Outside-source intake/guards use real Git/SQLite and declared transport stand-ins [V1,V2,V3,B26]. */
import assert from 'node:assert/strict';
import { test } from 'node:test';
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

test('an intaken pull request is verified only in the sandbox [V1,V2,V3,B26]', t => {
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
  refusal(box.run(box.web, 'verify', id, 'accept', '--note', 'unsafe host path', '--json'), 'OUTSIDE_SANDBOX_REQUIRED');
  refusal(box.run(box.web, 'verify', id, 'accept', '--sandbox', '--note', 'missing provider', '--json'), 'SANDBOX_PROVIDER_REQUIRED');

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
  refusal(box.run(box.repo, 'land', '--json'), 'OUTSIDE_OWNER_APPROVAL');
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

test('a returned outside pull request cannot be claimed as native build work [V1,V3]', t => {
  const box = intakeFixture(t);
  const filed = fixtureJSON(box, box.repo, 'intake', box.pull.html_url, '--criterion', 'the fixture behavior works', '--check', 'node --test test/contribution.test.js');
  const id = String(filed.item.item_id);
  fixtureJSON(box, box.repo, 'reopen', id, '--note', 'outside author must revise its pull request');
  refusal(box.run(box.web, 'claim', id, '--json'), 'OUTSIDE_NATIVE_BUILD');
  const item = fixtureJSON(box, box.repo, 'show', id);
  assert.equal(item.item_status, 'open');
  assert.equal(item.item_built_by, 'outside:github:outside-contributor');
});

test('an outside author revision is re-intaken only after normal return and clears exact-commit approval [V1,V3,B26]', t => {
  const box = intakeFixture(t);
  const filed = fixtureJSON(box, box.repo, 'intake', box.pull.html_url, '--criterion', 'the fixture behavior works', '--check', 'node --test test/contribution.test.js');
  const id = String(filed.item.item_id);
  fixtureJSON(box, box.repo, 'intake', 'approve', id);
  const next = advanceOutsideFixture(box, 'apps/relay/src/io/deploy/outside.js', 'export const outside = "revised owned fixture";\n');
  refusal(box.run(box.repo, 'intake', box.pull.html_url, '--criterion', 'the fixture behavior works', '--check', 'node --test test/contribution.test.js', '--json'), 'OUTSIDE_HEAD_CHANGED');
  assert.equal(fixtureJSON(box, box.repo, 'show', id).item_commit, box.commit, 'source refresh cannot replace an active submission');
  fixtureJSON(box, box.repo, 'reopen', id, '--note', 'outside author supplied a new exact head');
  const refreshed = fixtureJSON(box, box.repo, 'intake', box.pull.html_url, '--criterion', 'the fixture behavior works', '--check', 'node --test test/contribution.test.js');
  assert.equal(refreshed.item.item_id, Number(id));
  assert.equal(refreshed.item.item_status, 'submitted');
  assert.equal(refreshed.item.item_commit, next.commit);
  assert.equal(refreshed.item.item_tree, next.tree);
  assert.equal(refreshed.item.outside.ownerApproval, null, 'the old owner approval never authorizes the new source commit');
  assert.equal(refreshed.item.outside.sandbox, null, 'the new outside head must be executed in the sandbox again');
});


test('outside process-execution detection and unreadable files explain their owner holds [B26,V3]', t => {
  const box = intakeFixture(t);
  advanceOutsideFixture(box, 'lib/plain.js', "import { execFile } from 'node:child_process'; export const run = () => execFile('true');\n", ['apps/relay/src/io/deploy/outside.js']);
  advanceOutsideFixture(box, 'assets/opaque.bin', Buffer.from([0, 255, 254]));
  const filed = fixtureJSON(box, box.repo, 'intake', box.pull.html_url, '--criterion', 'the fixture behavior works', '--check', 'node --test test/contribution.test.js');
  const reasons = filed.item.outside.sensitivity;
  assert.ok(reasons.some(reason => reason.path === 'lib/plain.js' && reason.rule === 'new-process-execution'));
  assert.ok(reasons.some(reason => reason.path === 'assets/opaque.bin' && reason.rule === 'unreadable-changed-file'));
});

test('only trusted main can extend outside sensitive paths and ordinary source stays ordinary [B26,V4]', t => {
  const box = intakeFixture(t);
  const configPath = new URL('pullboard.json', 'file://' + box.repo + '/');
  const config = JSON.parse(readFileSync(configPath, 'utf8'));
  config.intake = { sensitivePaths: ['data/regulated.json'] };
  writeFileSync(configPath, JSON.stringify(config));
  box.git(box.repo, 'add', 'pullboard.json');
  box.git(box.repo, 'commit', '-q', '-m', 'chore: declare private sensitive data');
  advanceOutsideFixture(box, 'data/regulated.json', '{"fixture":true}\n', ['apps/relay/src/io/deploy/outside.js']);
  advanceOutsideFixture(box, 'lib/ordinary.js', 'export const add = (left, right) => left + right;\n');
  const filed = fixtureJSON(box, box.repo, 'intake', box.pull.html_url, '--criterion', 'the fixture behavior works', '--check', 'node --test test/contribution.test.js');
  assert.ok(filed.item.outside.sensitivity.some(reason => reason.path === 'data/regulated.json' && reason.rule === 'configured-sensitive-path'));
  assert.equal(filed.item.outside.sensitivity.some(reason => reason.path === 'lib/ordinary.js'), false, 'source files are not all sensitive just for being source');
});


test('renaming an existing sealing boundary cannot hide its touched old path [B26,V3]', t => {
  const content = 'export const sealFixture = value => value;\n';
  const box = intakeFixture(t, { baseFiles: { 'packages/kernel/src/logic/seal.js': content } });
  advanceOutsideFixture(box, 'lib/moved-boundary.js', content, ['packages/kernel/src/logic/seal.js', 'apps/relay/src/io/deploy/outside.js']);
  const facts = JSON.parse(readFileSync(box.facts, 'utf8'));
  facts.files = facts.files.filter(file => file.filename !== 'lib/moved-boundary.js');
  facts.files.push({ filename: 'lib/moved-boundary.js', previous_filename: 'packages/kernel/src/logic/seal.js', status: 'renamed' });
  writeFileSync(box.facts, JSON.stringify(facts));
  const filed = fixtureJSON(box, box.repo, 'intake', box.pull.html_url, '--criterion', 'the fixture behavior works', '--check', 'node --test test/contribution.test.js');
  assert.ok(filed.item.outside.sensitivity.some(reason => reason.path === 'packages/kernel/src/logic/seal.js' && reason.rule === 'declared-sensitive-path'), 'the exact old trust-boundary path remains part of the owner decision after a GitHub rename');
});


test('trusted pinned browser images use the sandbox protocol without changing actual Node roles [V3,C7]', t => {
  const box = intakeFixture(t);
  const filed = fixtureJSON(box, box.repo, 'intake', box.pull.html_url, '--criterion', 'the fixture behavior works', '--check', 'node --test test/contribution.test.js');
  const id = String(filed.item.item_id);
  // A transport double models the custom image reference; this case is not real Chrome/container execution.
  const images = { minimum: 'ghcr.io/fixture/node-chrome-min@sha256:' + '3'.repeat(64), current: 'ghcr.io/fixture/node-chrome-current@sha256:' + '4'.repeat(64) };
  configureFixtureSandbox(box, { images });
  assert.equal(fixtureJSON(box, box.web, 'verify', id, 'accept', '--sandbox', '--note', 'trusted browser image protocol').decision, 'ACCEPT');
  const runs = fixtureJSON(box, box.repo, 'show', id).outside.sandbox.runs;
  assert.deepEqual(runs.map(run => run.image), [images.minimum, images.current]);
  assert.deepEqual(runs.map(run => run.environment.node), ['22.13.1', '24.21.0']);
});
