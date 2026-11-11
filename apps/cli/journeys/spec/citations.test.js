/** Real CLI regression: draft rows may be dropped while approved cited rows stay protected. */
import assert from 'node:assert/strict';
import {
  readFileSync,
  writeFileSync,
} from 'node:fs';
import { join } from 'node:path';
import {
  after,
  test,
} from 'node:test';
import { createE2eHelpers } from '../../tests/fixtures/e2e.js';
import { freezer } from '../../index.js';
import { loadConfig } from '../../../../packages/config/index.js';
import { loadDoctrine } from '../../../../packages/doctrine/index.js';

const e2e = createE2eHelpers();
after(e2e.cleanup);

/** Require a real coordinator CLI success and parse its versioned JSON. */
function ok(box, ...args) {
  const result = box.run(box.repo, ...args, '--json');
  assert.equal(result.code, 0, `${result.out}\n${result.err}`);
  return JSON.parse(result.out);
}

/** Read the persisted source row through the public CLI. */
function row(box) {
  return ok(box, 'spec', 'show', 'G1').row;
}

/** Read the complete public item document for mutation checks. */
function item(box, id) {
  return ok(box, 'show', String(id));
}

/** Create a real Git board with an explicit open citation to the requested source status. */
function citedFixture(status) {
  const box = e2e.project('true', undefined, { withWorktree: false });
  const specPath = join(box.repo, 'SPEC.md');
  if (status !== 'approved') {
    const before = readFileSync(specPath, 'utf8');
    const after = before.replace('- G1 [approved, must] The page renders.', `- G1 [${status}, must] The page renders.`);
    assert.notEqual(after, before, 'the fixture changes exactly the source row status');
    writeFileSync(specPath, after);
  }
  assert.equal(row(box).status, status, 'the decision starts from the intended source status');
  const added = ok(box, 'add', 'web', 'Work that cites G1', '--specs', 'G1', '--criterion', 'the cited requirement is implemented', '--check', 'true');
  const id = added.item.item_id;
  const cited = item(box, id);
  assert.equal(cited.item_status, 'open');
  assert.equal(cited.item_spec_ids, 'G1');
  assert.equal(cited.item_check, 'true', 'the item carries a real explicit check');
  return { box, id, specPath };
}

test('spec apply permits declining cited draft rows but protects cited approved rows [V2,H16,S1]', () => {
  for (const status of ['draft', 'pending']) {
    const { box, id } = citedFixture(status);
    const declined = box.run(box.repo, 'spec', 'decline', 'G1', '--reason', `The ${status} proposal is not needed.`, '--json');
    assert.equal(declined.code, 0, `${declined.out}\n${declined.err}`);
    const applied = box.run(box.repo, 'spec', 'apply', '--json');
    assert.equal(applied.code, 0, `${status} cited-row decline should apply: ${applied.out}\n${applied.err}`);
    assert.equal(row(box).status, 'wont');
    const stillOpen = item(box, id);
    assert.equal(stillOpen.item_status, 'open', 'applying a declined draft/pending row does not mutate the citing item');
    assert.equal(stillOpen.item_spec_ids, 'G1');
    assert.equal(stillOpen.item_check, 'true');
  }

  const { box, id, specPath } = citedFixture('approved');
  const declined = box.run(box.repo, 'spec', 'decline', 'G1', '--reason', 'The approved requirement is no longer needed.', '--json');
  assert.equal(declined.code, 0, `${declined.out}\n${declined.err}`);
  const sourceBeforeApply = readFileSync(specPath, 'utf8');
  const itemBeforeApply = item(box, id);
  const refused = box.run(box.repo, 'spec', 'apply', '--json');
  assert.notEqual(refused.code, 0, 'an approved row cited by open work cannot be declined yet');
  assert.equal(JSON.parse(refused.out).error.code, 'ROW_DECISION');
  assert.equal(readFileSync(specPath, 'utf8'), sourceBeforeApply, 'the refusal leaves SPEC.md byte-for-byte unchanged');
  assert.deepEqual(item(box, id), itemBeforeApply, 'the refusal leaves the complete item row unchanged');

  const withdrawn = box.run(box.repo, 'withdraw', String(id), 'The cited work is no longer needed.', '--json');
  assert.equal(withdrawn.code, 0, `${withdrawn.out}\n${withdrawn.err}`);
  assert.equal(item(box, id).item_status, 'withdrawn');
  const retried = box.run(box.repo, 'spec', 'apply', '--json');
  assert.equal(retried.code, 0, `${retried.out}\n${retried.err}`);
  assert.equal(row(box).status, 'wont', 'the approved citation can be declined after its work is withdrawn');
});

test('mixed person decisions name draft omissions and retain ordinary refreezes [S1,V2,H16]', () => {
  const box = e2e.project('true', undefined, { withWorktree: false });
  const specPath = join(box.repo, 'SPEC.md');
  writeFileSync(specPath, readFileSync(specPath, 'utf8').replace('- G2 [approved, must]', '- G2 [draft, must]'));
  const mixed = ok(box, 'add', 'web', 'Mixed citations', '--specs', 'G1,G2', '--criterion', 'The selected promises hold.', '--check', 'true').item.item_id;
  const ordinary = ok(box, 'add', 'web', 'Approved citation', '--specs', 'G1', '--criterion', 'The approved promise holds.', '--check', 'true').item.item_id;
  ok(box, 'spec', 'approve', 'G1', '--text', 'The corrected page renders.');
  ok(box, 'spec', 'decline', 'G2', '--reason', 'The draft is not needed.');
  const applied = box.run(box.repo, 'spec', 'apply');
  assert.equal(applied.code, 0, applied.out + applied.err);
  const notices = applied.out.split('\n').filter(line => line.startsWith('Refreeze skipped'));
  assert.equal(notices.length, 1);
  assert.match(notices[0], new RegExp(`open items #${mixed} citing explicitly declined drafts\\.$`, 'u'));
  const unchanged = item(box, mixed);
  assert.equal(unchanged.item_status, 'open');
  assert.equal(unchanged.item_frozen, null);
  assert.equal(unchanged.item_spec_ids, 'G1,G2');
  assert.match(item(box, ordinary).item_frozen, /The corrected page renders\./u);
  const config = loadConfig(box.repo);
  const ctx = { info: { root: box.repo, isMain: true }, config, doctrine: loadDoctrine(box.repo, config) };
  assert.throws(() => freezer(ctx)(unchanged), error => error.code === 'UNKNOWN_SPEC',
    'an omitted item still cannot freeze a claim against the declined citation');
});
