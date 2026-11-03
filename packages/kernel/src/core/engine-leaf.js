/** Read the literal engine-leaf format without importing candidate code [C7]. */
export const ENGINE_LINE = /^export const ([A-Z][A-Z0-9_]*_ENGINE) = (?:(\d+)|unassignedEngine\(\));$/u;
export const UNASSIGNED_IMPORT = "import { unassignedEngine } from './engine-next.js';";

/** Parse the same opted-in declaration used by automatic numbering; unrelated project engines stay untouched. */
export function engineLeafDeclaration(file, text) {
  const lines = text.split('\n').filter(line => /^export const /u.test(line));
  const match = lines.length === 1 ? ENGINE_LINE.exec(lines[0]) : null;
  if (!match) return null;
  const number = match[2] === undefined ? null : Number(match[2]);
  if (number === null && !text.split('\n').includes(UNASSIGNED_IMPORT)) return null;
  return { file, name: match[1], number };
}
