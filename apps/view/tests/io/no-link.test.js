/** The no-link page tells the owner on their own machine how to open the board, and keeps the shared-board wording for anyone else [N26]. */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { noLinkPage } from '../../src/io/no-link.js';

const HOSTED = 'https://app.pullboard.dev';

test('view.no-link.local-names-pullboard-view: clause 1: a local request gets one action, running pullboard view to print the private link, and no "Ask the person who shared" line [N26]', () => {
  for (const request of [
    { remoteAddress: '127.0.0.1', host: '127.0.0.1:4890' },
    { remoteAddress: '::1', host: 'localhost:4890' },
    { remoteAddress: '::ffff:127.0.0.1', host: '[::1]:4890' },
  ]) {
    const page = noLinkPage(HOSTED, request);
    assert.match(page, /Run <code>pullboard view<\/code> in a terminal on this machine to print this board's private link/u, JSON.stringify(request));
    assert.doesNotMatch(page, /Ask the person who shared/u, JSON.stringify(request));
    assert.equal(page.match(/<code>/gu).length, 1, 'one action only');
  }
});

test('view.no-link.shared-keeps-wording-and-reveals-nothing: clause 2: a non-local request keeps the shared-board wording and shows nothing from the board [N26]', () => {
  for (const request of [
    undefined,
    { remoteAddress: '192.168.1.20', host: '127.0.0.1:4890' },
    { remoteAddress: '127.0.0.1', host: '192.168.1.5:4890' },
    { remoteAddress: '127.0.0.1', host: 'evil.example:4890' },
  ]) {
    const page = noLinkPage(HOSTED, request);
    assert.match(page, /Ask the person who shared this board to send you its link\./u, JSON.stringify(request));
    assert.doesNotMatch(page, /pullboard view/u, JSON.stringify(request));
    assert.doesNotMatch(page, /[?&]k=|secret|token/iu, 'no link, key or secret in the page');
  }
});
