/** The frozen check outcome travels with accepts without changing the board schema [V19,V8]. */
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { readFileSync } from 'node:fs';
import { writeFileSync } from 'node:fs';
import { test } from 'node:test';
import * as store from "../../../../packages/store/src/io/board.js";
import { openCellBoard as openBoard } from "../../../../packages/store/tests/fixtures/cell.js";
import { runFixtureChild } from '../../tests/fixtures/child.js';
import { safeFixtureDiagnostic } from '../../tests/fixtures/child.js';
import { fixtureAdd } from '../../tests/fixtures/testkit.js';
import { createE2eHelpers } from '../../tests/fixtures/e2e.js';
import { FIXTURE_MODEL } from '../../tests/fixtures/e2e.js';
import { sandbox } from '../../tests/fixtures/verdict-check.js';
import { project } from '../../tests/fixtures/verdict-check.js';
import { succeeds } from '../../tests/fixtures/verdict-check.js';
import { submitted } from '../../tests/fixtures/verdict-check.js';
import { clean } from '../../tests/fixtures/verdict-check.js';

test('accept records none or green in its event and JSON, and says when unchecked [V19,V8]', async () => {
  const box = sandbox();
  try {
    const { repo, web } = await project(box);
    const unchecked = await submitted(box, repo, web, 'Unchecked accept');
    const noCheck = await succeeds(box, repo, 'verify', String(unchecked.id), 'accept', '--as', 'coordinator', '--note', 'checked the submitted work');
    assert.match(noCheck, /no frozen check ran/);
    const uncheckedEvent = JSON.parse(await succeeds(box, repo, 'log', String(unchecked.id), '--json')).events.find((event) => event.event_kind === 'accept');
    assert.equal(JSON.parse(uncheckedEvent.event_detail).check, 'none');
    const uncheckedShow = JSON.parse(await succeeds(box, repo, 'show', String(unchecked.id), '--json'));
    assert.equal(uncheckedShow.verdicts.at(-1).check, 'none');
    assert.match(await succeeds(box, repo, 'show', String(unchecked.id)), /check: none/);
    box.git(repo, 'switch', 'main');

    const uncheckedJson = JSON.parse(await succeeds(box, repo, 'verify', String((await submitted(box, repo, web, 'Unchecked JSON accept')).id), 'accept', '--as', 'coordinator', '--note', 'checked the submitted work', '--json'));
    assert.equal(uncheckedJson.check, 'none');
    box.git(repo, 'switch', 'main');

    const checked = await submitted(box, repo, web, 'Checked accept', 'node --check web/item-3.js');
    await succeeds(box, repo, 'check', String(checked.id), '--yes'); // Diagnostics must not block an existing frozen check while main is detached for review.
    const checkedSource = join(repo, 'web', `item-${checked.id}.js`);
    const originalSource = readFileSync(checkedSource, 'utf8');
    writeFileSync(checkedSource, 'const = ;\n'); // Keep the negative compiler case unambiguous; Node22 can silently accept invalid detected-ESM .js (#65202).
    // Process-level by nature: this is the Node compiler itself, not the CLI, so no in-process form exists.
    const reference = runFixtureChild(process.execPath, ['--check', checkedSource], { cwd: repo, env: box.env, encoding: 'utf8' });
    assert.equal(reference.status, 1, safeFixtureDiagnostic(JSON.stringify({ phase: 'direct compiler reference', status: reference.status,
      stdout: reference.stdout, stderr: reference.stderr, source: readFileSync(checkedSource, 'utf8'), inheritedTestContext: Boolean(box.env.NODE_TEST_CONTEXT) }), box.env));
    // Process-level by nature: the failure-diagnostics notice comes from a child the check starts, which in-process dispatch does not reproduce.
    const redCheck = box.spawn(repo, 'check', String(checked.id), '--yes', '--json');
    assert.equal(redCheck.code, 1, safeFixtureDiagnostic(JSON.stringify({ phase: 'real check after direct compiler red', redCheck, source: readFileSync(checkedSource, 'utf8') }), box.env));
    assert.equal(JSON.parse(redCheck.out).green, false);
    assert.match(redCheck.err, /failure diagnostics could not finish \(NO_POLICY\).*original result stays red/u);
    writeFileSync(checkedSource, originalSource);
    const checkedJson = JSON.parse(await succeeds(box, repo, 'verify', String(checked.id), 'accept', '--as', 'coordinator', '--note', 'the frozen check passed', '--json'));
    assert.equal(checkedJson.check, 'green');
    const checkedEvent = JSON.parse(await succeeds(box, repo, 'log', String(checked.id), '--json')).events.find((event) => event.event_kind === 'accept');
    assert.equal(JSON.parse(checkedEvent.event_detail).check, 'green');
    const checkedShow = JSON.parse(await succeeds(box, repo, 'show', String(checked.id), '--json'));
    assert.equal(checkedShow.verdicts.at(-1).check, 'green');
    assert.match(await succeeds(box, repo, 'show', String(checked.id)), /check: green/);
  } finally { clean(box); }
});

test('rework keeps historical rejection unknown and shows the latest accept check [V19,V8]', async () => {
  const box = sandbox();
  try {
    const { repo, web } = await project(box);
    const item = await submitted(box, repo, web, 'Reworked accept');
    await succeeds(box, repo, 'verify', String(item.id), 'reject', '--as', 'coordinator', '--reason', 'BEHAVIOR_MISMATCH', '--clause', 'The fixture item is complete.', '--note', 'the first version missed an edge');
    box.git(repo, 'switch', 'main');
    await succeeds(box, web, 'claim', String(item.id));
    writeFileSync(join(web, 'web', `item-${item.id}.js`), 'export const complete = true; // revised\n');
    box.git(web, 'add', '-A');
    box.git(web, 'commit', '-q', '-m', `fix(web): correct fixture ${item.id} [G1]`);
    await succeeds(box, web, 'submit', String(item.id), '--wait');
    box.git(repo, 'switch', '--detach', 'web/one');
    const accepted = await succeeds(box, repo, 'verify', String(item.id), 'accept', '--as', 'coordinator', '--note', 'the rework fixed the missed edge');
    assert.match(accepted, /no frozen check ran/);
    const shownJson = JSON.parse(await succeeds(box, repo, 'show', String(item.id), '--json'));
    assert.deepEqual(shownJson.verdicts.map((verdict) => verdict.check), ['unknown', 'none']);
    const shown = (await succeeds(box, repo, 'show', String(item.id))).split('\n');
    const rejectLine = shown.findIndex((line) => line.startsWith('REJECT BEHAVIOR_MISMATCH'));
    const acceptLine = shown.findIndex((line) => line.startsWith('ACCEPT CRITERION_MET'));
    assert.ok(rejectLine >= 0 && acceptLine > rejectLine);
    assert.equal(shown[rejectLine + 1], '  check: unknown');
    assert.equal(shown[acceptLine + 1], '  check: none');
    const rows = (await succeeds(box, repo, 'ledger')).split('\n').filter((line) => line.startsWith(`| ${item.id} |`));
    assert.equal(rows.length, 1);
    assert.match(rows[0], /\| unchecked \|/);
    assert.equal(rows[0].split('|')[7].trim(), 'unchecked', 'the check column describes the latest accept');
  } finally { clean(box); }
});

test('historical accepts read unknown in show and unchecked accepts are marked in ledger [V19,V8]', async () => {
  const box = sandbox();
  try {
    const { repo, web } = await project(box);
    const historical = await submitted(box, repo, web, 'Historical accept');
    const common = box.git(repo, 'rev-parse', '--path-format=absolute', '--git-common-dir');
    // @pullboard-board-file journey: read verdicts from the board file the real CLI wrote
    const board = openBoard(join(common, 'pullboard', 'board.sqlite'));
    try {
      const item = store.getItem(board, historical.id);
      store.verify(board, historical.id, {
        agentId: 'coordinator', decision: 'ACCEPT', reason: 'CRITERION_MET', note: 'legacy event fixture',
        head: historical.commit, digest: item.item_frozen_digest, policy: 'any', familyPolicy: 'off',
      });
    } finally { store.closeBoard(board); }
    const shown = await succeeds(box, repo, 'show', String(historical.id));
    assert.match(shown, /check: unknown/);
    box.git(repo, 'switch', 'main');
    const unchecked = await submitted(box, repo, web, 'Unchecked ledger row');
    await succeeds(box, repo, 'verify', String(unchecked.id), 'accept', '--as', 'coordinator', '--note', 'fixture accept without a frozen check');
    assert.match(await succeeds(box, repo, 'ledger'), new RegExp(`\\| ${unchecked.id} \\|[^\\n]*\\| unchecked \\|`));
  } finally { clean(box); }
});

for (const on of [false, true]) test(`review.excludeEarlierHolders ${on ? 'on refuses' : 'off allows'} a seat that claimed then released the item to reserve its review [V1,B3]`, async t => {
  const helpers = createE2eHelpers();
  t.after(helpers.cleanup);
  const box = helpers.project('true');
  const ok = result => { assert.equal(result.code, 0, result.err || result.out); return JSON.parse(result.out); };
  const early = join(box.dir, 'early-seat');
  box.git(box.repo, 'worktree', 'add', '-q', '--detach', early, 'main');
  ok(await box.inProcess(early, 'join', 'web', '--model', FIXTURE_MODEL, '--route', 'strong', '--json'));
  ok(await fixtureAdd(box.inProcess, box.repo, 'web', 'Held before', '--criterion', 'the feature builds', '--specs', 'G1', '--check', 'true', '--json'));
  ok(await box.inProcess(early, 'claim', '1', '--json'));
  ok(await box.inProcess(early, 'release', '1', '--reason', 'OTHER', '--note', 'dropped before building', '--json'));
  ok(await box.inProcess(box.web, 'claim', '1', '--json'));
  assert.equal(helpers.commitFile(box, box.web, 'web/feature.js', 'built\n', 'feat(web): build feature [G1]').status, 0);
  ok(await box.inProcess(box.web, 'submit', '1', '--json'));
  if (on) {
    const file = join(early, 'pullboard.json');
    writeFileSync(file, JSON.stringify({ ...JSON.parse(readFileSync(file, 'utf8')), review: { excludeEarlierHolders: true } }, null, 2) + '\n');
    box.git(early, '-c', 'core.hooksPath=/dev/null', '-c', 'user.name=fixture', '-c', 'user.email=fixture@example.test', 'commit', '-qam', 'chore: exclude earlier holders from review');
  }
  const reserve = await box.inProcess(early, 'next', '--verify', '1', '--json');
  if (on) {
    assert.equal(reserve.code, 1, reserve.out + reserve.err);
    assert.equal(JSON.parse(reserve.out).error.code, 'REVIEW_EARLIER_HOLDER');
    assert.match(JSON.parse(reserve.out).error.message, /review\.excludeEarlierHolders/u);
  } else assert.equal(reserve.code, 0, `off: only the builder is excluded\n${reserve.out}${reserve.err}`);
});

