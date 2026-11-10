/** Render person controls from explicit advertised actions without a DOM or fake review [N26,B26,C7]. */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { agentApprovalActionsHtml } from '../../../src/logic/needs/actions.js';
import { needsActionsHtml } from '../../../src/logic/needs/actions.js';

test('approval controls require exact row verbs and person authority on both detail surfaces [N26,B26,C7]', () => {
  const row = { id: 'G1', actions: [{ verb: 'spec-approve', args: { ids: 'G1' } }, { verb: 'spec-decline', args: { ids: 'G2' } }] };
  assert.equal(agentApprovalActionsHtml(row), '');
  const html = agentApprovalActionsHtml(row, { person: true, detail: true });
  assert.match(html, /detail-decision-actions/u);
  assert.match(html, /data-row-id="G1" data-row-decision="approve">Confirm/u);
  assert.doesNotMatch(html, /data-row-decision="decline"/u);
  assert.equal(agentApprovalActionsHtml({ ...row, actions: [{ verb: 'unrelated', args: { ids: 'G1' } }] }, { person: true }), '');
});

test('Needs action rendering keeps revisions exact and inspection-only calls inert [N26,B26,C7]', () => {
  const revision = { kind: 'spec-revision', id: 'G1', actions: [{ verb: 'spec-approve', args: { ids: 'G1' } }, { verb: 'spec-decline', args: { ids: 'G2' } }] };
  assert.match(needsActionsHtml(revision, { person: true }), /data-row-id="G1" data-row-decision="approve"/u);
  assert.doesNotMatch(needsActionsHtml(revision, { person: true }), /data-row-decision="decline"/u);
  assert.doesNotMatch(needsActionsHtml({ ...revision, actions: [] }, { person: true }), /<button/u);
  assert.equal(needsActionsHtml(revision), '');
  for (const kind of ['block', 'relay-health']) assert.equal(needsActionsHtml({ kind, target: 'do-not-navigate' }, { person: true }), '');
});

test('ordinary Needs controls retain exact targets and unmaterialized proposals stay non-actionable [N26,B26,C7]', () => {
  assert.match(needsActionsHtml({ kind: 'decision', id: 7 }, { person: true }), /data-go="decide:7">Decide/u);
  assert.match(needsActionsHtml({ kind: 'pending', id: 'G1' }, { person: true }), /data-go="spec:G1">Review/u);
  assert.match(needsActionsHtml({ kind: 'hold', id: 'view' }, { person: true }), /data-go="tab:shouts"/u);
  assert.equal(needsActionsHtml({ kind: 'rigor-draft', target: 'spec:G1', unproved: true }, { person: true }), '');
  assert.match(needsActionsHtml({ kind: 'rigor-draft', target: 'spec:G1', unproved: true, materialized: true }, { person: true }), /data-go="spec:G1"/u);
  assert.equal(needsActionsHtml({ kind: 'agent-approved' }, { person: false, approvalHtml: '<button>Prepared</button>' }), '');
  assert.equal(needsActionsHtml({ kind: 'agent-approved' }, { person: true, approvalHtml: '<button>Prepared</button>' }), '<button>Prepared</button>');
});
