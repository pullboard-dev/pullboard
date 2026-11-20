/** The frozen check outcome travels with accepts without changing the board schema [V19,V8]. */
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { writeFileSync } from 'node:fs';
import { test } from 'node:test';
import { sandbox } from '../../tests/fixtures/verdict-check.js';
import { project } from '../../tests/fixtures/verdict-check.js';
import { succeeds } from '../../tests/fixtures/verdict-check.js';
import { submitted } from '../../tests/fixtures/verdict-check.js';
import { submitSettled } from '../../tests/fixtures/verdict-check.js';
import { clean } from '../../tests/fixtures/verdict-check.js';
import { legacyAccept } from '../../tests/fixtures/verdict-check.js';

test('cli.journeys-verify-check.accept-says-when-no-frozen-check: accept says when no frozen check ran and records none in its event and JSON [V19,V8]', async () => {
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
  } finally { clean(box); }
});

test('cli.journeys-verify-check.rework-keeps-historical-rejection-unknown-and: rework keeps historical rejection unknown and shows the latest accept check [V19,V8]', async () => {
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
    await submitSettled(box, repo, web, item.id);
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

test('cli.journeys-verify-check.historical-accepts-read-unknown-in-show: historical accepts read unknown in show and unchecked accepts are marked in ledger [V19,V8]', async () => {
  const box = sandbox();
  try {
    const { repo, web } = await project(box);
    const historical = await submitted(box, repo, web, 'Historical accept');
    const common = box.git(repo, 'rev-parse', '--path-format=absolute', '--git-common-dir');
    legacyAccept(join(common, 'pullboard', 'board.sqlite'), historical);
    const shown = await succeeds(box, repo, 'show', String(historical.id));
    assert.match(shown, /check: unknown/);
    box.git(repo, 'switch', 'main');
    const unchecked = await submitted(box, repo, web, 'Unchecked ledger row');
    await succeeds(box, repo, 'verify', String(unchecked.id), 'accept', '--as', 'coordinator', '--note', 'fixture accept without a frozen check');
    assert.match(await succeeds(box, repo, 'ledger'), new RegExp(`\\| ${unchecked.id} \\|[^\\n]*\\| unchecked \\|`));
  } finally { clean(box); }
});
