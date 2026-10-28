/** Read external brief references without treating their private text as work instructions [C7]. */
import { Refused } from './refused.js';
import { ID_RE } from './spec.js';
import { tryGit } from './git.js';

/** Select only the references a maintainer explicitly chose to acknowledge. */
export function handledReferences(brief) {
  return referenceLines(brief).filter(reference => reference.handle !== null);
}

/** Match the target and exact handle on one changelog line, allowing ordinary Markdown links. */
export function referenceAcknowledged(reference, lines) {
  return lines.some(line => line.split(reference.target).slice(1).some(tail => !tail || /^[\s)\]>.,;:!?]/u.test(tail))
    && [...line.matchAll(/@([A-Za-z0-9][A-Za-z0-9-]{0,38})/gu)]
      .some(match => match[1].toLowerCase() === reference.handle.toLowerCase()));
}

/** A reminder never prevents submission, including when historical Git evidence is unavailable. */
export function submitReferenceReminders(root, item, commit) {
  const references = handledReferences(item.item_brief);
  if (!references.length) return [];
  const diff = item.item_claim_head
    ? tryGit(root, ['diff', '--no-ext-diff', '--no-textconv', '--unified=0', item.item_claim_head, commit, '--', 'CHANGELOG.md'])
    : null;
  const added = diff?.status === 0 ? diff.stdout.split('\n')
    .filter(line => line.startsWith('+') && !line.startsWith('+++')).map(line => line.slice(1)) : [];
  return references.filter(reference => !referenceAcknowledged(reference, added))
    .map(reference => `changelog reminder: add an acknowledgement for ${reference.target} @${reference.handle}`);
}

/** Preserve every reference and distinguish an explicit trailing acknowledgement from an incidental @. */
export function referenceLines(brief = '') {
  return (briefSections(brief).reference ?? []).map(text => {
    const matched = /\s+@([A-Za-z0-9][A-Za-z0-9-]{0,38})$/u.exec(text);
    return { text, target: matched ? text.slice(0, matched.index).trim() : text.trim(), handle: matched?.[1] ?? null };
  });
}

/** A bare board identifier belongs in the typed requirement or dependency fields, never in an external reference. */
export function validateReferenceTargets(brief) {
  for (const { target } of referenceLines(brief)) {
    if (ID_RE.test(target)) throw new Refused('REFERENCE_IS_BOARD', `"${target}" is a spec row; cite it with --specs ${target} so it counts in the bar.`);
    if (/^(?:[a-z0-9][a-z0-9._-]*#|#)?[1-9]\d*$/iu.test(target)) {
      throw new Refused('REFERENCE_IS_BOARD', `"${target}" names a board item; use --after ${target.replace(/^#/u, '')} for a dependency or --parent for a parent item.`);
    }
  }
}

const LABEL_RE = /^(files|change|test|out of scope)\s*:\s*(.*)$/i;
const REFERENCE_LABEL_RE = /^(files|change|test|out of scope|reference)\s*:\s*(.*)$/i;

/**
 * The brief split into its labelled sections, each a list of non-empty lines without bullets.
 *
 * @param {string} brief
 * @param {{ references?: boolean }} [options] Preserve the old section grammar during historical replay.
 * @returns {Record<string, string[]>}
 */
export function briefSections(brief, { references = true } = {}) {
  /** @type {Record<string, string[]>} */
  const sections = {};
  let current = '';
  for (const raw of brief.split('\n')) {
    const line = raw.trim();
    const label = (references ? REFERENCE_LABEL_RE : LABEL_RE).exec(line);
    if (label) {
      current = label[1].toLowerCase();
      if (current === 'reference') {
        sections.reference ??= [];
        if (label[2].trim()) sections.reference.push(label[2].trim());
        current = ''; // Only explicit Reference: lines can opt private text into acknowledgement.
      } else sections[current] = label[2].trim() ? [label[2].trim()] : [];
    } else if (current && line) {
      sections[current].push(line.replace(/^[-*]\s+/, ''));
    }
  }
  return sections;
}
