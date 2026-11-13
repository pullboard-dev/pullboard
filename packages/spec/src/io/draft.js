/**
 * Write one draft row into SPEC.md or the doctrine file, under a section, with the next free id
 * (spec draft, rigor draft) [S1,D1]. A draft is never approved here: only the person approves.
 */
import { readFileSync } from 'node:fs';
import { Refused } from '../../../kernel/index.js';
import { writeRowApply } from './row/decisions.js';
import {
  insertSectionRows,
  loadSpec,
  nextRowId,
} from './main.js';

/**
 * The sections of a parsed row file that carry an id prefix, such as G in "G · Goals".
 *
 * @param {{ sections: { name: string, line: number }[] }} parsed
 * @returns {{ name: string, line: number, prefix: string }[]}
 */
function prefixedSections(parsed) {
  return parsed.sections.map((section) => ({ ...section, prefix: /^([A-Z][A-Z0-9]*)\s*[·.:-]/u.exec(section.name)?.[1] }))
    .filter((section) => section.prefix);
}

/**
 * Append one draft row and return what was written. `target` is spec (the config's SPEC.md) or
 * doctrine (the repo's doctrine file). The id is the next free one across both files, so a spec
 * row and a doctrine row never share an id. `fields` are trailing fields after the gate, such as
 * a check's count.
 *
 * @param {string} root
 * @param {any} config
 * @param {{ target: 'spec' | 'doctrine', text: string, gate: string, tier?: string, section?: string, fields?: string[], id?: string, taken?: string[], write?: boolean }} draft
 * @returns {{ id: string, file: string, line: string, row: { id: string, status: string, tier: string, text: string, gate: string, section: string } }}
 */
export function draftRow(root, config, { target, text, gate, tier = 'must', section: requested, fields = [], id: fixed, taken = [], write = true }, { loadDoctrine }) {
  const spec = loadSpec(root, config);
  const practice = loadDoctrine(root, config);
  const parsed = target === 'doctrine' ? practice.repo : spec;
  const name = target === 'doctrine' ? practice.name : config.spec;
  if (!parsed.exists) throw new Refused('NO_SPEC', `no ${name}; run: pullboard init`);
  if (!parsed.sections.length) throw new Refused('NO_SECTION', `no section in ${name}; add a section heading, then draft the requirement`);
  const sections = prefixedSections(parsed);
  const wanted = requested ?? (target === 'doctrine' ? sections[0]?.prefix : 'G');
  const section = sections.find((entry) => entry.prefix === wanted);
  if (!section) throw new Refused('SPEC_SECTION', `unknown section "${wanted}" in ${name}; ${sections.length
    ? `choose one of: ${sections.map((entry) => entry.prefix).join(', ')}`
    : 'add a section heading with an id prefix such as G · Goals'}`);
  const malformed = [[spec.file, spec.problems], [practice.repo.file, practice.repo.problems]].find(([, problems]) => problems.length);
  if (malformed) throw new Refused('SPEC_INVALID', `fix the unparsed row in ${malformed[0]} before drafting; an existing id may be ambiguous`);
  // A board draft holds an id too (#878), so a new id skips them; spec apply writes a board draft at its own id.
  const id = fixed ?? nextRowId(section.prefix, [...spec.rows, ...practice.repo.rows, ...taken.map((taken) => ({ id: taken }))]);
  const line = [`- ${id} [draft, ${tier}] ${text} | gate: ${gate}`, ...fields].join(' | ');
  if (!write) return { id, file: name, line, row: { id, status: 'draft', tier, text, gate, section: section.name, prefix: section.prefix } };
  const source = readFileSync(parsed.file, 'utf8');
  const after = insertSectionRows(source, parsed, section, [line]);
  // A write that fails must refuse before any id is printed, so a printed id always names a row that is on disk.
  try { writeRowApply(root, { records: [], files: [{ file: name, before: source, after }], signoffs: { before: null, receipts: [] } }); }
  catch (error) { throw new Refused('SPEC_NOT_WRITABLE', `could not write the draft row to ${name} (${error.code ?? error.message})`, `make ${name} writable in the main checkout, then run the draft again`); }
  return { id, file: name, line, row: { id, status: 'draft', tier, text, gate, section: section.name } };
}
