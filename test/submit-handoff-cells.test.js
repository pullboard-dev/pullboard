/** A cell refusal runs after the queued submit is acknowledged and returns only its builder's item [C7,V4,H16]. */
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import { fileFixtureItem, joinFixtureSeat } from './testkit-fixture.js';
import { warmAcceptedCells } from '../packages/gate/index.js';
import { withMainCheckout } from '../packages/landing/index.js';
import { withFileLock } from '../packages/outbox/index.js';
import { document, fixture, helpersCommit, state, waitJob, workerDiagnostic } from './submit-handoff-fixture.js';

/**
 * Put one cell refusal past its trial in the fixture's own ledger, so the queued worker refuses it. Why: machinery
 * refusals start in report mode on every fresh repository (13532c41d3, #2611) under an identity bound to the rule's
 * content, so a probe queued submit from a spare worktree records that identity first and the ledger is then aged.
 */
async function enforceCellTrial(box, kind, code) {
  // A queued gate reads only a completed accepted-cells inventory and ends as infrastructure when main's is cold, so the
  // fixture's own producer run finishes it first (the real producer is a background process the fixture never starts).
  const previousHome = process.env.PULLBOARD_MACHINE_HOME;
  process.env.PULLBOARD_MACHINE_HOME = box.env.PULLBOARD_MACHINE_HOME;
  try { await warmAcceptedCells(box.repo, box.git(box.repo, 'rev-parse', 'main'), { withCheckout: withMainCheckout, withLock: withFileLock }); }
  finally { if (previousHome === undefined) delete process.env.PULLBOARD_MACHINE_HOME; else process.env.PULLBOARD_MACHINE_HOME = previousHome; }
  const probe = join(box.dir, `trial-probe-${kind}`);
  box.git(box.repo, 'worktree', 'add', '-q', '--detach', probe, 'main');
  document(joinFixtureSeat(box, probe, 'web'));
  // Cell checks apply only to an item titled as a Cells move, so the probe files its own.
  const probeId = fileFixtureItem(box, box.repo, { lane: 'web', title: `Cells move 1/1: trial probe ${kind}`, criterion: 'The probe source reaches the cell checks.', check: 'true', diagnose: false, wait: true, args: ['--specs', 'G1'] }).item_id;
  document(box.run(probe, 'claim', String(probeId), '--json'));
  mkdirSync(join(probe, 'src'), { recursive: true });
  assert.equal(box.helpers.commitFile(box, probe, 'src/unplaced.js', 'export const unsafe = true;\n', 'feat(web): trial probe source [G1]').status, 0);
  if (kind === 'ownership') {
    writeFileSync(join(probe, 'bin/cells-plan.json'), JSON.stringify({ version: 1, cells: [],
      stays: [{ path: 'src/unplaced.js', reason: 'Fixture placement remains explicitly covered.' }],
      entries: [{ path: 'src/unplaced.js', cell: 'app:missing' }] }) + '\n');
    box.git(probe, 'add', 'bin/cells-plan.json');
    box.git(probe, 'commit', '-qm', 'feat(web): trial probe ownership control [G1]');
  }
  assert.equal(document(box.run(probe, 'submit', String(probeId), '--no-next', '--json')).queued, true);
  const file = join(box.repo, '.git', 'pullboard', 'refusal-trials.json');
  const recorded = () => { try { return JSON.parse(readFileSync(file, 'utf8')).codes[code]; } catch { return undefined; } };
  try { await box.helpers.waitFor(() => recorded() !== undefined, `the probe's ${code} trial`, 120000); } // budget: hang ceiling for observed real worker progress; no elapsed-time assertion.
  catch (error) { throw new Error(`${error.message}\n${workerDiagnostic(box, probeId)}`, { cause: error }); }
  const ledger = JSON.parse(readFileSync(file, 'utf8'));
  ledger.gates = 20;
  ledger.codes[code].start = 0;
  writeFileSync(file, JSON.stringify(ledger) + '\n');
}

for (const kind of ['placement', 'ownership']) test(`${kind} cell refusal happens after queue acknowledgment and returns only its builder item [C7,V4,H16]`, async t => {
  const box = fixture(t, { cells: true });
  await enforceCellTrial(box, kind, kind === 'placement' ? 'CELLS_PLAN_UNPLACED' : 'CELLS_SUBMIT');
  mkdirSync(join(box.web, 'src'), { recursive: true });
  assert.equal(helpersCommit(box, 'src/unplaced.js', 'export const unsafe = true;\n').status, 0);
  if (kind === 'ownership') {
    writeFileSync(join(box.web, 'bin/cells-plan.json'), JSON.stringify({ version: 1, cells: [],
      stays: [{ path: 'src/unplaced.js', reason: 'Fixture placement remains explicitly covered.' }],
      entries: [{ path: 'src/unplaced.js', cell: 'app:missing' }] }) + '\n');
    box.git(box.web, 'add', 'bin/cells-plan.json');
    box.git(box.web, 'commit', '-qm', 'feat(web): invalid process ownership control [G1]');
  }

  const queued = document(box.run(box.web, 'submit', String(box.id), '--no-next', '--json'));
  assert.equal(queued.queued, true, 'foreground submission does not compile or refuse the new unplaced cell');
  document(box.run(box.web, 'claim', String(box.second), '--json'));
  await waitJob(box, 'red');
  const completed = state(box, box.id);
  assert.equal(completed.job.error.code, kind === 'placement' ? 'CELLS_PLAN_UNPLACED' : 'CELLS_SUBMIT');
  assert.match(completed.job.error.message, kind === 'placement' ? /src\/unplaced.js/u : /existing app cell/u);
  assert.equal(completed.item.item_status, 'claimed');
  assert.equal(state(box, box.second).item.item_owner, completed.job.agentId);
  assert.equal(existsSync(box.started), false, 'the ordinary gate never executes a source refused by cell checks');
});
