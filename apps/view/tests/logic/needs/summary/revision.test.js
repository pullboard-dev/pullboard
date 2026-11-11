/** Revision comparisons retain full escaped rows inside the shared disclosure [N26,B26,C7]. */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { needsActionsHtml } from '../../../../index.js';
import { needsPanelHtml } from '../../../../index.js';
import { needsPanelModel } from '../../../../index.js';

test('revision Needs rows preserve comparison bytes and exact proposal actions [N26,B26,C7]', () => {
  const call = { kind: 'spec-revision', id: 'R7', ref: 'G1',
    source: 'G1 [approved, must] Keep <old> & "quoted" text.\nThe complete final line.',
    replacement: 'G1 [draft, must] Use <new> & \'quoted\' text.\nThe proposed final line.',
    reason: 'Compare <both> & retain every final word.',
    actions: [{ verb: 'spec-approve', args: { ids: 'R7' } },
      { verb: 'spec-decline', args: { ids: 'R7' } },
      { verb: 'spec-approve', args: { ids: 'G1' } }] };
  const project = { holds: [] }, before = JSON.stringify({ call, project });
  const model = needsPanelModel([call], project, { person: true, expanded: ['spec-revision:R7'] });
  const row = model.questions[0];
  assert.equal(row.source, call, 'the renderer consumes the original projected call');
  assert.deepEqual(row.attribute, ['data-spec-revision', 'R7']);
  const html = needsPanelHtml(model, new Map([[row.key, {
    controlsHtml: needsActionsHtml(call, { person: true }), feedbackHtml: '<p class="spec-feedback">Saved feedback</p>',
  }]]));
  assert.match(html, /class="needs-call spec-revision" data-spec-revision="R7"/u);
  assert.match(html, /data-needs-key="spec-revision:R7"[^>]* open><summary>/u);
  assert.match(html, /data-revision-before><h3>Current row<\/h3><pre>G1 \[approved, must\] Keep &lt;old&gt; &amp; &quot;quoted&quot; text\.\nThe complete final line\.<\/pre>/u);
  assert.match(html, /data-revision-after><h3>Proposed row<\/h3><pre>G1 \[draft, must\] Use &lt;new&gt; &amp; &#39;quoted&#39; text\.\nThe proposed final line\.<\/pre>/u);
  assert.match(html, /class="revision-reason">Compare &lt;both&gt; &amp; retain every final word\.<\/p>/u);
  assert.doesNotMatch(html, /<old>|<new>|<both>|data-needs-field="(?:current-row|proposed-row)"/u);
  assert.equal((html.match(/data-row-id="R7"/gu) || []).length, 2);
  assert.doesNotMatch(html, /data-row-id="G1"/u, 'controls never address the approved source row');
  assert.match(html, /data-row-decision="approve"/u);
  assert.match(html, /data-row-decision="decline"/u);
  assert.match(html, /Saved feedback/u);
  const closedModel = needsPanelModel([call], project);
  const closed = needsPanelHtml(closedModel, new Map([[row.key, { controlsHtml: needsActionsHtml(call) }]]));
  assert.doesNotMatch(closed, / open>|data-row-decision=/u, 'read-only comparisons remain collapsed without person controls');
  assert.match(closed, /data-revision-before/u);
  assert.equal(JSON.stringify({ call, project }), before, 'comparison rendering leaves the board projection unchanged');
});
