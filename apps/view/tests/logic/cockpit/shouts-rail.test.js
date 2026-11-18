/** The Shouts rail shows the agents panel and credentials only; the lane hold control lives on the Activity pane [N26]. */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { cockpitMarkup } from '../../../src/logic/cockpit/markup.js';

const markup = cockpitMarkup({ repositoryAttribute: '#', cssAttribute: 'main.css', hostedLocal: false, snapshot: false, readOnly: false, requestMode: false,
  privateCost: false, hostedMarkup: () => '', signIn: '', settingsMarkup: () => '', starMarkup: () => '' });
/** The markup of one pane, up to the next pane's opening tag. */
const pane = (name, next) => markup.slice(markup.indexOf('<section data-pane="' + name + '"'), markup.indexOf('<section data-pane="' + next + '"'));

test('view.cockpit-shouts-rail.clause-1-the-shouts-pane-holds-no: clause 1: the Shouts pane holds no lanes-fold block, no Lanes summary and no hold form [N26]', () => {
  const shouts = pane('shouts', 'spec');
  assert.match(shouts, /id="agents"/u, 'the agents panel stays');
  assert.match(shouts, /id="credentials"/u, 'the credentials block stays');
  assert.doesNotMatch(shouts, /lanes-fold/u);
  assert.doesNotMatch(shouts, /<summary>Lanes<\/summary>/u);
  assert.doesNotMatch(shouts, /hold-form/u);
});

test('view.cockpit-shouts-rail.clause-2-the-lane-hold-control-still: clause 2: the lane hold control still has its home on another pane of the same markup [N26]', () => {
  const at = markup.indexOf('id="hold-form"');
  assert.ok(at > 0, 'the hold form is still in the markup');
  const before = markup.slice(0, at);
  const owner = before.slice(before.lastIndexOf('<section data-pane="')).match(/data-pane="([a-z]+)"/u)[1];
  assert.notEqual(owner, 'shouts', 'it sits on a pane other than Shouts');
  assert.match(markup, /id="lanes-fold"/u);
  assert.match(markup, /id="hold-lane"/u);
});
