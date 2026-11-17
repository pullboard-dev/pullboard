/**
 * Find a view timer over 1 s whose callback hides, removes or re-renders, and refuse new ones [C7,#9523].
 * A timer that waits longer than a second and then hides a node, removes one or calls render() moves the page under the
 * pointer when it fires. The sites that exist today are held by a per-file ceiling that only falls; a file past its ceiling
 * reports every site, and a ceiling above the sites left is a finding too, so it is lowered when a site goes. A site whose
 * timer line carries `// stays: <why>` is accepted and not counted.
 *
 * Why: a late layout shift is the one the person cannot predict, so the lint stops the count from growing. Behind
 * gate.viewTimerLayout, off by default: with it off the check reads nothing and reports nothing.
 */
/** The ceilings file: per-file counts of today's sites, repo-relative. A ceiling may only fall. */
export const VIEW_TIMER_CEILING_FILE = 'packages/gate/data/ceilings/view-timer-layout.json';

/** The longest timer delay, in ms, that is not a finding. */
export const TIMER_DELAY_MS = 1000;

const VIEW_SOURCE = /^apps\/view\/src\/.*\.[cm]?js$/u;
const TIMER = /(?<![\w$.])(?:setTimeout|setInterval)\s*\(/gu;
const SHIFT = /(?:\.hidden\s*=(?!=)|\bhidden\s*=(?!=)|\.remove\(\s*\)|\.removeChild\(|(?<![\w$.])render\(\s*\))/u;
const SET_HIDDEN = /setAttribute\(\s*['"]hidden['"]/u;
const STAYS = /\/\/\s*stays:\s*\S/u;

/** Whether a repo-relative path is view source the check covers: never a test. */
export const coveredByViewTimerLayout = path => VIEW_SOURCE.test(path) && !/(?:^|\/)tests?\//u.test(path) && !/[-_.]test\.[cm]?js$/u.test(path);

/** The text with whole-line and trailing `//` comments blanked to spaces, so a timer named in a comment is not read; strings are kept. */
function withoutLineComments(source) {
  return source.replace(/(^|\s)\/\/[^\n]*/gu, (whole, lead) => lead + ' '.repeat(whole.length - lead.length));
}

/** The index of the bracket that closes the one at `open`, or -1. */
function closing(code, open) {
  let depth = 0;
  for (let at = open; at < code.length; at++) {
    if ('([{'.includes(code[at])) depth++;
    else if (')]}'.includes(code[at]) && --depth === 0) return at;
  }
  return -1;
}

/** The text of the last top-level argument of the call whose brackets span `open`..`close`. */
function lastArgument(code, open, close) {
  let depth = 0, start = open + 1;
  for (let at = open + 1; at < close; at++) {
    if ('([{'.includes(code[at])) depth++;
    else if (')]}'.includes(code[at])) depth--;
    else if (code[at] === ',' && depth === 0) start = at + 1;
  }
  return code.slice(start, close).trim();
}

/**
 * Every timer in one file whose delay is a literal over 1 s and whose inline callback hides, removes a node or calls render().
 *
 * @param {string} source - File text.
 * @returns {{line: number, stays: boolean}[]} Sites in line order.
 */
export function timerSites(source) {
  const code = withoutLineComments(source);
  const lines = source.split('\n');
  const sites = [];
  for (const match of code.matchAll(TIMER)) {
    const open = match.index + match[0].length - 1;
    const close = closing(code, open);
    if (close === -1) continue;
    const delay = lastArgument(code, open, close);
    if (!/^\d[\d_]*$/u.test(delay) || Number(delay.replaceAll('_', '')) <= TIMER_DELAY_MS) continue;
    if (!SHIFT.test(code.slice(open, close)) && !SET_HIDDEN.test(code.slice(open, close))) continue;
    const line = code.slice(0, match.index).split('\n').length;
    sites.push({ line, stays: STAYS.test(lines[line - 1] ?? '') });
  }
  return sites;
}

/**
 * Findings for a checkout's view source: a file with more unmarked sites than its ceiling reports each site, and a ceiling above
 * the unmarked sites a file has reports that it may fall. Off (the default) it reports nothing and reads nothing.
 * Why rows and text, not a root: the registry already holds the source texts and reads the ceilings file, so this module imports no file system.
 *
 * @param {{file: string, source: string}[]} rows - Source files of the checkout.
 * @param {{enabled?: boolean, ceilings?: string}} [options] - `enabled` is gate.viewTimerLayout; `ceilings` is the text of the ceilings file.
 * @returns {string[]} `path:line: ...` rows, sorted; empty when the setting is off or nothing grew.
 */
export function viewTimerLayoutRows(rows, { enabled = false, ceilings = '{}' } = {}) {
  if (enabled !== true) return [];
  let held = {};
  try { held = JSON.parse(ceilings).sites ?? {}; } catch { held = {}; }
  const found = [];
  const seen = new Set();
  for (const { file, source } of rows) {
    if (!coveredByViewTimerLayout(file)) continue;
    seen.add(file);
    const open = timerSites(source).filter(site => !site.stays);
    const ceiling = held[file] ?? 0;
    if (open.length > ceiling) {
      for (const { line } of open) found.push(`${file}:${line}: timer over ${TIMER_DELAY_MS} ms hides, removes or re-renders (${open.length} sites, ceiling ${ceiling}); use a shorter timer or mark the line // stays: <why>`);
    } else if (open.length < ceiling) found.push(`${file}:1: ${VIEW_TIMER_CEILING_FILE} holds ${ceiling} sites but ${open.length} remain; lower the ceiling, it only falls`);
  }
  for (const [file, ceiling] of Object.entries(held)) if (!seen.has(file) && ceiling > 0) found.push(`${file}:1: ${VIEW_TIMER_CEILING_FILE} holds ${ceiling} sites for a file that is gone; delete its row`);
  return found.sort();
}
