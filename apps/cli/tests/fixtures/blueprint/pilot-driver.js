/** The pilot study's driver: a runner job runs one leg for one seeded fault, named by the driver file, and prints its result (#8058) [C7]. */
import { basename } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { FAULTS } from './pilot-faults.js';
import { LEGS } from './pilot.js';
import { runLeg } from './pilot.js';

/** Run the leg named in the driver file's name, pilot-run.<fault id | baseline>.<leg>.<n>.test.js, with that fault seeded. */
export function drive(url) {
  const [, id, leg, round] = basename(fileURLToPath(url), '.test.js').split('.');
  const fault = FAULTS.find((entry) => entry.id === id);
  test(`pilot run ${id} ${leg} ${round} [C7]`, { timeout: 590_000 }, (t) => {
    if (!(leg in LEGS)) throw new Error(`unknown leg ${leg}`);
    if (id !== 'baseline' && !fault) throw new Error(`unknown fault ${id}`);
    const ran = runLeg(leg, { fault: fault ? { file: fault.file, find: fault.find, replace: fault.replace } : null, timeoutMs: 540_000 });
    const result = JSON.stringify({ id, leg, round, ...ran });
    t.diagnostic(`PILOT_RESULT ${result}`);
    console.log(`PILOT_RESULT ${result}`);
  });
}
