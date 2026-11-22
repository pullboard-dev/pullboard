// pullboard: browser
/** @pullboard-test-gui */
/** The doctrine tab, alone in its file, meets the 100 ms goal on the real large board or holds its audited row in tab-speed-rows.mjs [N26,C7]. */
import { test } from 'node:test';
import { checkTabSpeed } from '../../../tests/fixtures/cockpit/perf/speed.mjs';

test('cli.journeys-init-perf-tab-speed-doctrine.doctrine-tab-first-and-repeat-paint: clause 1: the doctrine tab, first and repeat click, paints under TAB_SPEED_GOAL_MS or its audited row in tab-speed-rows.mjs [N26,C7]', { timeout: 170000 }, t =>
  checkTabSpeed(t, ['doctrine']));
