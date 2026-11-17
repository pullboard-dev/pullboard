import { junitCases } from './junit.js';

/** Pass, fail and skip counts from a JUnit report, so a pytest or go run shows real receipt counts instead of "unknown" [C7]. Damaged or empty XML gives null counts and junitCases' reason code, never a throw. */
export function junitCounts(xml) {
  const { cases, reason } = junitCases(xml);
  if (reason !== null) return { pass: null, fail: null, skip: null, reason };
  const counts = { pass: 0, fail: 0, skip: 0, reason: null };
  for (const { outcome } of cases) counts[outcome] += 1;
  return counts;
}
