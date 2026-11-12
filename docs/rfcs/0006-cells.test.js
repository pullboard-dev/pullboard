/** @pullboard-test-input docs/rfcs/0006-cells.md */
/** RFC 0006's standing rules each name an enforcing check that exists [CD4,CD23,CD33,CD61]. */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import { STATIC_CHECK_CLASSES } from '../../packages/gate/src/io/static/registry.js';
import { CELL_METRICS } from '../../packages/codemap/src/io/cell/lints.js';

const RFC = new URL('./0006-cells.md', import.meta.url);

/** The standing-rules section's bullets as `{ rule, check, metric }`. */
function standingRules(source) {
  const section = source.split('\n## Standing rules and the check that enforces each\n')[1]?.split('\n## ')[0];
  assert.ok(section, 'the RFC has a standing-rules section');
  return section.split('\n').filter(line => line.startsWith('- ')).map(line => {
    const [, check, metric] = /check: ([a-z-]+)(?:\/([A-Za-z]+))?\s*$/u.exec(line) ?? [];
    return { rule: line, check, metric };
  });
}

/** Whether a rule's named check is a real static class, and its metric a real cell-lint counter. */
function missing(rule) {
  if (!rule.check) return `names no check: ${rule.rule}`;
  if (!STATIC_CHECK_CLASSES.includes(rule.check)) return `names a check that does not exist: ${rule.check}`;
  if (rule.metric && !CELL_METRICS.includes(rule.metric)) return `names a cell-lint metric that does not exist: ${rule.metric}`;
  return null;
}

test('clause 1: the standing-rules section lists each kept cell rule, each naming its enforcing check [CD4]', () => {
  const rules = standingRules(readFileSync(RFC, 'utf8'));
  const text = rules.map(rule => rule.rule).join('\n');
  for (const word of [/cell is a folder/u, /front door/u, /declared rule/u, /cycle/u, /shim ratchet/u, /size caps/u]) assert.match(text, word);
  assert.deepEqual(rules.map(missing).filter(Boolean), []);
});

test('clause 2: a rule that names a check which does not exist fails the test [CD4]', () => {
  const real = standingRules('\n## Standing rules and the check that enforces each\n- r. check: cells-edges\n');
  assert.equal(missing(real[0]), null);
  const fake = standingRules('\n## Standing rules and the check that enforces each\n- r. check: no-such-check\n- s. check: cell-lints/nope\n- t.\n');
  assert.match(missing(fake[0]), /does not exist: no-such-check/u);
  assert.match(missing(fake[1]), /metric that does not exist: nope/u);
  assert.match(missing(fake[2]), /names no check/u);
});
