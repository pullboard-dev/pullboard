/** Open a printed view link like a browser when it exchanges its key for a cookie [N39,N26]. */
import assert from 'node:assert/strict';
import { fetchFresh } from '../http.js';

/** Follow the view's same-origin cookie redirect and validate the final page response.
 *
 * @param {string | URL} url
 * @param {RequestInit} [init]
 * @returns {Promise<Response>}
 */
export async function fetchPrintedViewLink(url, init = {}) {
  const response = await fetchFresh(url, { ...init, redirect: 'manual' });
  if (response.status === 200) return response;
  assert.equal(response.status, 303, 'the printed link either serves the legacy page or exchanges its key');
  await response.body?.cancel();

  const location = response.headers.get('location');
  assert.ok(location, 'the cookie exchange has a redirect target');
  const target = new URL(location, url);
  const source = new URL(url);
  assert.equal(target.username, '', 'the cookie exchange target has no username');
  assert.equal(target.password, '', 'the cookie exchange target has no password');
  assert.equal(target.origin, source.origin, 'the cookie exchange stays on this view origin');
  assert.equal(target.pathname, '/', 'the cookie exchange returns to the clean page path');
  assert.equal(target.search, '', 'the redirect does not keep credentials in the address');
  assert.equal(target.hash, '', 'the redirect has no credential-bearing fragment');

  const setCookies = response.headers.getSetCookie?.() ?? [response.headers.get('set-cookie')].filter(Boolean);
  assert.equal(setCookies.length, 1, 'the exchange sets one session cookie');
  const [pair, ...attributes] = setCookies[0].split(';').map((part) => part.trim());
  assert.match(pair, /^[A-Za-z0-9_-]+=[A-Za-z0-9._~-]+$/u, 'the session cookie has a valid nonempty name and value');
  assert.ok(attributes.some((attribute) => /^httponly$/iu.test(attribute)), 'the session cookie is HttpOnly');
  assert.ok(attributes.some((attribute) => /^samesite=strict$/iu.test(attribute)), 'the session cookie is SameSite=Strict');
  assert.ok(attributes.some((attribute) => /^path=\/$/iu.test(attribute)), 'the session cookie is scoped to the view');
  assert.ok(!attributes.some((attribute) => /^domain=/iu.test(attribute)), 'the session cookie is host-only');

  const headers = new Headers(init.headers);
  headers.set('cookie', pair);
  const page = await fetchFresh(target, { ...init, headers, redirect: 'manual' });
  assert.equal(page.status, 200, 'the cookie fetches the page after the exchange');
  return page;
}
