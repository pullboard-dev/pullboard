// pullboard: browser
/** @pullboard-test-gui */
/** A real large board switches tabs inside the person's 100 ms interaction bar [N26]. */
import { test } from 'node:test';
import { checkTabSpeed } from '../../tests/fixtures/cockpit/perf/speed.mjs';

test('first and repeated Spec, Doctrine and Items clicks paint in under 100 ms on the real large board [N26]', { timeout: 300000 }, t =>
  checkTabSpeed(t, ['spec', 'doctrine', 'items']));
