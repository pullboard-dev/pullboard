#!/usr/bin/env node
/**
 * Rigor check: sizes in the stylesheets come from the scale [N26,C12].
 *
 * The view, the Dashboard and the phone pages share one scale of tokens in apps/view/src/io/main.css: --text-* for
 * font sizes, --space-* for padding, margin and gap, and --radius-* for corners. A size typed by hand
 * in px is a problem: a font size, a padding, margin or gap above 1px (a 1px hairline is a border
 * trick, not spacing), or a corner radius. Custom property declarations are where the scale is
 * defined, so they never count, and neither does a comment. Every .css file under apps/ is
 * read; docs/demo/view.css is a generated copy and is not. One problem per size, at its line.
 */
import { fileSystemAdapter } from '../../../fs/index.js';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import {
  lineAt,
  readText,
  runCheck,
  walk,
} from './scan.js';

const DECLARATION = /([{;]\s*)([a-z-]+)(\s*:)([^;{}]+)/gu;
const LENGTH = /(?:^|[\s(,])-?(\d*\.?\d+)px\b/gu;

/**
 * The kind of scale a property draws from, or null when its sizes are not held to one.
 *
 * @param {string} property
 * @returns {'text'|'space'|'radius'|null}
 */
function scaleOf(property) {
  if (property === 'font-size' || property === 'font') return 'text';
  if (/^(padding|margin)(-|$)|^(row-|column-)?gap$/u.test(property)) return 'space';
  if (/^border(-[a-z]+)*-radius$/u.test(property)) return 'radius';
  return null;
}

/**
 * One problem per size typed by hand in every stylesheet under src/ and relay/.
 *
 * @param {string} root
 * @returns {{ path: string, line: number, text: string }[]}
 */
export function uiSizeProblems(root) {
  const problems = [];
  for (const path of walk(root, /^apps\/.*\.css$/u)) {
    const source = readText(root, path);
    // Blank out comments, keeping their length, so offsets still map to lines.
    const code = source.replace(/\/\*[\s\S]*?\*\//gu, (comment) => comment.replace(/[^\n]/gu, ' '));
    for (const declaration of code.matchAll(DECLARATION)) {
      const [, before, property, colon, value] = declaration;
      const scale = scaleOf(property);
      if (!scale) continue;
      const start = declaration.index + before.length + property.length + colon.length;
      for (const length of value.matchAll(LENGTH)) {
        if (scale === 'space' && Number(length[1]) <= 1) continue;
        if (scale === 'text' && property === 'font' && length.index !== value.search(LENGTH)) continue;
        problems.push({ path, line: lineAt(source, start + length.index),
          text: `${property} ${length[1]}px is typed by hand: use a --${scale}-* token from apps/view/src/io/main.css` });
      }
    }
  }
  return problems;
}

/** Count the same raw sizes per actual stylesheet, retaining files with no problems [N26]. */
export function uiSizeCounts(root) {
  const counts = Object.fromEntries(walk(root, /^apps\/.*\.css$/u).map(path => [path, 0]));
  for (const problem of uiSizeProblems(root)) counts[problem.path] += 1;
  return counts;
}

// Parse only this executable entrypoint; importing the scanner never consumes a caller's flags.
if (process.argv[1] && fileSystemAdapter().exists(process.argv[1]) && fileSystemAdapter().realpath(process.argv[1]) === fileSystemAdapter().realpath(fileURLToPath(import.meta.url))) {
  const { values, positionals } = parseArgs({ options: { counts: { type: 'boolean' } }, allowPositionals: true });
  if (positionals.length > 1) throw new Error('usage: ui-sizes.js [root] [--counts]');
  if (values.counts) process.stdout.write(`${JSON.stringify(uiSizeCounts(resolve(positionals[0] ?? process.cwd())))}\n`);
  else runCheck(import.meta, uiSizeProblems);
}
