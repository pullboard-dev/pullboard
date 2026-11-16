/**
 * A brief's labelled sections (B10, B14): `Files:`, `Change:`, `Test:` and `Out of scope:`, each
 * followed by text on the same line or by lines below it, until the next label. Below the strong
 * route a brief must name its files and its test, because a lighter model works from the brief alone.
 */

import { briefSections } from "../../../spec/light.js";

/** Remove closed parenthetical notes while leaving an unmatched note visible to path checks.
 *
 * @param {string} text
 * @returns {string}
 */
function withoutParentheticalNotes(text) {
  let depth = 0;
  let noteStart = -1;
  let output = '';
  for (let index = 0; index < text.length; index += 1) {
    const character = text[index];
    if (character === '(') {
      if (depth === 0) {
        noteStart = index;
        output += ' ';
      }
      depth += 1;
    } else if (character === ')' && depth > 0) {
      depth -= 1;
      if (depth === 0) {
        noteStart = -1;
        output += ' ';
      }
    } else if (depth === 0) output += character;
  }
  if (depth > 0) output += text.slice(noteStart);
  return output;
}

/**
 * The paths a brief's Files section names, without bullets, backticks or trailing notes.
 *
 * @param {string} brief
 * @param {{ references?: boolean }} [options] Use the same section grammar as the caller's replay engine.
 * @returns {string[]}
 */
export function briefFiles(brief, options) {
  const key = `${options?.references === false ? 0 : 1}\0${brief}`;
  let files = FILES_BY_BRIEF.get(key);
  if (!files) {
    files = parseBriefFiles(brief, options);
    if (FILES_BY_BRIEF.size >= FILES_CACHE_LIMIT) FILES_BY_BRIEF.clear();
    FILES_BY_BRIEF.set(key, files);
  }
  return [...files];
}

/** Parsed Files sections by brief text: a command reads the same thousands of briefs many times and parsing each was most of next's cost (#8432). */
const FILES_BY_BRIEF = new Map();
const FILES_CACHE_LIMIT = 20_000;

/** @param {string} brief @param {{ references?: boolean }} [options] @returns {string[]} */
function parseBriefFiles(brief, options) {
  return (briefSections(brief, options).files ?? [])
    .flatMap((entry) => withoutParentheticalNotes(entry).split(/[,\s]+/))
    .map((token) => token.replace(/^[(`'"]+|[)\]'".,;:!?]+$/g, ''))
    .filter((token) => !/^[\d.]+$/.test(token)
      && !/^[a-z]+:\/\//i.test(token)
      && (token.includes('/') || /\.[a-z0-9]+(?:\.[a-z0-9]+)*$/i.test(token)));
}
