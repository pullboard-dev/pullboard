/**
 * The spec (S1–S5): SPEC.md as rows with ids, read the way a person writes it and checked the way
 * an agent needs it. One row per line, so every id greps to exactly one line:
 *
 *   - G1.2 [approved, must] Same file twice is a no-op. | gate: idempotency test | serves: G1
 *
 * Also here: the frozen criterion an item is verified against (V2), and sign-offs, a person's word
 * that a row is met, kept with the text they read (S5).
 */
import { createHash } from 'node:crypto';
import { appendFileSync, existsSync, mkdirSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { Refused } from './refused.js';
import { readSignerText, signRows, verifySignedRecords } from './signature.js';

export const STATUSES = ['approved', 'draft', 'pending', 'fact', 'wont', 'retired'];
export const TIERS = ['must', 'aim'];
export const SIGNOFFS_FILE = '.pullboard/signoffs.jsonl';

const ID = '[A-Za-z]+\\d+(?:\\.\\d+)*';
export const ID_RE = new RegExp(`^${ID}$`);
const ROW_RE = new RegExp(`^- (${ID}) \\[([a-z]+)(?:,\\s*([a-z]+))?\\]\\s+(.+)$`);
const ROWISH_RE = new RegExp(`^- ${ID}\\s+\\[`);
const SECTION_RE = /^##\s+(.+)$/;
const SIGNER_RE = /^(?!#)[^\s,]+$/u;

/**
 * One row's trailing fields, after the text: `| gate: ...`, `| serves: a, b` and `| signers: CO,AB`.
 *
 * @param {string} rest
 * @returns {{ text: string, gate: string, serves: string[], signers: string[], unknown: string[] }}
 */
function splitFields(rest) {
  const [text = '', ...parts] = rest.split(' | ');
  const fields = { text: text.trim(), gate: '', serves: [], signers: [], unknown: [] };
  for (const part of parts) {
    const [key = '', ...value] = part.split(':');
    const joined = value.join(':').trim();
    if (key.trim() === 'gate') fields.gate = joined;
    else if (key.trim() === 'serves') {
      fields.serves = joined.split(',').map((id) => id.trim()).filter(Boolean);
    } else if (key.trim() === 'signers') {
      fields.signers = joined.split(',').map((signer) => signer.trim()).filter(Boolean);
    } else fields.unknown.push(part.trim());
  }
  return fields;
}

/**
 * Read SPEC.md text into its title, intro, sections and rows. Lines that look like rows but do not
 * parse are kept as problems, never dropped silently.
 *
 * @param {string} source
 * @returns {{ title: string, intro: string[], sections: any[], rows: any[], problems: any[] }}
 */
export function parseSpec(source) {
  const spec = { title: '', intro: [], sections: [], rows: [], problems: [] };
  let section = null;
  let isFenced = false;
  source.split(/\r?\n/).forEach((line, index) => {
    const lineNo = index + 1;
    if (line.startsWith('```')) isFenced = !isFenced;
    if (isFenced || line.startsWith('```')) return;
    if (line.startsWith('# ') && !spec.title) {
      spec.title = line.slice(2).trim();
      return;
    }
    const heading = SECTION_RE.exec(line);
    if (heading) {
      section = { name: heading[1].trim(), line: lineNo };
      spec.sections.push(section);
      return;
    }
    const match = ROW_RE.exec(line);
    if (match && section) {
      const [, id, status, tier, rest] = match;
      const fields = splitFields(rest);
      spec.rows.push({ id, status, tier: tier ?? '', ...fields, section: section.name, line: lineNo });
      return;
    }
    if (ROWISH_RE.test(line)) {
      spec.problems.push({ line: lineNo, message: 'row does not parse: - ID [status, tier] text | gate: ... | serves: ...' });
      return;
    }
    if (!section && line.trim() && !line.startsWith('# ')) spec.intro.push(line.trim());
  });
  return spec;
}

/**
 * The spec file's rows, parsed, or an empty spec when the file does not exist yet.
 *
 * @param {string} root
 * @param {any} config
 * @returns {ReturnType<typeof parseSpec> & { file: string, exists: boolean }}
 */
export function loadSpec(root, config) {
  const file = join(root, config.spec);
  const name = config.spec;
  if (!existsSync(file)) return { ...parseSpec(''), file, name, exists: false };
  return { ...parseSpec(readFileSync(file, 'utf8')), file, name, exists: true };
}

/**
 * Findings for one row on its own: status, tier, text, gate, fields.
 *
 * @param {any} row
 * @param {number} maxWords
 * @returns {any[]}
 */
function rowFindings(row, maxWords) {
  const findings = [];
  const add = (level, message) => findings.push({ level, line: row.line, id: row.id, message });
  if (!STATUSES.includes(row.status)) add('error', `status "${row.status}" is one of ${STATUSES.join(', ')}`);
  if (row.tier && !TIERS.includes(row.tier)) add('error', `tier "${row.tier}" is one of ${TIERS.join(', ')}`);
  if (!row.text) add('error', 'the row has no text');
  if (row.status === 'approved' && row.tier === 'must' && !row.gate) {
    add('error', 'an approved must-row names its gate: | gate: <the test or check that proves it>');
  }
  for (const signer of row.signers ?? []) if (!SIGNER_RE.test(signer)) add('error', `signer "${signer}" must be one SSH principal (no spaces or commas)`);
  if (new Set(row.signers ?? []).size !== (row.signers ?? []).length) add('error', 'signers are unique on a row');
  const words = row.text.split(/\s+/).filter(Boolean).length;
  if (words > maxWords) add('warning', `${words} words; rows stay under ${maxWords}, the why goes elsewhere`);
  for (const part of row.unknown) add('error', `unknown field "${part}"; fields are gate, serves and signers`);
  return findings;
}

/**
 * The first cycle in the serves graph, as the ids around it, or null.
 *
 * @param {Map<string, string[]>} graph
 * @returns {string[] | null}
 */
function firstCycle(graph) {
  const state = new Map();
  const path = [];
  const visit = (id) => {
    if (state.get(id) === 'done') return null;
    if (state.get(id) === 'open') return [...path.slice(path.indexOf(id)), id];
    state.set(id, 'open');
    path.push(id);
    for (const next of graph.get(id) ?? []) {
      const cycle = visit(next);
      if (cycle) return cycle;
    }
    path.pop();
    state.set(id, 'done');
    return null;
  };
  for (const id of graph.keys()) {
    const cycle = visit(id);
    if (cycle) return cycle;
  }
  return null;
}

/**
 * Every finding in a parsed spec (S1–S4): rows that do not parse, duplicate ids, bad statuses,
 * missing gates, serves links to nowhere, and cycles. Errors fail `pullboard spec check`;
 * warnings are advice.
 *
 * @param {ReturnType<typeof parseSpec>} spec
 * @param {{ maxWords?: number }} [options]
 * @returns {{ level: string, line: number, id?: string, message: string }[]}
 */
export function lintSpec(spec, { maxWords = 20 } = {}) {
  const findings = spec.problems.map((problem) => ({ level: 'error', ...problem }));
  const seen = new Map();
  for (const row of spec.rows) {
    if (seen.has(row.id)) {
      findings.push({ level: 'error', line: row.line, id: row.id, message: `duplicate id; first on line ${seen.get(row.id)}. Ids are never reused` });
    } else seen.set(row.id, row.line);
    findings.push(...rowFindings(row, maxWords));
    for (const target of row.serves) {
      if (!seen.has(target) && !spec.rows.some((other) => other.id === target)) {
        findings.push({ level: 'error', line: row.line, id: row.id, message: `serves ${target}, which is not in the spec` });
      }
    }
  }
  const graph = new Map(spec.rows.map((row) => [row.id, row.serves]));
  const cycle = firstCycle(graph);
  if (cycle) {
    const row = spec.rows.find((entry) => entry.id === cycle[0]);
    findings.push({ level: 'error', line: row?.line ?? 0, id: cycle[0], message: `serves links cycle: ${cycle.join(' -> ')}` });
  }
  return findings.sort((first, second) => first.line - second.line);
}

/**
 * The spec ids an item or a commit cites, checked against the spec: every one must exist, and a
 * retired row or one marked wont (won't build) cannot be built against.
 *
 * @param {ReturnType<typeof parseSpec>} spec
 * @param {string[]} ids
 * @returns {string[]} Problems; empty when every id is live.
 */
export function idProblems(spec, ids) {
  const byId = new Map(spec.rows.map((row) => [row.id, row]));
  return ids.flatMap((id) => {
    const row = byId.get(id);
    if (!row) return [`${id} is not in ${spec.name ?? 'the spec'}`];
    if (row.status === 'retired') return [`${id} is retired`];
    if (row.status === 'wont') return [`${id} is marked won't build; the person reopens it first`];
    return [];
  });
}

/**
 * The text an item is held to, and its digest (V2): its title, its criterion, its check command when
 * it has one, and the current text of every spec row it cites. Frozen at first claim; a verdict must
 * match it.
 *
 * @param {ReturnType<typeof parseSpec>} spec
 * @param {{ item_title: string, item_criterion: string, item_spec_ids: string, item_check?: string }} item
 * @returns {{ text: string, digest: string }}
 */
export function frozenCriterion(spec, item) {
  const ids = item.item_spec_ids ? item.item_spec_ids.split(',') : [];
  const problems = idProblems(spec, ids);
  if (problems.length) throw new Refused('UNKNOWN_SPEC', `${problems.join('; ')}; fix the spec, or the coordinator withdraws the item`);
  const rows = ids.map((id) => {
    const row = spec.rows.find((entry) => entry.id === id);
    return { id, text: row.text, gate: row.gate };
  });
  const check = item.item_check ? { check: item.item_check } : {};
  const text = JSON.stringify({ title: item.item_title, criterion: item.item_criterion, ...check, rows });
  return { text, digest: createHash('sha256').update(text).digest('hex') };
}

/**
 * Every sign-off recorded in the repo, oldest first.
 *
 * @param {string} root
 * @returns {{ id: string, by: string, on: string, text: string }[]}
 */
export function readSignoffs(root) {
  const file = join(root, SIGNOFFS_FILE);
  const records = !existsSync(file) ? [] : readFileSync(file, 'utf8')
    .split('\n')
    .filter((line) => line.trim())
    .map((line, index) => {
      try {
        return JSON.parse(line);
      } catch {
        throw new Refused('BAD_SIGNOFFS', `${SIGNOFFS_FILE} line ${index + 1} is not JSON`);
      }
    });
  return verifySignedRecords(root, records);
}

/**
 * Each row's sign-offs split by whether they still match its text (S5): a sign-off on older wording
 * is stale, so a mark always means what it says.
 *
 * @param {any[]} rows
 * @param {any[]} signoffs
 * @returns {Map<string, { met: any[], stale: any[] }>}
 */
export function standings(rows, signoffs) {
  const textOf = new Map(rows.map((row) => [row.id, row.text]));
  const by = new Map();
  for (const signoff of signoffs) {
    const standing = by.get(signoff.id) ?? { met: [], stale: [] };
    if (textOf.get(signoff.id) === signoff.text) standing.met.push(signoff);
    else standing.stale.push(signoff);
    by.set(signoff.id, standing);
  }
  return by;
}

/**
 * Approved rows nobody has signed off on their current text, optionally must-rows only.
 *
 * @param {any[]} rows
 * @param {any[]} signoffs
 * @param {{ mustOnly?: boolean }} [options]
 * @returns {any[]}
 */
export function unmetRows(rows, signoffs, { mustOnly = false } = {}) {
  const by = standings(rows, signoffs);
  return rows.filter(
    (row) =>
      row.status === 'approved' &&
      (!mustOnly || row.tier === 'must') &&
      (row.signers?.length
        ? row.signers.some((signer) => !by.get(row.id)?.met.some((entry) => entry.by === signer))
        : !(by.get(row.id)?.met.length)),
  );
}

/**
 * Record a person's sign-off on approved rows, with the text they read (S5). Only a person's word
 * belongs here: the signer is initials or a first name.
 *
 * @param {string} root
 * @param {ReturnType<typeof parseSpec>} spec
 * @param {{ ids: string[], by: string, on: string, note?: string }} signoff
 * @returns {number} How many rows were signed.
 */
export function signOff(root, spec, { ids, by, on, note = '', commit = '' }) {
  if (!SIGNER_RE.test(by)) {
    throw new Refused('BAD_SIGNER', 'sign with one principal: --by <principal>');
  }
  const byId = new Map(spec.rows.map((row) => [row.id, row]));
  const problems = ids.flatMap((id) => {
    const row = byId.get(id);
    if (!row) return [`${id} is not in the spec`];
    return row.status === 'approved' ? [] : [`${id} is ${row.status}; only approved rows are signed`];
  });
  if (problems.length) throw new Refused('CANNOT_SIGN', problems.join('; '));
  const file = join(root, SIGNOFFS_FILE);
  mkdirSync(dirname(file), { recursive: true });
  if (readSignerText(root)) {
    if (!commit) throw new Refused('NO_SIGNING_COMMIT', 'signed sign-offs include the commit checked; commit or check out the repo first');
    const rows = ids.map((id) => ({ id, by, on, text: byId.get(id).text, commit, note }));
    signRows(root, rows);
    return ids.length;
  }
  const lines = ids.map((id) => JSON.stringify({ id, by, on: on.slice(0, 10), text: byId.get(id).text, ...(note ? { note } : {}) }));
  appendFileSync(file, `${lines.join('\n')}\n`);
  return ids.length;
}

/**
 * Spec ids cited at the end of a commit header: `feat(x): subject [G1.2,K3]`.
 *
 * @param {string} header
 * @returns {string[]}
 */
export function citedIds(header) {
  const match = /\[([A-Za-z0-9.,\s]+)\]\s*$/.exec(header);
  if (!match) return [];
  return match[1].split(',').map((id) => id.trim()).filter(Boolean);
}

/**
 * Ids that left the spec though something still points at them (S8). Ids are permanent: a row that
 * is cut stays, marked wont (won't build) or retired, so every commit and item that cites it keeps
 * its meaning.
 *
 * @param {ReturnType<typeof parseSpec>} spec
 * @param {{ committed: Map<string, string>, cited: Map<string, string> }} references - each id ever
 *   committed to the spec with the commit that first had it, and each cited id with who cites it.
 * @returns {{ id: string, message: string }[]}
 */
export function permanenceProblems(spec, { committed, cited }) {
  const present = new Set(spec.rows.map((row) => row.id));
  const problems = [...committed]
    .filter(([id]) => !present.has(id))
    .map(([id, commit]) => ({
      id,
      message: `was committed in ${commit.slice(0, 12)} and is gone; ids are permanent: restore the row and mark it wont or retired`,
    }));
  for (const [id, where] of cited) {
    if (!present.has(id) && !committed.has(id)) {
      problems.push({ id, message: `${where} cites it, but it was never committed to the spec; add it as a retired row saying what it meant` });
    }
  }
  return problems;
}

/**
 * Rows in `before` that `after` no longer has: what a change to a spec file deletes (S8).
 *
 * @param {string} before
 * @param {string} after
 * @returns {string[]} The deleted ids.
 */
export function deletedIds(before, after) {
  const kept = new Set(parseSpec(after).rows.map((row) => row.id));
  return parseSpec(before).rows.map((row) => row.id).filter((id) => !kept.has(id));
}
