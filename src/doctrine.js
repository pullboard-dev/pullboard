/** The shared house rules (D1–D4): one packaged standard and a repo's explicit changes to it. */
import { readFileSync } from 'node:fs';
import { DOCTRINE_FILE, LEGACY_DOCTRINE_FILE, doctrineFile } from './config.js';
import { committedIds } from './history.js';
import { loadSpec, parseSpec } from './spec.js';

export const STANDARD_VERSION = 1;

/** Read the shipped rows, preserving their source lines and marking the standard's version. */
export function standardDoctrine() {
  const source = readFileSync(new URL('./standard-doctrine.md', import.meta.url), 'utf8');
  const parsed = parseSpec(source);
  const name = 'standard doctrine ' + STANDARD_VERSION;
  return {
    ...parsed, name, exists: true, version: STANDARD_VERSION,
    sections: parsed.sections.map((section) => ({ ...section, origin: 'standard' })),
    rows: parsed.rows.map((row) => ({ ...row, origin: 'standard', version: STANDARD_VERSION, reason: '', file: name })),
  };
}

/** A decline's reason is its row text; a trailing-field-only row has no reason. */
function declineReason(row) {
  const text = row.text.trim();
  return row.status === 'wont' && !/^\|\s*[a-z]+\s*:/i.test(text) ? text : '';
}

/**
 * Merge the inherited standard with the repo's rows. Overrides replace only the matching PB row;
 * duplicate repo rows remain visible to lint, and a decline must state its reason explicitly.
 */
export function loadDoctrine(root, config = {}) {
  const name = doctrineFile(root, config.practice);
  const repo = loadSpec(root, { ...config, spec: name });
  const standard = standardDoctrine();
  const inherited = new Set(standard.rows.map((row) => row.id));
  const overrides = new Set(repo.rows.filter((row) => inherited.has(row.id)).map((row) => row.id));
  // Readers group rows by heading name, so one shared heading must not render the rows twice.
  const sectionNames = new Set();
  const sections = [...standard.sections, ...repo.sections.map((section) => ({ ...section, origin: 'repo' }))]
    .filter((section) => {
      if (sectionNames.has(section.name)) return false;
      sectionNames.add(section.name);
      return true;
    });
  const problems = [...standard.problems, ...repo.problems];
  for (const row of repo.rows) {
    if (/^PB\d/.test(row.id) && !inherited.has(row.id)) {
      problems.push({ line: row.line, id: row.id, message: 'no such rule in standard ' + STANDARD_VERSION });
    }
    if (inherited.has(row.id) && row.status === 'wont' && !declineReason(row)) {
      problems.push({ line: row.line, id: row.id, message: 'declining a standard rule needs a reason in its text: - PB2 [wont] <why>' });
    }
  }
  return {
    title: repo.title || 'Doctrine', intro: repo.intro, name, file: repo.file,
    exists: true, repoExists: repo.exists, version: STANDARD_VERSION, repo,
    problems,
    sections,
    rows: [
      ...standard.rows.filter((row) => !overrides.has(row.id)),
      ...repo.rows.map((row) => ({ ...row, origin: 'repo', version: null, reason: declineReason(row), file: name })),
    ],
  };
}

/** Retain committed row ids across the conventional filename change, even before its rename commit. */
export function doctrineHistory(root, name) {
  const history = committedIds(root, name);
  if (![DOCTRINE_FILE, LEGACY_DOCTRINE_FILE].includes(name)) return history;
  const other = committedIds(root, name === DOCTRINE_FILE ? LEGACY_DOCTRINE_FILE : DOCTRINE_FILE);
  for (const [id, commit] of other.ids) if (!history.ids.has(id)) history.ids.set(id, commit);
  return { ...history, since: history.since ?? other.since };
}

/** A current, labelled rules list for AGENTS.md and cold-start run packs. */
export function doctrineText(doctrine) {
  return doctrine.rows.map((row) => {
    const state = row.status + (row.tier ? ', ' + row.tier : '');
    const reason = row.reason && row.reason !== row.text ? ' Reason: ' + row.reason : '';
    const origin = row.origin === 'standard' ? 'standard ' + row.version : row.origin;
    return '- ' + row.id + ' (' + origin + ') [' + state + '] ' + row.text + reason;
  }).join('\n');
}
