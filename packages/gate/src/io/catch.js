#!/usr/bin/env node
/**
 * Rigor check: no bare empty catch [D1,C7].
 *
 * A bare empty catch is a `catch` clause, with or without a binding, whose block holds nothing but
 * white space and no comment, and with no comment after its closing brace on the same line. A
 * comment in either place says why the error is ignored; a block with any statement handles it.
 * Only code counts: a catch inside a string, a template's text or a comment is not one, and a
 * promise's `.catch(...)` method is not a catch clause. Every .js, .mjs and .cjs file under the
 * root is read (see scan.js for the walk). One problem per bare empty catch, at its `catch`.
 *
 * @file-local Reads only the files walk() returns, so submit may narrow it to the changed files.
 */
import {
  lex,
  lineAt,
  readText,
  runCheck,
  walk,
} from './scan.js';

const CLAUSE = /(?<![\w$.])catch\s*(?:\([^()]*\)\s*)?\{(\s*)\}/gu;

/**
 * One problem per bare empty catch in every JavaScript file.
 *
 * @param {string} root
 * @returns {{ path: string, line: number, text: string }[]}
 */
export function emptyCatchProblems(root, files = walk(root, /\.[cm]?js$/u), read = path => readText(root, path)) {
  const problems = [];
  for (const path of files.filter(path => /\.[cm]?js$/u.test(path))) {
    const source = read(path);
    const { code, comments } = lex(source);
    for (const clause of code.matchAll(CLAUSE)) {
      const open = clause.index + clause[0].length - clause[1].length - 2;
      const close = clause.index + clause[0].length - 1;
      const lineEnd = code.indexOf('\n', close) === -1 ? code.length : code.indexOf('\n', close);
      const explained = comments.some((comment) => (comment.start > open && comment.start < close) || (comment.start > close && comment.start < lineEnd));
      if (!explained) problems.push({ path, line: lineAt(source, clause.index), text: 'empty catch names no reason: handle the error or say in a comment why it is ignored' });
    }
  }
  return problems;
}

runCheck(import.meta, emptyCatchProblems);
