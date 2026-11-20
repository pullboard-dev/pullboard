/** The Home Screen step shows for iOS Safari that is not installed, never in an installed page, and keeps today's rule elsewhere [H5,H15,#10971]. */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { detectInstallContext } from '../../../index.js';
import { homeScreenStepNeeded } from '../../../index.js';

test('relay.logic-browser-install.a-standalone-page-needs-no-home-screen: clause 1: a standalone page needs no Home Screen step whatever persist said [H5,H15]', () => {
  for (const kept of [true, false]) for (const ios of [true, false]) assert.equal(homeScreenStepNeeded({ kept, ios, standalone: true }), false);
});

test('relay.logic-browser-install.ios-safari-that-is-not-standalone-needs: clause 2: iOS Safari that is not standalone needs the Home Screen step even when persist was granted [H5,H15]', () => {
  assert.equal(homeScreenStepNeeded({ kept: true, ios: true, standalone: false }), true);
  assert.equal(homeScreenStepNeeded({ kept: false, ios: true, standalone: false }), true);
});

test('relay.logic-browser-install.a-non-ios-browser-that-refused-persist: clause 3: a non-iOS browser that refused persist keeps today\'s line and one that kept it shows none [H5,H15]', () => {
  assert.equal(homeScreenStepNeeded({ kept: false, ios: false, standalone: false }), true);
  assert.equal(homeScreenStepNeeded({ kept: true, ios: false, standalone: false }), false);
});

test('relay.logic-browser-install.the-install-context-reads-iphone-ipad-and: clause 1: the install context reads iPhone, iPad, iPadOS with touch points and an installed page [H5,H15]', () => {
  const none = () => ({ matches: false });
  assert.deepEqual(detectInstallContext({ userAgent: 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X)' }, none), { ios: true, standalone: false });
  assert.deepEqual(detectInstallContext({ userAgent: 'Mozilla/5.0 (iPad; CPU OS 17_0 like Mac OS X)' }, none), { ios: true, standalone: false });
  assert.deepEqual(detectInstallContext({ userAgent: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7)', maxTouchPoints: 5 }, none), { ios: true, standalone: false });
  assert.deepEqual(detectInstallContext({ userAgent: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7)', maxTouchPoints: 0 }, none), { ios: false, standalone: false });
  assert.equal(detectInstallContext({ userAgent: 'iPhone', standalone: true }, none).standalone, true);
  assert.equal(detectInstallContext({ userAgent: 'Linux' }, query => ({ matches: query === '(display-mode: standalone)' })).standalone, true);
  assert.deepEqual(detectInstallContext({ userAgent: 'Linux' }, () => { throw new Error('no media'); }), { ios: false, standalone: false });
});
