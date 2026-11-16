/** Which outside things a source starts: a process, a browser, a runner or a board [C7]. */
import { lex } from '../../../../kernel/index.js';

const STARTERS = '(?:spawn|spawnSync|exec|execSync|execFile|execFileSync|fork|Worker)';

/**
 * The categories of outside work one source starts, read from its code with strings and comments masked.
 * Why: tiers.js reads the same evidence for its own reasons; a separate reader keeps this cell's manifest from changing every test that imports the front door.
 *
 * @param {string} source
 * @returns {Set<string>} any of board, process, browser, runner
 */
export function spawnCategories(source) {
  const { code } = lex(source);
  const found = new Set();
  const aliases = [...code.matchAll(new RegExp(`\\b${STARTERS}\\s+(?:as)\\s+([\\w$]+)`, 'gu')),
    ...code.matchAll(new RegExp(`\\b${STARTERS}\\s*:\\s*([\\w$]+)`, 'gu'))].map(match => match[1]);
  if (/\b(?:openBoard|openBoardStore|openBoardForRead|openBoardReadOnly|fixtureBoard|DatabaseSync)\s*\(/u.test(code)) found.add('board');
  if (new RegExp(`\\b${STARTERS}\\s*\\(`, 'u').test(code)
    || aliases.some(name => new RegExp(`\\b${name.replaceAll('$', '\\$')}\\s*\\(`, 'u').test(code))) found.add('process');
  if (/\b(?:launch|launchPersistentContext|connectOverCDP)\s*\(/u.test(code)) found.add('browser');
  if (/\b(?:startRunner|runRunner|runTestFiles|runFullSuite)\s*\(/u.test(code)) found.add('runner');
  return found;
}
