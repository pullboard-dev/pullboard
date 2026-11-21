/** The home page's Flow panel reads through an injected reader and the page draws it only when one is given [N26,C7]. */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { flowHomePanel } from '../../src/io/flow.js';
import { cockpitPage } from '../../src/io/cockpit/page.js';

const doc = { version: 1, release: '0.9.5', asOf: '2026-11-21T12:00:00Z',
  items: [{ id: 7, title: 'a', lane: 'core', cause: 'building', seat: 'core-1' }],
  idle: [{ seat: 'view-2', lane: 'view', reason: 'nothing eligible' }], landings: { lastHour: 0, lastTwoHours: 1 } };

test('view.io-flow.home-panel-from-injected-reader: clause 1: flowHomePanel(readFlow) draws the Flow markup with the unlanded item row and the idle seat from the injected reader, and nothing without one [N26]', () => {
  const html = flowHomePanel(() => doc);
  assert.match(html, /<code>#7<\/code><span class="sx-it">building<\/span>/);
  assert.match(html, /<code>view-2<\/code> nothing eligible/);
  assert.equal(flowHomePanel(undefined), '');
  assert.equal(flowHomePanel(() => null), '');
});

test('view.io-flow.page-carries-panel-only-with-reader: clause 2: cockpitPage contains the Flow panel markup when a reader is injected and none when it is not [N26]', () => {
  const given = cockpitPage('', { commandPhrases: () => ['add'], readFlow: () => doc });
  assert.match(given, /<div class="sx-card sx-flow">/);
  assert.match(given, /<code>#7<\/code>/);
  assert.doesNotMatch(cockpitPage('', { commandPhrases: () => ['add'] }), /sx-flow/);
});
