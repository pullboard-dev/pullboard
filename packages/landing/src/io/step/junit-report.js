/** Read the JUnit report a landing gate wrote, for the failure names landing records [C7]. */
import { readFileSync } from 'node:fs';
import { isAbsolute } from 'node:path';
import { relative } from 'node:path';
import { resolve } from 'node:path';
import { junitFailures } from '../../logic/junit-failures.js';

/**
 * The text of the report at `path` (relative to the landing checkout) and a code when it cannot be used: JUNIT_UNREADABLE
 * for a missing, outside-the-checkout or non-XML file, JUNIT_DAMAGED for a cut one. Never throws.
 * Why: a missing or damaged report must fall back to the output parse, not fail the landing step by itself [C7].
 */
export function readJunitReport(root, path) {
  const file = resolve(root, path);
  const inside = relative(root, file);
  if (!inside || inside.startsWith('..') || isAbsolute(inside)) return { xml: null, code: 'JUNIT_UNREADABLE' };
  let xml;
  try { xml = readFileSync(file, 'utf8'); } catch { return { xml: null, code: 'JUNIT_UNREADABLE' }; }
  const { code } = junitFailures(xml, root);
  return code ? { xml: null, code } : { xml, code: null };
}
