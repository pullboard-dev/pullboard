/** Receipt counts for a run whose output has no TAP summary, read from the report gate.junitReport names [C7,#10373]. */
import { readFileSync } from 'node:fs';
import { isAbsolute } from 'node:path';
import { relative } from 'node:path';
import { resolve } from 'node:path';
import { gateJunitReport } from '../../../config/index.js';
import { junitCounts } from '../logic/junit.js';

const UNKNOWN = counts => Object.values(counts).some(value => value === null);

/**
 * The receipt counts of a run: the TAP or Node totals when its output holds them, else, with gate.junitReport set, the
 * counts of that report in the run's checkout, else unknown exactly as before. A missing, outside-the-checkout or
 * damaged report leaves the counts unknown and never throws.
 * Why: a pytest or go gate prints no TAP totals, so its receipt read "test counts unknown" [C7,#10373].
 *
 * @param {string} root - The checkout the check ran in.
 * @param {{ passed: number|null, failed: number|null, skipped: number|null }} tap - The counts read from the run's output (proofCounts), unknown where it holds none.
 * @returns {{ passed: number|null, failed: number|null, skipped: number|null }}
 */
export function receiptCounts(root, tap) {
  const path = UNKNOWN(tap) ? gateJunitReport() : null;
  if (!path) return tap;
  const file = resolve(root, path), inside = relative(root, file);
  if (!inside || inside.startsWith('..') || isAbsolute(inside)) return tap;
  let xml;
  try { xml = readFileSync(file, 'utf8'); } catch { return tap; }
  const { pass, fail, skip, reason } = junitCounts(xml);
  return reason === null ? { passed: pass, failed: fail, skipped: skip } : tap;
}
