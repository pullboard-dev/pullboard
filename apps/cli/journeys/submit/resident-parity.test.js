/** @pullboard-test-input apps/cli/src/io/commands/submit.js apps/cli/src/io/submit/preflight.js apps/cli/src/io/resident/client.js apps/cli/src/io/resident/calls.js */
/**
 * A submit with submit.residentChecks on, and a resident process running, runs the commit hooks (the configured static
 * check) and leaves the same marks on the item as the same submit with the setting off [C7,#10697,#10937].
 */
import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { mkdirSync } from 'node:fs';
import { readFileSync } from 'node:fs';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import { createE2eHelpers } from '../../tests/fixtures/e2e.js';
import { startFixtureResident } from '../../tests/fixtures/resident.js';
import { stopFixtureResidents } from '../../tests/fixtures/resident.js';
import { withBoardFile } from '../../tests/fixtures/submit/handoff.js';
import { jobsOf } from '../../../../packages/jobs/index.js';
import { fixtureAdd } from '../../tests/fixtures/testkit.js';
import { fixtureMachineSettings } from '../../../../packages/gate/tests/fixtures/testkit.js';
import { fixtureProjectPolicy } from '../../../../packages/gate/tests/fixtures/testkit.js';

/** What differs between two submits of identical work and is not a mark: ids, hashes, counts and timings. */
function marks(text) {
  return text.replace(/\b[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b/gu, '<uuid>').replace(/\b[0-9a-f]{7,64}\b/gu, '<sha>').replace(/(job gate:\d+:<sha>:)\w+/gu, '$1<job>').replace(/\d+(?:\.\d+)?/gu, 'N').split('\n').map(line => line.trimEnd())
    .filter(line => line && !/\bactivity\b|lane updates|\bshouts\b|^receipt |^check digest|^ {2}(?:commit|Node|exit) | (?:renew|check-baseline)$/u.test(line)).sort().join('\n'); // the order of a background renew is timing, not a mark
}

/** Run the item twice through the real submit, with submit.residentChecks off and then on with a resident process running; what each printed and the gate job rows each left. */
async function parityRun(t) {
  const helpers = createE2eHelpers();
  const box = helpers.project('true');
  const saved = { home: process.env.PULLBOARD_MACHINE_HOME, resident: process.env.PULLBOARD_RESIDENT };
  t.after(() => {
    try { stopFixtureResidents(box.repo); } finally {
      for (const [name, value] of [['PULLBOARD_MACHINE_HOME', saved.home], ['PULLBOARD_RESIDENT', saved.resident]]) { if (value === undefined) delete process.env[name]; else process.env[name] = value; }
      helpers.cleanup();
    }
  });
  // The project runs Pullboard's own static check as its commit hook, so submit asks the preflight, which the resident process can answer.
  const config = JSON.parse(readFileSync(join(box.repo, 'pullboard.json'), 'utf8'));
  const lanes = { ...config.lanes, web: { ...config.lanes.web, owns: ['web/', 'packages/'] } };
  fixtureProjectPolicy(box.repo, { config: { ...config, lanes, staticChecks: 'node apps/cli/src/io/static/checks.js' } });
  box.git(box.repo, 'add', '-A');
  box.git(box.repo, 'commit', '-q', '-m', 'chore: run the static check as the commit hook');
  box.git(box.web, 'merge', '-q', '--ff-only', 'main');
  process.env.PULLBOARD_MACHINE_HOME = box.env.PULLBOARD_MACHINE_HOME;
  process.env.PULLBOARD_RESIDENT = '1';
  const json = async (pending) => { const result = await pending; assert.equal(result.code, 0, result.out + result.err); return result; };

  /** Submit one item twice, a change the commit hooks refuse and then a clean one, with the setting on or off; what each submit printed and what show lists afterwards. */
  async function submitItem(id, residentChecks) {
    fixtureMachineSettings(box.env.PULLBOARD_MACHINE_HOME, { submit: { residentChecks } });
    await json(fixtureAdd(box.runLocal, box.repo, 'web', 'Build the page', '--criterion', 'the page is built', '--check', `test -f packages/x/src/page-${id}.js`, '--json'));
    box.git(box.web, 'reset', '-q', '--hard', 'main'); // each item starts from main, never stacked on the one before
    await json(box.runLocal(box.web, 'claim', String(id), '--json'));
    mkdirSync(join(box.web, 'packages/x/src'), { recursive: true });
    const file = join(box.web, `packages/x/src/page-${id}.js`);
    const submit = async (source) => {
      writeFileSync(file, source);
      box.git(box.web, 'add', '-A');
      box.git(box.web, 'commit', '-q', '-m', 'feat(web): build the page [G1]');
      const result = await box.runLocal(box.web, 'submit', String(id), '--no-next');
      return { code: result.code, printed: marks(result.out + result.err) };
    };
    const refused = await submit('export function a() { try { b(); } catch {}\n}\n');
    const clean = await submit('export const a = 1;\n');
    const shown = await json(box.runLocal(box.web, 'show', String(id)));
    // The gate job rows the real submit wrote for this item, read from the board file; their steps carry the request (files, checks, proof list).
    const rows = withBoardFile({ boardFile: join(box.repo, '.git/pullboard/board.sqlite') }, db => jobsOf(db, { kind: 'gate', item: id }));
    return { refused, clean, shown: marks(shown.out), rows };
  }

  const off = await submitItem(1, false);
  const place = await startFixtureResident(box, { ...process.env });
  assert.ok(existsSync(place.pid), 'a resident process is running for the on submit');
  const on = await submitItem(2, true);
  return { off, on };
}

test('cli.journeys-submit-resident-parity.a-submit-with-submit-residentchecks-on-runs: clause 1: a submit with submit.residentChecks on and a resident process running runs the commit hooks and leaves the same marks on the item as the same submit with it off [C7,#10697,#10937]', { timeout: 420_000 }, async (t) => {
  const { off, on } = await parityRun(t);
  for (const [label, run] of [['off', off], ['on', on]]) {
    assert.notEqual(run.refused.code, 0, `the ${label} submit is refused by the commit hooks`);
    assert.match(run.refused.printed, /empty-catch/u, `the ${label} submit names the hook that refused it`);
    assert.equal(run.clean.code, 0, `the ${label} submit of the clean change is accepted: ${run.clean.printed}`);
  }
  assert.equal(on.refused.code, off.refused.code, 'the refusal exits the same');
  assert.equal(on.refused.printed, off.refused.printed, 'the refusal prints the same hook lines');
  assert.equal(on.clean.printed, off.clean.printed, 'the accepted submit prints the same lines');
  assert.equal(on.shown, off.shown, 'the item shows the same marks');
});

test('cli.journeys-submit-resident-parity.the-queued-gate-job-matches-with-residentchecks-on: clause 2: the gate job queued by the submit with submit.residentChecks on and a resident process running has the same files, checks and proof list as the one queued with it off [C7,#10697,#10938]', { timeout: 420_000 }, async (t) => {
  const { off, on } = await parityRun(t);
  /** What each gate job row asked a runner to prove: the request its offer carried, one field per line, with ids, hashes, counts and timestamps masked; the runner's own receipts and timings are not part of the ask. */
  const queued = rows => marks(JSON.stringify(rows.map(row => row.steps.find(step => step.payload?.request)?.payload.request), null, 1));
  assert.equal(off.rows.length, 1, 'the off submit queued one gate job row');
  assert.equal(on.rows.length, 1, 'the on submit queued one gate job row');
  assert.match(JSON.stringify(on.rows[0].steps), /packages\/x\/src\/page-/u, "the on row carries the item's frozen check");
  assert.equal(queued(on.rows), queued(off.rows), 'the gate job rows match in files, checks and proof list');
});
