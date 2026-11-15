/** Temporary driver for the pilot study; removed before submit (#8058). */
import { test } from 'node:test';
import { FAULTS } from './pilot-faults.js';
import { studyFault } from './pilot.js';

test('pilot faults 3, 6 [C7]', { timeout: 900_000 }, () => {
  const rows = FAULTS.slice(3, 6).map(studyFault);
  console.log(`PILOT_RESULT ${JSON.stringify({ rows })}`);
});
