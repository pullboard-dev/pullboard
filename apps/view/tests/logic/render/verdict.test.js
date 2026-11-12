/** Review wording, metadata and prepared links are plain renderer inputs [N26,C7]. */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { verdictHtml } from '../../../src/logic/render/verdict.js';
import { visibleVerdictNote } from '../../../src/logic/render/verdict.js';

test('verdict presentation keeps prepared note links and escapes every plain metadata field [N26,C7]', () => {
  const accepted = verdictHtml({ verdict: { decision: 'ACCEPT', reason: 'PASS & <safe>', commit: 'abcdef1234567890' },
    agentLabel: 'tests & model', timeLabel: '<noon>', noteHtml: '<a class="ref" href="#spec/G1">checked</a>' });
  assert.match(accepted, /class="verdict yes"/u);
  assert.match(accepted, /ACCEPT PASS &amp; &lt;safe&gt;/u);
  assert.match(accepted, /tests &amp; model · &lt;noon&gt; · at <button class="hash-copy"[^>]*data-copy="abcdef1234567890"><code[^>]*>abcdef123456<\/code><\/button>/u);
  assert.match(accepted, /<a class="ref" href="#spec\/G1">checked<\/a>/u);
  const rejected = verdictHtml({ verdict: { decision: 'REJECT', reason: "TEST_FAILURE'", commit: null },
    agentLabel: 'tests-1', timeLabel: '12:01', noteHtml: 'first line<br>second line' });
  assert.match(rejected, /class="verdict no"/u);
  assert.match(rejected, /TEST_FAILURE&#39;/u);
  assert.match(rejected, /12:01 · at <\/span>/u);
  assert.match(rejected, /first line<br>second line/u);
});

test('only a separate leading verdict token is removed from the visible note [N26,C7]', () => {
  assert.equal(visibleVerdictNote('TEST_FAILURE', 'TEST_FAILURE The assertion failed.'), 'The assertion failed.');
  assert.equal(visibleVerdictNote('TEST_FAILURE', 'TEST_FAILURE\nKeep the rest.'), 'Keep the rest.');
  assert.equal(visibleVerdictNote('TEST_FAILURE', 'TEST_FAILURE_SUFFIX remains data'), 'TEST_FAILURE_SUFFIX remains data');
  assert.equal(visibleVerdictNote('TEST_FAILURE', 'Later TEST_FAILURE stays'), 'Later TEST_FAILURE stays');
  assert.equal(visibleVerdictNote('', ' Original spacing'), ' Original spacing');
  assert.equal(visibleVerdictNote('TEST_FAILURE', null), '');
});
