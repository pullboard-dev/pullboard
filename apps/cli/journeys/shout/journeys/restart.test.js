// pullboard: browser
/** @pullboard-test-gui */
/** The view's main journeys as real-input scenarios in Chrome [N26], and the two-home hosted journey through the real view, relay, browser client and item API [N40]. */

import {
  test,
} from 'node:test';
import {
  relayWorkBudgetMs,
  findChromeExecutable,
} from '../../../tests/fixtures/relay/browser.js';
import {
  everyBoardJourney,
} from '../../../tests/fixtures/cockpit/journey/every.js';

test('pullboard.dev shows every board after Chrome\'s network service restarts [N40,N26]', {
  timeout: relayWorkBudgetMs() * 5 + 180_000,
  skip: (!findChromeExecutable() && 'Chrome is not installed'),
}, (t) => everyBoardJourney(t, null, { restart: true }));
