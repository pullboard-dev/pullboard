#!/usr/bin/env node
/**
 * Rigor check: every test name carries a spec row id [D1,C7,W3].
 *
 * A test name is the string or template literal given as the first argument of a call to `test`,
 * `it`, `describe` or `suite` (optionally `.only`, `.skip` or `.todo`) in the code of a test file
 * (`*.test.js` or `*.spec.js`, also .mjs and .cjs). Calls reached through another object, such as
 * a subtest's `t.test(...)`, are not test names here: they nest under a named parent. Calls inside
 * strings and comments are not code, so fixture tests that a test writes out are not its own. A
 * call whose first argument is not a literal has no name to read and is not counted.
 *
 * A name carries a spec row id when it holds square brackets with at least one id in them, an
 * upper-case prefix and a number, as in `[G1.2]` or `[V4, C7]`. One problem per name without one.
 *
 * @file-local Reads only the files walk() returns, so submit may narrow it to the changed files.
 */
import {
  lex,
  lineAt,
  readText,
  runCheck,
  TEST_FILE,
  walk,
} from '../scan.js';

const CALL = /(?<![\w$.])(?:test|it|describe|suite)(?:\s*\.\s*(?:only|skip|todo))?\s*\(\s*/gu;
const ROW_ID = /\[[^\]]*\b[A-Z]+\d+(?:\.\d+)*\b[^\]]*\]/u;

/**
 * One problem per literal test name without a spec row id, in every test file.
 *
 * @param {string} root
 * @returns {{ path: string, line: number, text: string }[]}
 */
export function testNameProblems(root) {
  return walk(root, TEST_FILE).flatMap(path => testNameSites(readText(root, path), path));
}

/**
 * One problem per literal test name without a spec row id in one test file's text. Why: the commit hook judges staged
 * bytes, not the working file, with the same rule and message the gate's T5 check prints [C7].
 *
 * @param {string} source - Test file text.
 * @param {string} path - Repo-relative path.
 * @returns {{ path: string, line: number, text: string }[]}
 */
export function testNameSites(source, path) {
  const problems = [];
  const { code, strings } = lex(source);
  const starts = new Map(strings.map((literal) => [literal.start, literal]));
  for (const call of code.matchAll(CALL)) {
    const name = starts.get(call.index + call[0].length);
    if (!name || ROW_ID.test(name.text)) continue;
    const shown = name.text.replace(/\\(['"`\\])/gu, '$1').replace(/\s+/gu, ' ');
    problems.push({ path, line: lineAt(source, name.start), text: `test name has no spec row id: ${shown.length > 80 ? `${shown.slice(0, 77)}...` : shown}` });
  }
  return problems;
}

runCheck(import.meta, testNameProblems);
