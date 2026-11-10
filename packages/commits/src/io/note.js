/**
 * Infra notes: guarded edits retain the supplied reason or a factual draft from their diff [C7,V4]. An
 * agent once swapped real listeners for in-memory parsers to get past a sandbox, and nobody asked the person.
 * The note and the files it covers are recorded on the submit event, and the reviewer reads them in show.
 */
import { isAbsolute } from 'node:path';
import { posix } from 'node:path';
import { relative } from 'node:path';
import { Refused } from "../../../kernel/light.js";
import { tryGit } from "../../../git/index.js";
import { gitChildEnv } from "../../../git/index.js";
import { gitExecFileSync } from "../../../git/index.js";
import { importOnlyChange } from "../logic/import-only-change.js";

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

/** Read an exact regular committed blob; modes, missing files and malformed text cannot authorize an automatic note. */
function committedTest(root, revision, path) {
  const row = tryGit(root, ['ls-tree', revision, '--', `:(literal)${path}`]);
  const match = /^(100644|100755) blob ([a-f0-9]{40,64})\t([^\n]+)$/u.exec(row.stdout);
  if (row.status !== 0 || !match || match[3] !== path) return null;
  try {
    const bytes = gitExecFileSync(['cat-file', 'blob', match[2]], {
      cwd: root, env: gitChildEnv(root), encoding: null, maxBuffer: 8 * 1024 * 1024,
    });
    return { mode: match[1], bytes };
  } catch { return null; }
}

/** Draft a reason only when every guarded change preserves all bytes except static import-path contents. */
function importPathNote(root, claimHead, commit, files, edited) {
  if (!commit || !edited.length || !edited.every(path => TEST_FILE.test(path))
    || files.some(path => TEST_FILE.test(path) && !edited.includes(path))) return null;
  for (const path of edited) {
    const before = committedTest(root, claimHead, path), after = committedTest(root, commit, path);
    if (!before || !after || before.mode !== after.mode
      || !importOnlyChange(before.bytes, after.bytes, { specifiersOnly: true })) return null;
  }
  return { note: 'Updated static test import paths; test bindings, assertions and other source bytes are unchanged.', files: edited };
}

/**
 * Decide whether a submit may proceed: an enabled board policy records a note for an existing guarded edit, drafting from its changed
 * files when no reason was supplied. A supplied note is recorded whether or not the policy is enabled.
 *
 * @param {{ root: string, claimHead: string, commit?: string, files: string[], gates: string[], infra: string | undefined, requireInfraNote?: boolean }} submit
 * @returns {{ note: string, files: string[] } | null} the infra record, or null when none is needed or given
 * @throws {Refused} USAGE for a malformed --infra value
 */
export function infraNote({ root, claimHead, commit, files, gates, infra }) {
  const edited = existingGuardedEdits(root, claimHead, files, gates);
  if (infra === undefined) {
    const drafted = importPathNote(root, claimHead, commit, files, edited);
    if (drafted) return drafted;
    if (!edited.length) return null;
    return { note: 'Automatically drafted from guarded diff: ' + edited.map(file => JSON.stringify(file)).join(', ')
      + '. No author rationale was supplied.', files: edited };
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
