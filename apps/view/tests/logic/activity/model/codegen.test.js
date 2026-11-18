/** @pullboard-test-loads src/view/page-render.js */
/** Generated-script adapter contract; Activity model/HTML assertions remain in activity-sentences.test.js. */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { pageScriptPart2 } from '../../../../index.js';

test('view.activity-model-codegen.activity-timestamp-matching-survives-page-script-generation: Activity timestamp matching survives page-script generation [N26,C7]', () => {
  const generated = pageScriptPart2(new Proxy({}, { get: () => function stub() { return {}; } }));
  const literal = String.raw`/\b\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(?:\.\d+)?(?:Z|[+-]\d\d:\d\d)\b/gu`;
  assert.ok(generated.includes(literal), 'the generated script keeps regex escapes');
  const body = literal.slice(1, literal.lastIndexOf('/'));
  assert.ok(new RegExp(body, 'u').test('2026-10-28T04:12:00Z'), 'the emitted timestamp pattern matches an ISO instant');
});
