// pullboard: browser
/** @pullboard-test-gui */
/** Diagnostic: the items tab alone; names the stage in flight at 100 s [C7]. */
import { test } from 'node:test';
import {
  checkTabSpeed,
  nameStuckStage,
} from '../../../tests/fixtures/cockpit/perf/speed.mjs';

process.env.PULLBOARD_TAB_SPEED_TRACE = '1';
test('clause 1: the items tab alone names its stage [C7]', { timeout: 170000 }, t => nameStuckStage(checkTabSpeed(t, ['items']), 100_000));
