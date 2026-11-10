/**
 * A fact's code reference, path:line[-line]@full-sha, checked without reading source [B32,H7].
 *
 * Why its own module: replicas that hold only board data validate the same binding, and
 * packages/store/src/io/board.js keeps under its next 100-line block.
 */
import { Refused } from '../../../../kernel/light.js';

/**
 * Validate a portable code binding without reading source on replicas that hold only board data [B32,H7].
 *
 * @param {string | null | undefined} ref
 * @returns {{ path: string, start: number, end: number, commit: string } | null}
 */
export function factReference(ref) {
  if (ref === null || ref === undefined) return null;
  const parts = typeof ref === 'string' && /^([^\r\n\0]+):(\d+)(?:-(\d+))?@([0-9a-f]{40})$/iu.exec(ref);
  if (!parts) throw new Refused('BAD_FACT_REF', 'a fact reference needs path:line[-line]@full-sha with all 40 hexadecimal characters; use the full git commit id');
  const [, path, first, last, commit] = parts;
  const start = Number(first), end = Number(last ?? first);
  if (path.startsWith('/') || path.includes('\\') || /^[A-Za-z]:/u.test(path) || path.split('/').some((part) => !part || part === '.' || part === '..') || !Number.isSafeInteger(start) || !Number.isSafeInteger(end) || start < 1 || end < start) {
    throw new Refused('BAD_FACT_REF', 'a fact reference needs a relative repo path and a positive ascending line range; use path:line[-line]@full-sha');
  }
  return { path, start, end, commit: commit.toLowerCase() };
}
