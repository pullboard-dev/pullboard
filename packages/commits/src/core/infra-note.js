/**
 * Infra notes: a submit that edits an existing test file, or a file the gate runs, must say why [C7,V4]. An
 * agent once swapped real listeners for in-memory parsers to get past a sandbox, and nobody asked the person.
 * The note and the files it covers are recorded on the submit event, and the reviewer reads them in show.
 */
import { isAbsolute } from 'node:path';
import { posix } from 'node:path';
import { relative } from 'node:path';
import { Refused } from "../../../../src/refused.js";
import { tryGit } from "../../../../src/git.js";

/** A test file, by its name or by its folder. */
const TEST_FILE = /^test\/|\.(?:test|spec)\.[cm]?js$/u;
/** A token of a gate command that names a file: a path, or a script with a known extension. */
const GATE_FILE = /\.(?:[cm]?js|sh|json)$|\//u;

/**
 * The words of a shell command, as the shell reads them: quotes group a path with spaces, a backslash escapes the next
 * character, and whitespace or a separator (;, &, |, parentheses, redirects) ends a word. A reader that splits on
 * whitespace alone keeps "src/check.js;" and "'src/check gate.js'" as they are, and misses both (#814).
 *
 * @param {string} command one gate command
 * @returns {string[]} the words, in order, without their quotes
 */
function shellWords(command) {
  const words = [];
  let word = null;
  let quote = null;
  for (let at = 0; at < command.length; at += 1) {
    const character = command[at];
    if (quote) {
      if (character === quote) quote = null;
      else word = (word ?? '') + character;
    } else if (character === '"' || character === "'") {
      quote = character;
      word = word ?? '';
    } else if (character === '\\' && at + 1 < command.length) {
      word = (word ?? '') + command[++at];
    } else if (/\s/u.test(character) || ';&|()<>'.includes(character)) {
      if (word !== null) words.push(word);
      word = null;
    } else word = (word ?? '') + character;
  }
  if (word !== null) words.push(word);
  return words;
}

/**
 * The gate files the gate commands name, relative to the checkout. A flag or a URL names nothing; a word that ends in a
 * script extension, or holds a path separator, names a file. Each is normalized as the file system resolves it, so
 * src/../src/check.js, ./src/check.js and an absolute path inside the checkout all name src/check.js, the spelling
 * Git uses for changed files (#814).
 *
 * @param {string[]} commands the gate commands in force
 * @param {string} root the builder's checkout
 * @returns {Set<string>}
 */
function namedByGates(commands, root) {
  const named = new Set();
  for (const command of commands) {
    for (const word of shellWords(String(command ?? ''))) {
      if (!word || word.startsWith('-') || word.includes('://') || !GATE_FILE.test(word)) continue;
      const path = posix.normalize(isAbsolute(word) ? relative(root, word).split('\\').join('/') : word);
      if (path !== '..' && !path.startsWith('../') && !posix.isAbsolute(path)) named.add(path);
    }
  }
  return named;
}

/**
 * The files a submit changes that the claim already had, and that are a test file, the project's pullboard.json,
 * a githook, or a file a gate command names. A new file is not an edit of an existing one.
 *
 * @param {string} root the builder's checkout
 * @param {string} claimHead the commit the item was claimed at
 * @param {string[]} files the files the item changed since the claim
 * @param {string[]} gates the gate commands in force
 * @returns {string[]} the sorted files that need a note
 */
export function existingGuardedEdits(root, claimHead, files, gates) {
  const named = namedByGates(gates, root);
  const guarded = files.filter((path) => TEST_FILE.test(path) || path === 'pullboard.json' || path.startsWith('.githooks/') || named.has(path));
  return guarded.filter((path) => tryGit(root, ['cat-file', '-e', `${claimHead}:${path}`]).status === 0).sort();
}

/**
 * Decide whether a submit may proceed: an enabled board policy requires an --infra reason for an existing guarded
 * edit. A supplied note is recorded with its files whether or not the requirement is enabled.
 *
 * @param {{ root: string, claimHead: string, files: string[], gates: string[], infra: string | undefined, requireInfraNote?: boolean }} submit
 * @returns {{ note: string, files: string[] } | null} the infra record, or null when none is needed or given
 * @throws {Refused} INFRA_NOTE_REQUIRED, or USAGE for a malformed --infra value
 */
export function infraNote({ root, claimHead, files, gates, infra, requireInfraNote = false }) {
  const edited = existingGuardedEdits(root, claimHead, files, gates);
  if (infra === undefined) {
    if (!requireInfraNote || !edited.length) return null;
    throw new Refused('INFRA_NOTE_REQUIRED', `this change edits existing test or gate file${edited.length > 1 ? 's' : ''} ${edited.join(', ')}; say why with --infra "<why>"`,
      'run pullboard submit <id> --infra "<why>", giving the reason the edit is needed');
  }
  if (typeof infra !== 'string' || !infra.trim() || /[\r\n]/u.test(infra)) throw new Refused('USAGE', '--infra "<why>" is one nonempty line');
  return { note: infra.trim(), files: edited };
}

/**
 * The infra record of an item's latest submit, for the reviewer to read; null when that submit gave none.
 *
 * @param {Array<{ event_kind: string, event_detail: string }>} events the item's events, oldest first
 * @returns {{ note: string, files: string[] } | null}
 */
export function infraNoteOf(events) {
  const latest = events.filter((event) => event.event_kind === 'submit').at(-1);
  return latest ? JSON.parse(latest.event_detail).infra ?? null : null;
}
