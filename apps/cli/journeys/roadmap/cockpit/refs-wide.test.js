// pullboard: browser
/** @pullboard-test-gui */
/** Cockpit roadmap checks: references stay inline at 1280 px, using the shared real-board fixtures [N26,N38]. */
import { test } from 'node:test';
import { proseReferencesAt } from '../../../tests/fixtures/cockpit/refs.js';

test('Roadmap references stay inline and rows expand before opening Items at 1280 px [N26,N38]', { timeout: 90_000 }, (t) => proseReferencesAt(t, 1280));
