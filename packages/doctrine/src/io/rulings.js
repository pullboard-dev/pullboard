/**
 * Standing rulings the person approves become doctrine every agent reads [D1,D3,B27].
 *
 * The coordinator proposes a ruling as a sourced draft doctrine row; only the person approves or
 * declines it, through the ordinary spec approve and decline commands. Once applied, every
 * checkout reads it from the primary branch plus the person's applied row decisions, so an old
 * worktree sees it without moving its branch, and each checkout's next resume names it once.
 */
import { createHash } from 'node:crypto';
import {
  existsSync,
  mkdirSync,
  readFileSync,
  writeFileSync,
} from 'node:fs';
import {
  dirname,
  join,
} from 'node:path';
import * as store from '../../../store/index.js';
import {
  DOCTRINE_FILE,
  LEGACY_DOCTRINE_FILE,
} from '../../../config/index.js';
import {
  appliedDoctrine,
  doctrineFromSource,
  loadDoctrine,
} from './main.js';
import {
  tryGit,
} from '../../../git/index.js';
import { Refused } from '../../../kernel/index.js';
import { writeRowApply } from '../../../spec/index.js';
import { mainCriterionFacts } from './main-criterion-facts.js';
import { primaryCheckoutPath } from './main-criterion-facts.js';
import {
  loadSpec,
  parseSpec,
} from '../../../spec/index.js';

/**
 * Read one doctrine file at a commit, falling back to the other default name the way loadDoctrine
 * does, so a repo that still uses the legacy file name keeps its rules.
 *
 * @param {string} root
 * @param {string} commit
 * @param {string} name
 * @returns {{ name: string, source: string | null }}
 */
function doctrineAt(root, commit, name) {
  const source = tryGit(root, ['show', `${commit}:${name}`]);
  if (source.status === 0) return { name, source: source.stdout };
  if ([DOCTRINE_FILE, LEGACY_DOCTRINE_FILE].includes(name)) {
    const alias = name === DOCTRINE_FILE ? LEGACY_DOCTRINE_FILE : DOCTRINE_FILE;
    const other = tryGit(root, ['show', `${commit}:${alias}`]);
    if (other.status === 0) return { name: alias, source: other.stdout };
  }
  return { name, source: null };
}

/**
 * The doctrine in force for any agent: the primary branch's committed doctrine plus the person's
 * applied exact-row decisions. Why not this checkout's file: an old worktree would never see a
 * ruling approved after it branched.
 *
 * @param {any} ctx the CLI context
 * @param {any} board
 * @returns {any} a composed doctrine, as loadDoctrine returns
 */
export function agentDoctrine(ctx, board, { facts = mainCriterionFacts(ctx.info.root), decisions = store.rowDecisions(board) } = {}) {
  const root = ctx.info.root;
  let doctrine = facts?.doctrine ?? ctx.doctrine;
  let name = doctrine.name;
  const primaryRoot = primaryCheckoutPath(root);
  const file = primaryRoot && join(primaryRoot, name);
  const current = file && existsSync(file) ? readFileSync(file, 'utf8') : null;
  return appliedDoctrine(doctrine, decisions, current, { standard: facts?.standard });
}

/**
 * The doctrine rows a stale check compares frozen citations with: the shared rules, overlaid only
 * with rows this checkout actually edited since HEAD. Why the overlay: a local edit must still
 * flag its item stale, without the old local file hiding a newer shared ruling.
 *
 * @param {any} ctx the CLI context
 * @param {any} doctrine the shared doctrine from agentDoctrine
 * @param {{ headDoctrine?: any }} options exact committed HEAD doctrine from the same fresh source batch
 * @returns {any[]}
 */
export function staleDoctrineRows(ctx, doctrine, { headDoctrine } = {}) {
  const working = loadDoctrine(ctx.info.root, ctx.config);
  const committed = headDoctrine ?? doctrineFromSource(doctrineAt(ctx.info.root, 'HEAD', working.name).source, working.name);
  const before = new Map(committed.rows.map(row => [row.id, row]));
  const current = new Map(working.rows.map(row => [row.id, row]));
  const rows = new Map(doctrine.rows.map(row => [row.id, row]));
  for (const id of new Set([...before.keys(), ...current.keys()])) {
    if (before.get(id)?.text === current.get(id)?.text) continue;
    if (current.has(id)) rows.set(id, current.get(id));
    else rows.delete(id);
  }
  return [...rows.values()];
}

/**
 * The approved repo rulings this checkout has not yet been shown, recorded so each is named once.
 * The record lives under this checkout's Git directory, so every other checkout keeps its own
 * notice, the way resume release notes work.
 *
 * @param {{ gitDir: string }} info
 * @param {any} doctrine the shared doctrine from agentDoctrine
 * @returns {{ id: string, text: string, gate: string }[]}
 */
export function resumeDoctrineNotes(info, doctrine) {
  const record = join(info.gitDir, 'pullboard-checkout', 'resume-doctrine.json');
  let previous = {};
  try { previous = JSON.parse(readFileSync(record, 'utf8')); } catch { /* First doctrine resume. */ }
  if (!previous || typeof previous !== 'object' || Array.isArray(previous)) previous = {};
  const approved = doctrine.rows.filter(row => row.origin === 'repo' && row.status === 'approved');
  /** Identify the exact approved guidance this checkout has already displayed. */
  const fingerprint = row => createHash('sha256').update(JSON.stringify([row.text, row.gate])).digest('hex');
  const notes = approved.filter(row => previous[row.id] !== fingerprint(row))
    .map(row => ({ id: 'doctrine:' + row.id, text: row.text, gate: row.gate }));
  mkdirSync(dirname(record), { recursive: true });
  writeFileSync(record, JSON.stringify({ ...previous, ...Object.fromEntries(approved.map(row => [row.id, fingerprint(row)])) }) + '\n', { mode: 0o600 });
  return notes;
}

/**
 * Append one sourced ruling as a draft doctrine row, never approving it or touching another row.
 * The caller has already checked that the coordinator is asking.
 *
 * @param {any} ctx the CLI context
 * @param {{ source?: string, section?: string, aim?: boolean, gate?: string }} values
 * @param {string} text the ruling
 * @param {{ id?: string, reserved?: string[], write?: boolean }} [options] id: the id the board reserved, to write
 *   at (#878); reserved: ids the board's drafts hold, which a planned id skips; write false plans without writing.
 * @returns {{ id: string, row: { id: string, status: string, tier: string, text: string, gate: string, section: string } }}
 */
export function proposeDoctrine(ctx, values, text, { id: fixed, reserved = [], write = true } = {}) {
  const doctrine = ctx.doctrine;
  if (!doctrine.repoExists) throw new Refused('NO_SPEC', `no ${doctrine.name}; run pullboard init before proposing doctrine`);
  if (doctrine.repo.problems.length) throw new Refused('SPEC_INVALID', `fix the unparsed row in ${doctrine.name} before proposing a ruling`);
  const sections = doctrine.repo.sections.map(section => ({ ...section,
    prefix: /^([A-Z][A-Z0-9]*)\s*[·.:-]/u.exec(section.name)?.[1] })).filter(section => section.prefix);
  const prefix = values.section ?? 'DR';
  const section = sections.find(section => section.prefix === prefix);
  if (!section && values.section) throw new Refused('SPEC_SECTION', `unknown section "${prefix}" in ${doctrine.name}; use a declared section or omit --section for rulings`);
  const used = [...loadSpec(ctx.info.root, ctx.config).rows, ...doctrine.rows, ...reserved.map((id) => ({ id }))];
  const numbers = used.map(row => new RegExp(`^${prefix}(\\d+)$`, 'u').exec(row.id)?.[1]).filter(Boolean).map(Number);
  const id = fixed ?? `${prefix}${Math.max(0, ...numbers) + 1}`;
  const tier = values.aim ? 'aim' : 'must';
  const gate = values.gate?.trim() ?? 'review';
  const ruling = `${text.trim()} Source: ${values.source.trim()}`;
  const row = `- ${id} [draft, ${tier}] ${ruling} | gate: ${gate}`;
  const planned = { id: 'doctrine:' + id, row: { id, status: 'draft', tier, text: ruling, gate, section: section?.name ?? 'DR · Rulings' } };
  if (!write) return planned;
  const source = readFileSync(doctrine.repo.file, 'utf8');
  // Two identical callers may share the reservation. Check the bytes actually read, not a stale planning context.
  const existing = fixed ? parseSpec(source).rows.filter(row => row.id === fixed) : [];
  if (existing.length) {
    if (existing.length === 1 && existing[0].status === 'draft' && existing[0].text === ruling
      && existing[0].gate === gate && existing[0].tier === tier) return planned;
    throw new Refused('ROW_DRAFT', `${fixed} already names different or decided doctrine; reload its current row before proposing a new ruling`);
  }
  const newline = source.includes('\r\n') ? '\r\n' : '\n';
  const lines = source.split(/\r?\n/u);
  if (section) {
    const following = doctrine.repo.sections.find(entry => entry.line > section.line);
    let insertion = following ? following.line - 1 : lines.length;
    while (insertion > section.line && !lines[insertion - 1].trim()) insertion -= 1;
    lines.splice(insertion, 0, row);
  } else {
    while (lines.length && !lines.at(-1).trim()) lines.pop();
    lines.push('', '## DR · Rulings', row, '');
  }
  writeRowApply(ctx.info.root, { records: [], files: [{ file: doctrine.name, before: source, after: lines.join(newline) }],
    signoffs: { before: null, receipts: [] } });
  return planned;
}
