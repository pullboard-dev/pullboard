// pullboard: browser
/** @pullboard-test-gui */
/** Diagnostic: the items tab alone with the stage trace on [C7]. */
import { test } from 'node:test';
import { checkTabSpeed } from '../../../tests/fixtures/cockpit/perf/speed.mjs';

process.env.PULLBOARD_TAB_SPEED_TRACE = '1';
test('clause 1: the items tab alone with the stage trace on [C7]', { timeout: 170000 }, t => checkTabSpeed(t, ['items']));
