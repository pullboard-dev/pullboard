/** A focus approval batch renders as one grouped Needs-you entry with its rows and items [B26,C7]. */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { needsPanelHtml } from '../../../../index.js';
import { needsPanelModel } from '../../../../index.js';

test('view.needs-summary-pure.one-focus-approval-batch-lists-each-draft: one focus-approval batch lists each draft row with kind, text and referencing items [B26,C7]', () => {
  const call = { kind: 'focus-approval-batch', id: 'focus-approval:0.9.3', ref: '0.9.3', text: '2 draft rows rest under 0.9.3 items',
    rows: [{ id: 'G1.2', kind: 'spec', text: 'Keep <one> & two.', items: [10, 11] },
      { id: 'D4', kind: 'doctrine', text: 'Prefer small steps.', items: [12] }] };
  const before = JSON.stringify(call);
  const model = needsPanelModel([call], { holds: [] }, { person: true });
  assert.equal(model.questions.length + model.approvals.length, 1, 'the batch is one entry');
  const html = needsPanelHtml(model);
  assert.equal((html.match(/class="needs-call/gu) || []).length, 1);
  assert.match(html, /2 draft rows rest under 0\.9\.3 items/u);
  assert.match(html, /data-batch-row="G1\.2"><b>G1\.2<\/b> <span class="focus-kind">spec<\/span><p>Keep &lt;one&gt; &amp; two\.<\/p><small>Items: #10, #11<\/small>/u);
  assert.match(html, /data-batch-row="D4"><b>D4<\/b> <span class="focus-kind">doctrine<\/span><p>Prefer small steps\.<\/p><small>Items: #12<\/small>/u);
  assert.match(html, /focus-approval/u);
  assert.doesNotMatch(html, /<details[^>]* open>/u, "the batch starts closed like every other row");
  assert.equal(JSON.stringify(call), before, 'rendering does not consume the call');
});
