/** Fail-before, pass-after: the pure judge of whether a [test] clause's test is bound to the change (RFC 0009 CR3) [C7]. */

/**
 * Judge one named test file's outcomes at an item's base commit and at its head. A clause is proven only when at least
 * one case failed on an assertion at base and every case ran and passed at head. Why: a load error, zero cases or a
 * skip at base fails for reasons unrelated to the change, so it would tick a clause no behaviour backs. It reads only
 * the rows it is handed and runs nothing.
 *
 * @param {{ file: string, name: string, passed: boolean, skipped: boolean, failure?: 'assertion' | 'error' }[] | null | undefined} base - Outcome rows at the base commit.
 * @param {{ file: string, name: string, passed: boolean, skipped: boolean }[] | null | undefined} head - Outcome rows at the head commit.
 * @param {string} file - The test file the clause names.
 * @returns {{ proven: boolean, reason: string, cases: string[] }} `cases` names the base cases that failed on an assertion.
 */
export function failBeforePassAfter(base, head, file) {
  const own = rows => (Array.isArray(rows) ? rows : []).filter(row => row && row.file === file);
  const before = own(base), after = own(head);
  const verdict = (proven, reason, cases = []) => ({ proven, reason, cases });
  if (!before.length) return verdict(false, 'zero tests ran at base');
  const failed = before.filter(row => !row.passed && !row.skipped);
  const asserted = failed.filter(row => row.failure === 'assertion');
  if (!asserted.length) {
    if (failed.length) return verdict(false, 'base failed without an assertion failure (a load error or crash does not count)');
    return verdict(false, before.every(row => row.skipped) ? 'every case was skipped at base' : 'no case failed at base');
  }
  if (!after.length) return verdict(false, 'zero tests ran at head');
  if (after.some(row => row.skipped || !row.passed)) return verdict(false, 'a case did not pass at head');
  return verdict(true, 'failed on an assertion at base and passed at head', asserted.map(row => row.name));
}
