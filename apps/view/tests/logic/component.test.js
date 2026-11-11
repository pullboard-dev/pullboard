/** Pure shared-row content and attribute contracts; layout remains in the Chrome journey [N26,C7]. */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { sharedRowHtml } from '../../src/logic/component.js';

test('shared row data is escaped in every variant and cannot add executable attributes [N26]', () => {
  const text = '<script>unexpected()</script>"&';
  const item = sharedRowHtml({ id: '#27', title: text, meta: text, time: '9:12 PM', chip: text,
    state: 'open', chipTitle: text, attributes: { 'data-item': '27', 'aria-label': text } });
  const needs = sharedRowHtml({ variant: 'needs', id: '#27', title: text, meta: text, chip: text,
    state: 'question', time: '9:12 PM', iconHtml: '?', detailHtml: '<p>Trusted detail</p>' });
  const activity = sharedRowHtml({ variant: 'activity', state: 'build', time: text,
    mainHtml: '<p>Trusted sentence</p>', attributes: { 'data-activity-kind': text } });
  for (const html of [item, needs, activity]) {
    assert.doesNotMatch(html, /<script>/u);
    assert.match(html, /&lt;script&gt;unexpected\(\)&lt;\/script&gt;&quot;&amp;/u);
  }
  assert.match(item, /class="row s-open item-row"/u);
  assert.match(needs, /<details><summary>[^]*Trusted detail<\/p><\/details>/u);
  assert.match(activity, /<time>[^]*<span class="activity-verb build">[^]*<div class="activity-say"><p>Trusted sentence/u);
  assert.throws(() => sharedRowHtml({ attributes: { onclick: 'unexpected()' } }), /unsupported row attribute/u);
  assert.throws(() => sharedRowHtml({ tag: 'script' }), /unsupported row tag/u);
  assert.throws(() => sharedRowHtml({ variant: 'unrecognized' }), /unknown row variant/u);
});


/** Seat addresses remain data, even beside trusted state artwork [N26]. */
test('shared Items seat chips escape identity and hover text while record rows retain their frame [N26]', () => {
  const item = sharedRowHtml({ state: 'building', title: 'Work', seat: '<seat>', chipTitle: 'model"&' });
  assert.match(item, /class="chip item-seat building" title="model&quot;&amp;"/u);
  assert.match(item, /<svg aria-hidden="true"[^]*<\/svg>&lt;seat&gt;<\/span>/u);
  assert.doesNotMatch(item, /<seat>/u);
  const record = sharedRowHtml({ variant: 'record', title: 'Other record', time: 'now', chip: 'Ready' });
  assert.doesNotMatch(record, /row-side|item-seat|item-row/u);
  assert.match(record, /class="row-age">now<\/span>/u);
});
