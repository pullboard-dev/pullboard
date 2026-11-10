/** @pullboard-test-gui */
/** The hosted journeys' routing sets aside only the reads its own navigation orphaned [N40,N26]. */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  JOURNEY_HOSTED,
  journeyNavigationOrphan,
  routeJourneyOrigins,
} from '../../tests/fixtures/cockpit/journey/routes.js';

/** A stand-in Chrome whose every Fetch.continueRequest answers Invalid InterceptionId, as a retired interception does. */
function retiredInterceptionChrome() {
  const socket = new EventTarget();
  const send = async (method) => {
    if (method === 'Network.getCookies') return { cookies: [] };
    if (method === 'Fetch.continueRequest') throw new Error('{"code":-32602,"message":"Invalid InterceptionId."}');
    // The new document commits as Chrome reports it: a main-frame frameNavigated after the navigation was asked for.
    if (method === 'Page.navigate') queueMicrotask(() => socket.dispatchEvent(new MessageEvent('message', { data: JSON.stringify({ method: 'Page.frameNavigated', params: { frame: { id: 'main' } } }) })));
    return {};
  };
  // A main-frame commit the page makes on its own, with no harness navigation pending.
  const commit = () => socket.dispatchEvent(new MessageEvent('message', { data: JSON.stringify({ method: 'Page.frameNavigated', params: { frame: { id: 'main' } } }) }));
  const pause = (id) => socket.dispatchEvent(new MessageEvent('message', { data: JSON.stringify({ method: 'Fetch.requestPaused',
    params: { requestId: id, resourceType: 'XHR', request: { url: JOURNEY_HOSTED + '/api/v2/boards/b/objects/' + id, method: 'GET', headers: {} } } }) }));
  return { socket, send, pause, commit };
}

test('only an API read paused before the journey\'s navigation commits is set aside as orphaned [N40,N26]', async () => {
  const site = { base: 'http://127.0.0.1:9' };
  const before = retiredInterceptionChrome();
  const orphanRoute = await routeJourneyOrigins(before, site, site);
  before.pause('paused-before');
  await orphanRoute.navigate('about:blank');
  await orphanRoute();
  // The control: the same retired interception, paused after the new document committed, is a routing failure the journey reports.
  const after = retiredInterceptionChrome();
  const failingRoute = await routeJourneyOrigins(after, site, site);
  await failingRoute.navigate('about:blank');
  after.pause('paused-after');
  await assert.rejects(failingRoute(), (error) => /Invalid InterceptionId/u.test(error.message) && /orphaned by navigation: \[\]/u.test(error.message));
  // A commit the page makes on its own after the harness's navigation committed orphans nothing (#935 review).
  const unowned = retiredInterceptionChrome();
  const unownedRoute = await routeJourneyOrigins(unowned, site, site);
  await unownedRoute.navigate('about:blank');
  unowned.pause('paused-before-unowned-commit');
  await new Promise((settled) => { setImmediate(settled); });
  unowned.commit();
  await assert.rejects(unownedRoute(), (error) => /Invalid InterceptionId/u.test(error.message) && /orphaned by navigation: \[\]/u.test(error.message));
  assert.equal(journeyNavigationOrphan(JOURNEY_HOSTED + '/index.html', 1, [2]), false, 'a page asset is never an orphan');
  assert.equal(journeyNavigationOrphan(JOURNEY_HOSTED + '/api/v1/boards', 3, [2]), false, 'a read that paused after the commit is not an orphan');
  assert.equal(journeyNavigationOrphan(JOURNEY_HOSTED + '/api/v1/boards', 1, []), false, 'without a commit nothing is an orphan');
});
