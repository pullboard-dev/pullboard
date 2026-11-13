import { renderAgentsBlock } from '../../../config/light.js';
/** @pullboard-test-input packages/doctrine/src/io/standard.md */
/** The shared house rules (D1–D4): one packaged standard and a repo's explicit changes to it. */
import { existsSync } from 'node:fs';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  DOCTRINE_FILE,
  LEGACY_DOCTRINE_FILE,
  doctrineFile,
} from '../../../config/light.js';
import { parseSpec } from '../../../spec/light.js';

export const STANDARD_VERSION = 1;

// Bind shipped data to this module generation before a landing can move or remove its source.
const STANDARD_SOURCE = readFileSync(new URL('./standard.md', import.meta.url), 'utf8');

/** Read the shipped rows, preserving their source lines and marking the standard's version. */
export function standardDoctrine() {
  const parsed = parseSpec(STANDARD_SOURCE);
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
  const file = join(root, name);
  // Read here, not through the spec front door: that door loads git and the board, and this one is a light door.
  const repo = existsSync(file) ? { ...parseSpec(readFileSync(file, 'utf8')), file, name, exists: true } : { ...parseSpec(''), file, name, exists: false };
  return composeDoctrine(repo, name);
}

/** Compose committed doctrine bytes without reading an unapproved checkout file. */
export function doctrineFromSource(source, name) {
  return composeDoctrine({ ...parseSpec(source ?? ''), source, name, file: name, exists: source !== null }, name);
}

/** Overlay only the person's applied exact-row decisions on the committed doctrine. */
export function appliedDoctrine(doctrine, decisions, currentSource, { standard } = {}) {
  const rows = new Map(doctrine.repo.rows.map(row => [row.id, row]));
  const aliases = new Set([DOCTRINE_FILE, LEGACY_DOCTRINE_FILE]);
  const current = parseSpec(currentSource ?? '');
  const currentLines = (currentSource ?? '').split(/\r?\n/u);
  const committedLines = (doctrine.repo.source ?? '').split(/\r?\n/u);
  for (const record of decisions) {
    if (record.kind !== 'doctrine' || !record.applied) continue;
    if (record.file !== doctrine.name && !(aliases.has(record.file) && aliases.has(doctrine.name))) continue;
    const matching = current.rows.filter(row => row.id === record.id);
    if (matching.length !== 1 || currentLines[matching[0].line - 1] !== record.replacement) continue;
    const committed = rows.get(record.id);
    if (committed && doctrine.repo.source !== undefined
      && ![record.source, record.replacement].includes(committedLines[committed.line - 1])) continue;
    const parsed = parseSpec(`## Approved rulings\n${record.replacement}\n`);
    const row = parsed.rows[0];
    if (parsed.rows.length !== 1 || row.id !== record.id || row.text !== record.text
      || row.status !== (record.decision === 'approve' ? 'approved' : 'wont')) continue;
    rows.set(row.id, { ...row, section: rows.get(row.id)?.section ?? row.section });
  }
  return composeDoctrine({ ...doctrine.repo, rows: [...rows.values()] }, doctrine.name, standard);
}

/** Combine one repo snapshot with the packaged standard using the same override rules. */
function composeDoctrine(repo, name, standard = standardDoctrine()) {
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

/** The current and the legacy doctrine file names, in that order. */
export function doctrineFileNames() {
  return [DOCTRINE_FILE, LEGACY_DOCTRINE_FILE];
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

/** Render managed agent guidance with this owner’s actual standard and doctrine formatter. */
export function agentsBlock(doctrine = standardDoctrine()) {
  return renderAgentsBlock(doctrine, doctrineText(doctrine));
}
