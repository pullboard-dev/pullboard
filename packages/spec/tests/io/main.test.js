/** frozenCriterion records the stakes of each cited row that is not team, and leaves team rows byte for byte as they froze before [C7,#11412]. */
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { test } from 'node:test';
import {
  frozenCriterion,
  parseSpec,
} from '../../index.js';

const ITEM = { item_title: 'Load twice', item_criterion: 'second load adds nothing', item_spec_ids: 'G1' };
const specWith = stakes => parseSpec(`# Spec

## G · Goals

- G1 [approved, must] Same file twice is a no-op. | gate: idempotency test${stakes}
`);

test('spec.io-main.frozen-rows-carry-stakes: clause 1: frozenCriterion writes stakes on a frozen row whose stakes is low or critical, so a row raised from low to team or critical freezes to a different digest [C7,#11412]', () => {
  const low = frozenCriterion(specWith(' | stakes: low'), ITEM);
  const critical = frozenCriterion(specWith(' | stakes: critical'), ITEM);
  const team = frozenCriterion(specWith(' | stakes: team'), ITEM);
  assert.deepEqual(JSON.parse(low.text).rows, [{ id: 'G1', text: 'Same file twice is a no-op.', gate: 'idempotency test', stakes: 'low' }]);
  assert.equal(JSON.parse(critical.text).rows[0].stakes, 'critical');
  assert.notEqual(low.digest, team.digest, 'raised from low to team the frozen digest differs');
  assert.notEqual(low.digest, critical.digest, 'raised from low to critical the frozen digest differs');
  assert.notEqual(team.digest, critical.digest);
});

test('spec.io-main.team-rows-freeze-unchanged: clause 2: a row at team, written or by default, freezes to exactly the text and digest it froze to before stakes were recorded [C7,#11412]', () => {
  const before = JSON.stringify({ title: ITEM.item_title, criterion: ITEM.item_criterion, rows: [{ id: 'G1', text: 'Same file twice is a no-op.', gate: 'idempotency test' }] });
  const digest = createHash('sha256').update(before).digest('hex');
  for (const stakes of ['', ' | stakes: team']) {
    const frozen = frozenCriterion(specWith(stakes), ITEM);
    assert.equal(frozen.text, before, `a team row${stakes ? ' written out' : ' by default'} freezes to the same text`);
    assert.equal(frozen.digest, digest);
  }
});
