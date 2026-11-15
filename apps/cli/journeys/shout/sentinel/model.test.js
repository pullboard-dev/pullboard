/** The sentinel's own shouts record the seat that ran them, and its detached timers end even under a frozen clock [C7,I13]. */
import assert from 'node:assert/strict';
import { mkdirSync } from 'node:fs';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { test } from 'node:test';
import * as store from '../../../../../packages/store/index.js';
import { handoffQueueDirectory } from '../../../../../packages/resources/index.js';
import { runFixtureChild } from '../../../tests/fixtures/child.js';
import { FIXTURE_MODEL } from '../../../tests/fixtures/testkit.js';
import { cli } from '../../../tests/fixtures/next/take.js';
import { fixture } from '../../../tests/fixtures/next/take.js';

/** Every shout the sentinel posted, with its recorded detail. */
function sentinelShouts(box) {
  return store.events(box.board).filter(event => event.event_by === 'sentinel' && event.event_kind === 'shout')
    .map(event => JSON.parse(event.event_detail));
}

test('clause 1: a sentinel shout from waits record declares the model of the seat that ran it [I13,C7]', async t => {
  const box = await fixture(t);
  const joined = await cli(box, box.root, ['join', 'coordinator', '--model', FIXTURE_MODEL]);
  assert.equal(joined.code, 0, joined.out + joined.err);
  // A reservation held by a gone submitter is reclaimed at once, and a reclaim is what the audit shouts about.
  mkdirSync(handoffQueueDirectory(), { recursive: true });
  writeFileSync(join(handoffQueueDirectory(), '000000000002-job-b.reserved'), JSON.stringify({ pid: 4194301, started: 'x' }));
  const recorded = await cli(box, box.root, ['waits', 'record']);
  assert.equal(recorded.code, 0, recorded.out + recorded.err);
  const shouts = sentinelShouts(box);
  assert.equal(shouts.length, 1, 'the audit recorded exactly one sentinel shout');
  assert.equal(shouts[0].model, FIXTURE_MODEL);
});

test('clause 1: a sentinel notice from claim maintenance declares the model of the seat that ran it [I13,C7]', async t => {
  const box = await fixture(t);
  const joined = await cli(box, box.root, ['join', 'coordinator', '--model', FIXTURE_MODEL]);
  assert.equal(joined.code, 0, joined.out + joined.err);
  const id = box.add('Idle claim');
  box.claim(id);
  box.advance(30 * 60_000);
  const swept = await cli(box, box.root, ['sentinel', 'run']);
  assert.equal(swept.code, 0, swept.out + swept.err);
  const shouts = sentinelShouts(box);
  assert.ok(shouts.length > 0, 'the sweep told the idle holder');
  for (const detail of shouts) assert.equal(detail.model, FIXTURE_MODEL, JSON.stringify(detail));
});

test('clause 2: a detached wake timer ends under an inherited frozen clock instead of waiting forever [C7]', async t => {
  const box = await fixture(t);
  const frozen = `data:text/javascript,${encodeURIComponent('const fixed = Date.parse("2026-10-06T12:00:00.000Z"); const Native = Date; globalThis.Date = class extends Native { constructor(...args) { super(...(args.length ? args : [fixed])); } static now() { return fixed; } };')}`;
  const scheduler = pathToFileURL(join(import.meta.dirname, '../../../../../packages/gate/src/io/main/audit/scheduler.js')).href;
  const source = `import { waitMainAudit } from ${JSON.stringify(scheduler)};
const outcome = await waitMainAudit(process.argv[1], 'no-such-token', new Date(Date.now() + 1000).toISOString());
console.log('ENDED ' + outcome);`;
  // Stays a process: it freezes Date through a node --import loader, which only a fresh process can take.
  const run = runFixtureChild(process.execPath, ['--input-type=module', '--import', frozen, '-e', source, box.root],
    { cwd: box.root, env: { ...process.env }, encoding: 'utf8', timeout: 20_000 });
  assert.equal(run.status, 0, `${run.failure ?? run.stderr}\n${run.stdout}`);
  assert.match(run.stdout, /ENDED false/u, 'the timer slept its second once and returned');
});
