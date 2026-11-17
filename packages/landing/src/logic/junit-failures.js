/** Name each failing case of a JUnit report with its file and message, for landing [C7]. */
import { isAbsolute } from 'node:path';
import { relative } from 'node:path';
import { junitAttributes } from '../../../gate/light.js';
import { junitCases } from '../../../gate/light.js';

const LIMIT = 2048;

/** A reported path relative to root, or null when it lies outside it. */
function inRoot(path, root) {
  if (typeof path !== 'string' || !path) return null;
  const file = isAbsolute(path) ? relative(root, path) : path.replace(/^\.\//u, '');
  return file && !file.startsWith('../') && file !== '..' && !file.includes('\\') && !isAbsolute(file) ? file : null;
}

/** The text cut at 2 KB on a character boundary, with the marker landingFailures uses. */
function cut(text) {
  const bytes = Buffer.from(text);
  if (bytes.length <= LIMIT) return text;
  let end = LIMIT;
  while (end > 0 && (bytes[end] & 0xc0) === 0x80) end -= 1;
  return `${bytes.subarray(0, end).toString('utf8')}\n[assertion truncated at 2 KB]`;
}

/** The text of a failure body with its tags and CDATA wrapper removed. */
function bodyText(body) {
  return body.replace(/<!\[CDATA\[([\s\S]*?)\]\]>/gu, '$1').replace(/<[^>]*>/gu, '').trim();
}

/**
 * One row per failed or errored testcase: name, classname, file (inside root, else null) and assertion. Damaged XML gives
 * no rows and a code, never a throw. Why: pytest, Go, Rust, PHP, Elixir, C# and C++ write JUnit, not Node TAP, so landing
 * could name none of their failures [C7].
 */
export function junitFailures(xml, root) {
  const read = junitCases(xml);
  if (read.reason) return { rows: [], code: read.reason };
  const rows = [];
  for (const match of xml.matchAll(/<testcase\b([^>]*?)(\/>|>([\s\S]*?)<\/testcase>)/gu)) {
    const body = match[3] ?? '';
    const failure = /<(failure|error)\b([^>]*?)(\/>|>([\s\S]*?)<\/\1>)/u.exec(body);
    if (!failure) continue;
    const attrs = junitAttributes(match[1]);
    const message = junitAttributes(failure[2]).message;
    const text = bodyText(failure[4] ?? '');
    const assertion = cut([message, text].filter(Boolean).join('\n'));
    rows.push({ name: attrs.name, classname: attrs.classname ?? '', file: inRoot(attrs.file, root), ...(assertion ? { assertion } : {}) });
  }
  return { rows, code: null };
}
