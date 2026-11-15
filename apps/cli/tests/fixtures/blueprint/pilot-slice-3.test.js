/** Temporary driver for the pilot study; removed before submit (#8058). */
import { test } from 'node:test';
import { FAULTS } from './pilot-faults.js';
import { studyFault } from './pilot.js';

test('pilot faults 6, 9 [C7]', { timeout: 900_000 }, () => {
  const rows = FAULTS.slice(6, 9).map(studyFault);
  console.log(`PILOT_RESULT ${JSON.stringify({ rows })}`);
});
