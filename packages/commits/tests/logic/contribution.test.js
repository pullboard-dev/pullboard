/** The contribution record parser accepts the seven shapes and refuses every unsafe or malformed input by field, rule and fix [CR2,CR2a,CR5]. */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { CONTRIBUTION_SHAPES } from '../../index.js';
import { MAX_RECORD_BYTES } from '../../index.js';
import { parseContributionRecord } from '../../index.js';

const BAR = ['bar:', '  - 1: the refusal names the file [test]', 'check:', '  - 1: test/a.test.js > names the file'];
const lines = (...rows) => rows.flat().join('\n') + '\n';

/** One valid record per shape, the smallest each shape's required list allows. */
const VALID = {
  Bug: lines('version: "0.9.4"', 'ran: pullboard next', 'blocks: every claim', BAR, 'refusal: |', '  [BOARD_BUSY] retry', '  next: retry'),
  Ask: lines('have: a flaky board', 'want: guidance'),
  Flaky: lines('test: test/a.test.js > b', 'rate: 3/20', 'env: macOS', 'bar:', '  - 1: 0/20 runs fail [measurement]', 'check:', '  - 1: node packages/gate/src/io/run/tests.js test/a.test.js'),
  Performance: lines('metric: ms per claim', 'baseline: 420 at abc1234', 'measured: 90 at def5678', BAR),
  Fix: lines('rows:', '  - G1.2', 'refs:', '  - 42', 'draft: true', 'status: not_run', BAR),
  Proposal: lines('rows:', '  - G9.1', 'decision_needed: approve the new row', BAR),
  Security: lines('version: "0.9.4"', 'impact: reads another seat state', 'disclose: 90 days', 'bar:', '  - 1: the read is refused [command]', 'check:', '  - 1: node bin/x.js'),
};

test('[CR2] every one of the seven shapes parses through the exported parse function', () => {
  assert.equal(CONTRIBUTION_SHAPES.length, 7);
  for (const shape of CONTRIBUTION_SHAPES) {
    const { fields } = parseContributionRecord(VALID[shape], shape);
    assert.ok(Object.keys(fields).length >= 2, shape);
  }
});

test('[CR2] values keep their types: lists stay lists, quoted text stays text, block text keeps its lines', () => {
  const { fields } = parseContributionRecord(VALID.Bug, 'Bug');
  assert.equal(fields.version, '0.9.4');
  assert.deepEqual(fields.bar, ['1: the refusal names the file [test]']);
  assert.equal(fields.refusal, '[BOARD_BUSY] retry\nnext: retry');
});

/** A refusal case: the record text, the shape, the rule code, and the field its message must name. */
const REFUSED = [
  ['an anchor', VALID.Ask.replace('a flaky board', '&x board'), 'Ask', 'CONTRIB_ANCHOR', 'have'],
  ['an alias', VALID.Ask.replace('a flaky board', '*x'), 'Ask', 'CONTRIB_ALIAS', 'have'],
  ['a tag', VALID.Ask.replace('a flaky board', '!!str board'), 'Ask', 'CONTRIB_TAG', 'have'],
  ['a second document', VALID.Ask + '---\nhave: x\nwant: feature\n', 'Ask', 'CONTRIB_MULTIDOC', 'line'],
  ['a non-ASCII key', VALID.Ask + 'héllo: x\n', 'Ask', 'CONTRIB_KEY', 'héllo'],
  ['a non-ASCII row id', VALID.Fix.replace('G1.2', 'G1é'), 'Fix', 'CONTRIB_ID', 'rows'],
  ['a bidi character', VALID.Ask.replace('flaky', 'fla‮ky'), 'Ask', 'CONTRIB_HIDDEN', 'record'],
  ['a zero-width character', VALID.Ask.replace('flaky', 'fla​ky'), 'Ask', 'CONTRIB_HIDDEN', 'record'],
  ['a record over 16 KB', VALID.Ask + `have: ${'x'.repeat(MAX_RECORD_BYTES)}\n`, 'Ask', 'CONTRIB_SIZE', 'record'],
  ['more than 50 clauses', lines('bar:', Array.from({ length: 51 }, (_, i) => `  - ${i + 1}: c [test]`), 'check:', Array.from({ length: 51 }, (_, i) => `  - ${i + 1}: x`), 'rows:', '  - G1'), 'Fix', 'CONTRIB_CLAUSES', 'bar'],
  ['a key outside the closed list', VALID.Ask + 'kind: Ask\n', 'Ask', 'CONTRIB_KEY', 'kind'],
  ['a key of another shape', VALID.Ask + 'bar:\n  - 1: x [test]\n', 'Ask', 'CONTRIB_KEY', 'bar'],
  ['a repeated key', VALID.Ask + 'want: feature\n', 'Ask', 'CONTRIB_DUPLICATE', 'want'],
  ['a missing required key', 'have: a flaky board\n', 'Ask', 'CONTRIB_REQUIRED', 'want'],
  ['a bad vocabulary value', VALID.Ask.replace('guidance', 'wish'), 'Ask', 'CONTRIB_VALUE', 'want'],
  ['a bad rate', VALID.Flaky.replace('3/20', 'often'), 'Flaky', 'CONTRIB_VALUE', 'rate'],
  ['an inline list', VALID.Fix.replace('rows:\n  - G1.2', 'rows: [G1.2]'), 'Fix', 'CONTRIB_FLOW', 'rows'],
  ['a bar clause without a check', VALID.Fix.replace('  - 1: test/a.test.js > names the file', '  - 2: other'), 'Fix', 'CONTRIB_REQUIRED', 'check'],
  ['a tab in indentation', VALID.Fix.replace('  - G1.2', '\t- G1.2'), 'Fix', 'CONTRIB_TAB', 'line'],
  ['an unclosed quote', VALID.Bug.replace('"0.9.4"', '"0.9.4'), 'Bug', 'CONTRIB_QUOTE', 'version'],
  ['an unknown shape', VALID.Ask, 'Question', 'CONTRIB_SHAPE', 'shape'],
];

test('[CR5] every unsafe or malformed record is refused with its field, rule and fix', () => {
  for (const [name, text, shape, code, field] of REFUSED) {
    assert.throws(() => parseContributionRecord(text, shape), error => {
      assert.equal(error.code, code, `${name}: ${error.message}`);
      assert.ok(error.message.includes(field), `${name} names the field ${field}: ${error.message}`);
      assert.match(error.message, /: .+; fix: .+/u, `${name} names the rule and the fix`);
      return true;
    }, name);
  }
});
