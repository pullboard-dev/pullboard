import { lex } from '../../../kernel/index.js';

/** Rewrite import lines that hold several bindings into the one-binding-per-line form the style check wants [C7]. */

/** Split a binding list at its top-level commas, keeping quoted names whole; null when a comment or odd quote makes it unsafe. */
function bindingList(text) {
  if (/\/\/|\/\*|\*\//u.test(text)) return null;
  const parts = [];
  let quote = null, start = 0;
  for (let at = 0; at <= text.length; at += 1) {
    const char = text[at];
    if (quote) { if (char === '\\') at += 1; else if (char === quote) quote = null; }
    else if (char === '"' || char === "'") quote = char;
    else if (char === ',' || at === text.length) { const part = text.slice(start, at).trim(); if (part) parts.push(part); start = at + 1; }
  }
  return quote ? null : parts;
}

/** A complete one-line static import, split into its default, named and namespace parts. */
const LINE = /^(\s*)import\s+(?<clause>[^'"{}]*(?:\{(?<named>[^{}]*)\})?[^'"{}]*?)\s*from\s*(?<source>'[^'\\\n]*'|"[^"\\\n]*")(?<attributes>\s+with\s*\{[^{}]*\})?\s*;?\s*$/u;

/** The statements that replace one multi-binding import line, or null when the line is already fine or not safely rewritable. */
function splitLine(line) {
  const match = LINE.exec(line);
  if (!match) return null;
  const { clause, named, source, attributes = '' } = match.groups;
  const indent = match[1];
  const outside = clause.replace(/\{[^{}]*\}/u, '').split(',').map(part => part.trim()).filter(Boolean);
  const names = named === undefined ? [] : bindingList(named);
  if (names === null || outside.some(part => /[^\w$*\s]/u.test(part.replace(/^\*\s*as\s+/u, '')) && !/^\*\s*as\s+[\w$]+$/u.test(part))) return null;
  if (outside.length + names.length < 2) return null;
  const end = ` from ${source}${attributes};`;
  if (!outside.length) return [`${indent}import {`, ...names.map(name => `${indent}  ${name},`), `${indent}}${end}`];
  return [...outside.map(part => `${indent}import ${part}${end}`),
    ...(names.length ? [`${indent}import {`, ...names.map(name => `${indent}  ${name},`), `${indent}}${end}`] : [])];
}

/**
 * Split every multi-binding import line of a source, and every line of a multi-line import block that lists several
 * bindings. Anything it cannot rewrite safely is left as it was, for the style check to name.
 *
 * @param {string} source
 * @returns {{ source: string, changed: boolean }}
 */
export function splitImportBindings(source) {
  const lines = source.split('\n');
  const code = lex(source).code;
  let offset = 0;
  const out = [];
  let inBlock = false;
  for (const line of lines) {
    const tokens = code.slice(offset, offset + line.length);
    offset += line.length + 1;
    if (inBlock) {
      if (/\}/u.test(tokens)) inBlock = false;
      else if (tokens.trim()) {
        const parts = bindingList(line);
        if (parts && parts.length > 1) { const indent = /^\s*/u.exec(line)[0]; out.push(...parts.map(part => `${indent}${part},`)); continue; }
      }
      out.push(line);
      continue;
    }
    // Fixture strings, template text, regular expressions and comments have no import tokens here.
    if (!/^\s*import\b/u.test(tokens)) { out.push(line); continue; }
    if (/^\s*import\s+(?:[A-Za-z_$][\w$]*\s*,\s*)?\{\s*$/u.test(tokens)) { inBlock = true; out.push(line); continue; }
    out.push(...(splitLine(line) ?? [line]));
  }
  const rewritten = out.join('\n');
  return { source: rewritten, changed: rewritten !== source };
}
