/**
 * The spec (S1–S5): SPEC.md as rows with ids, read the way a person writes it and checked the way
 * an agent needs it. One row per line, so every id greps to exactly one line:
 *
 *   - G1.2 [approved, must] Same file twice is a no-op. | gate: idempotency test | serves: G1
 *
 * Also here: the frozen criterion an item is verified against (V2), and sign-offs, a person's word
 * that a row is met, kept with the text they read (S5).
 */
import { posix } from 'node:path';
import { createHash } from 'node:crypto';
import { spawnSync } from './windows-child-process.js';
import {
  appendFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
} from 'node:fs';
import {
  dirname,
  join,
} from 'node:path';
import {
  DOCTRINE_FILE,
  LEGACY_DOCTRINE_FILE,
} from './config.js';
import { cleanGitEnvironment } from './git.js';
import { Refused } from './refused.js';
import { headerRows } from './commit-message.js';
import {
  parseRowVerification,
  rowVerificationFormatProblems,
} from './spec-verdict-format.js';
import {
  renamedGatePath,
  revisionGateCommand,
} from './spec-gate-renames.js';
import {
  hasSignerFile,
  isVerifiedSignoff,
  readRawRecords,
  signRows,
  verifySignedRecords,
} from './signature.js';

export const STATUSES = ['approved', 'draft', 'pending', 'fact', 'wont', 'retired'];
export const TIERS = ['must', 'aim'];
export const SIGNOFFS_FILE = '.pullboard/signoffs.jsonl';
/** Shared SPEC.md/PRACTICE.md row grammar; bump for incompatible persisted format changes. */
export const SPEC_GRAMMAR_VERSION = 1;

const ID = '[A-Za-z]+\\d+(?:\\.\\d+)*';
export const ID_RE = new RegExp(`^${ID}$`);
const ROW_RE = new RegExp(`^- (${ID}) \\[([a-z]+)(?:,\\s*([a-z]+))?\\]\\s+(.+)$`);
const ROWISH_RE = new RegExp(`^- ${ID}\\s+\\[`);
const SECTION_RE = /^##\s+(.+)$/;
const SIGNER_RE = /^(?!#)[^\s,]+$/u;
const LEGACY_SIGNER_RE = /^[A-Z][A-Za-z]{1,11}$/;

const FIELD_NAMES = ['gate', 'serves', 'signers', 'count', 'runs', 'mode', 'files', 'source', 'verify'];
const CHECK_FIELDS = ['count', 'runs', 'mode', 'files'];

/** Replace the complete gate field, including check pipelines, while preserving other row fields. */
export function replaceRowGate(source, gate) {
  const field = new RegExp(`(\\|\\s*gate\\s*:\\s*)(.*?)(?=\\|\\s*(?:${FIELD_NAMES.join('|')})\\s*:|$)`, 'u');
  return field.test(source) ? source.replace(field, (_, start, old) => `${start}${gate}${old.match(/\s*$/u)?.[0] ?? ''}`)
    : `${source.trimEnd()} | gate: ${gate}`;
}

/**
 * One row's trailing fields, after the text: `| gate: ...`, `| serves: a, b` and `| signers: CO,AB`.
 * A doctrine rule may add `| count: N`, `| runs: nightly`, `| mode: watch` and `| files: <paths>`
 * to a `gate: check`;
 * those keys appear on the row only when written, so rows without them parse exactly as before.
 * Any row may add `| source: <name> <id> <url>`, the reference a blueprint rule came from; it too
 * appears only when written.
 * A check command may itself contain ` | `: a part that names no known field continues it.
 *
 * @param {string} rest
 * @returns {{ text: string, gate: string, serves: string[], signers: string[], unknown: string[], count?: string, runs?: string, mode?: string, files?: string, source?: string }}
 */
function splitFields(rest) {
  const [text = '', ...parts] = rest.split(' | ');
  const fields = { text: text.trim(), gate: '', serves: [], signers: [], unknown: [] };
  let inCheck = false;
  let verdictReason = false;
  for (const part of parts) {
    if (verdictReason) {
      fields.verify = parseRowVerification(fields.verify, part.trim());
      verdictReason = false;
      continue;
    }
    const [key = '', ...value] = part.split(':');
    const joined = value.join(':').trim();
    if (inCheck && !FIELD_NAMES.includes(key.trim())) {
      fields.gate += ` | ${part.trim()}`;
      continue;
    }
    inCheck = false;
    if (key.trim() === 'verify') {
      if (Object.hasOwn(fields, 'verify')) fields.unknown.push('duplicate verify field');
      fields.verify = joined;
      verdictReason = true;
    } else if (key.trim() === 'gate') {
      fields.gate = joined;
      inCheck = /^check(\s|$)/u.test(joined);
    } else if (CHECK_FIELDS.includes(key.trim()) || key.trim() === 'source') fields[key.trim()] = joined;
    else if (key.trim() === 'serves') {
      fields.serves = joined.split(',').map((id) => id.trim()).filter(Boolean);
    } else if (key.trim() === 'signers') {
      fields.signers = joined.split(',').map((signer) => signer.trim()).filter(Boolean);
    } else fields.unknown.push(part.trim());
  }
  if (verdictReason) fields.verify = parseRowVerification(fields.verify, '');
  return fields;
}

/**
 * Read SPEC.md text into its title, intro, sections and rows. Lines that look like rows but do not
 * parse are kept as problems, never dropped silently.
 *
 * @param {string} source
 * @param {{ strictGrammarVersion?: boolean }} [options] - Historical text is parsed for ids without enforcing its marker.
 * @returns {{ grammarVersion: number, title: string, intro: string[], sections: any[], rows: any[], problems: any[] }}
 */
export function parseSpec(source, { strictGrammarVersion = true } = {}) {
  const spec = { grammarVersion: SPEC_GRAMMAR_VERSION, title: '', intro: [], sections: [], rows: [], problems: [] };
  let section = null;
  let fence = '';
  source.split(/\r?\n/).forEach((line, index) => {
    const lineNo = index + 1;
    const marker = /^ {0,3}(`{3,}|~{3,})(.*)$/u.exec(line);
    if (fence) {
      if (marker && marker[1][0] === fence[0] && marker[1].length >= fence.length && !marker[2].trim()) fence = '';
      return;
    }
    if (marker && (marker[1][0] === '~' || !marker[2].includes('`'))) {
      fence = marker[1];
      return;
    }
    const grammar = /^\uFEFF?\s*<!--\s*pullboard-grammar(?:\s+(.*?))?\s*-->\s*$/.exec(line);
    if (grammar) {
      const declared = grammar[1]?.trim() ?? '';
      const valid = /^\d+$/u.test(declared);
      if (strictGrammarVersion && (!valid || BigInt(declared) !== BigInt(SPEC_GRAMMAR_VERSION))) {
        const found = valid ? declared : 'invalid';
        throw new Refused(
          'A5_GRAMMAR_VERSION',
          `grammar ${found} is not supported; this Pullboard reads grammar ${SPEC_GRAMMAR_VERSION}; upgrade Pullboard or use a file written for grammar ${SPEC_GRAMMAR_VERSION}`,
        );
      }
      return;
    }
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
 * Return the commit immediately before the canonical doctrine file was renamed from its legacy
 * path. A staged rename uses HEAD; a committed rename uses that rename commit's first parent.
 * Reading both files at this revision prevents later coordinator edits from becoming grandfathered.
 *
 * @param {string} root
 * @param {string} name
 * @returns {string | null}
 */
export function legacyDoctrineRenameBase(root, name) {
  if (name !== DOCTRINE_FILE) return null;
  const options = {
    cwd: root,
    env: cleanGitEnvironment(),
    encoding: 'utf8',
    maxBuffer: 8 * 1024 * 1024,
    stdio: 'pipe',
  };
  const changed = spawnSync('git', [
    '--no-replace-objects', '-c', 'core.quotepath=false',
    'diff', '--name-status', '--find-renames', 'HEAD', '--', LEGACY_DOCTRINE_FILE, DOCTRINE_FILE,
  ], options);
  if (changed.status === 0 && /^R\d*\tPRACTICE\.md\tDOCTRINE\.md$/mu.test(changed.stdout)) {
    const head = spawnSync('git', ['rev-parse', '--verify', 'HEAD'], options);
    return head.status === 0 ? head.stdout.trim() : null;
  }
  const history = spawnSync('git', [
    '--no-replace-objects', '-c', 'core.quotepath=false',
    'log', '--follow', '--name-status', '--find-renames', '--format=%H %P', '--', DOCTRINE_FILE,
  ], options);
  if (history.status !== 0) return null;
  const rename = history.stdout.match(/^([0-9a-f]{40}) ([0-9a-f]{40})(?: [0-9a-f]{40})?\n\nR\d*\tPRACTICE\.md\tDOCTRINE\.md$/mu);
  return rename?.[2] ?? null;
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
  // A rule's reason (" Why: ...") and a question's choices (" Choices: ...") ride on the row and
  // are not counted: the limit keeps the requirement itself short (blueprint rows carry both).
  const words = row.text.split(/ (?:Why|Choices): /u)[0].split(/\s+/).filter(Boolean).length;
  if (words > maxWords) add('warning', `${words} words; rows stay under ${maxWords}, the why goes elsewhere`);
  for (const part of row.unknown) add('error', `unknown field "${part}"; fields are gate, serves, signers, count, runs, mode, files, source and verify`);
  if (row.source !== undefined && !row.source.trim()) add('error', 'source names where the row came from; leave it out when the row has none');
  for (const message of rowVerificationFormatProblems(row.verify)) add('error', message);
  findings.push(...checkFieldFindings(row).map((message) => ({ level: 'error', line: row.line, id: row.id, message })));
  return findings;
}

/**
 * Problems with a row's check fields: a `gate: check` names its command and a whole-number count,
 * `runs` is submit or nightly, `mode` is hold or watch, `files` names paths, and none of them
 * stands without a check.
 *
 * @param {any} row
 * @returns {string[]}
 */
export function checkFieldFindings(row) {
  const isCheck = /^check(\s|$)/u.test(row.gate ?? '');
  const problems = [];
  if (!isCheck) {
    if (CHECK_FIELDS.some((key) => row[key] !== undefined)) problems.push('count, runs, mode and files belong to a row whose gate is check <command>');
    return problems;
  }
  if (!row.gate.slice('check'.length).trim()) problems.push('gate: check names the command that prints one line per problem');
  if (row.count === undefined) problems.push('a check row names its committed count: | count: N');
  else if (!/^\d+$/u.test(row.count)) problems.push(`count "${row.count}" is a whole number`);
  if (row.runs !== undefined && !['submit', 'nightly'].includes(row.runs)) problems.push(`runs "${row.runs}" is submit or nightly`);
  if (row.mode !== undefined && !['hold', 'watch'].includes(row.mode)) problems.push(`mode "${row.mode}" is hold or watch`);
  if (row.files !== undefined && !row.files.trim()) problems.push('files names the repo paths the rule covers; leave it out to cover the whole repo');
  return problems;
}

/** A repo path with a known extension, as a whole word in a gate (#809). */
const GATE_FILE_RE = /(?:^|\s)((?:[\w.-]+\/)*[\w.-]+\.(?:js|mjs|cjs|sh|md|json|yml))(?=\s|$)/gu;

/**
 * The repo files a row's gate names, such as `test/board.test.js` or `bin/checks/file-size.js`. A gate
 * word without a path, such as `review` or `true`, names no file to check. Each path is normalized, so
 * ./test/a.test.js and test/x/../a.test.js name test/a.test.js, the spelling Git reports for a deletion (#809).
 *
 * @param {string | undefined} gate
 * @returns {string[]}
 */
export function gateFiles(gate) {
  return [...String(gate ?? '').matchAll(GATE_FILE_RE)].map((match) => posix.normalize(match[1]));
}

/**
 * The commit that last held a file anywhere in the repository's history, or '' when no commit ever did (#809).
 * A file that was committed and is gone now is a lost test; one never committed is a test not written yet.
 *
 * @param {string} root
 * @param {string} file
 * @returns {string}
 */
function lastCommitOf(root, file) {
  const result = spawnSync('git', ['log', '--all', '-n', '1', '--format=%h', '--', file], { cwd: root, encoding: 'utf8', env: cleanGitEnvironment() });
  return result.status === 0 ? result.stdout.trim() : '';
}

/**
 * Findings for each row whose gate names a file the repo does not have (#809). An approved must-row whose file
 * was committed and is gone is an error that names the removal, so spec check fails; a file never committed is
 * a warning that the test is not written yet, so a new project's README example still fits. Every other row
 * only warns.
 *
 * @param {any} spec - a parsed spec
 * @param {string} root - the repo root the gate paths resolve against
 * @returns {{ level: string, line: number, id: string, message: string }[]}
 */
export function missingGateFindings(spec, root) {
  const findings = [];
  for (const row of spec.rows) {
    for (const file of gateFiles(row.gate)) {
      if (existsSync(join(root, file))) continue;
      const lost = lastCommitOf(root, file);
      if (row.status === 'approved' && row.tier === 'must' && lost) {
        const renamed = renamedGatePath(root, file);
        const revisedGate = renamed ? row.gate.replace(GATE_FILE_RE, (match, path) => posix.normalize(path) === file ? match.slice(0, match.length - path.length) + renamed : match) : null;
        const next = renamed ? `renamed to ${renamed}; propose the change: ${revisionGateCommand(row, revisedGate, file, renamed)}` : 'restore it or point the row at its new home';
        findings.push({ level: 'error', line: row.line, id: row.id, message: `gate file ${file} was removed from the repository (last in ${lost}); ${next}` });
      } else {
        findings.push({ level: 'warning', line: row.line, id: row.id, message: `gate file ${file} does not exist yet; write the test it names` });
      }
    }
  }
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
 * The next free row id under a section prefix: one past the highest number the prefix uses, skipping
 * any id already taken. Callers pass the rows of SPEC.md and the doctrine, so ids stay unique across
 * both files (spec draft, blueprint add).
 *
 * @param {string} prefix
 * @param {{ id: string }[]} rows
 * @returns {string}
 */
export function nextRowId(prefix, rows) {
  const used = new Set(rows.map((row) => row.id));
  const numbered = rows.map((row) => new RegExp(`^${prefix}(\\d+)$`, 'u').exec(row.id)?.[1]).filter(Boolean).map(Number);
  let next = Math.max(0, ...numbered) + 1;
  while (used.has(`${prefix}${next}`)) next += 1;
  return `${prefix}${next}`;
}

/**
 * Insert row lines into spec text under one section: after its last line of content, before the
 * next heading (spec draft, blueprint add).
 *
 * @param {string} source
 * @param {{ sections: { line: number }[] }} spec - The parse of source.
 * @param {{ line: number }} section
 * @param {string[]} rows
 * @returns {string}
 */
export function insertSectionRows(source, spec, section, rows) {
  const newline = source.includes('\r\n') ? '\r\n' : '\n';
  const lines = source.split(/\r?\n/u);
  const following = spec.sections.find((entry) => entry.line > section.line);
  let insertion = following ? following.line - 1 : lines.length;
  while (insertion > section.line && !lines[insertion - 1].trim()) insertion -= 1;
  lines.splice(insertion, 0, ...rows);
  return lines.join(newline);
}

/**
 * The spec ids an item or a commit cites, checked against the spec: every one must exist, and a
 * retired row or one marked wont (won't build) cannot be built against.
 *
 * @param {ReturnType<typeof parseSpec>} spec
 * @param {string[]} ids
 * @param {ReturnType<import('./doctrine.js').loadDoctrine>} [doctrine]
 * @returns {string[]} Problems; empty when every id is live.
 */
export function idProblems(spec, ids, doctrine = null) {
  const byId = new Map(spec.rows.map((row) => [row.id, row]));
  return ids.flatMap((id) => {
    const prefix = 'doctrine:';
    const namespaced = id.startsWith(prefix);
    const rawId = namespaced ? id.slice(prefix.length) : id;
    if (id.includes(':') && !namespaced) return [`${id} uses an unknown namespace; use doctrine:<id> for a doctrine row`];
    const row = namespaced
      ? doctrine?.rows.find((entry) => entry.id === rawId)
      : byId.get(rawId);
    if (!row) return [`${id} is not in ${namespaced ? 'doctrine' : spec.name ?? 'the spec'}`];
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
 * @param {ReturnType<import('./doctrine.js').loadDoctrine>} [doctrine]
 * @returns {{ text: string, digest: string }}
 */
export function frozenCriterion(spec, item, doctrine = null) {
  const ids = item.item_spec_ids ? item.item_spec_ids.split(',') : [];
  const problems = idProblems(spec, ids, doctrine);
  if (problems.length) throw new Refused('UNKNOWN_SPEC', `${problems.join('; ')}; fix the spec, or the coordinator withdraws the item`);
  const rows = ids.map((id) => {
    const [namespace, rawId] = id.startsWith('doctrine:') ? ['doctrine', id.slice('doctrine:'.length)] : ['spec', id];
    const row = namespace === 'doctrine'
      ? doctrine.rows.find((entry) => entry.id === rawId)
      : spec.rows.find((entry) => entry.id === rawId);
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
  return verifySignedRecords(root, readRawRecords(root));
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
  const required = new Set(rows.filter((row) => row.signers?.length).map((row) => row.id));
  const by = new Map();
  for (const signoff of signoffs) {
    if (required.has(signoff.id) && !isVerifiedSignoff(signoff)) continue;
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
 * Record a person's sign-off on approved rows, with the text they read (S5). Legacy receipts keep
 * initials or a name; SSH receipts name the exact principal in the key's allowed-signers entry.
 *
 * @param {string} root
 * @param {ReturnType<typeof parseSpec>} spec
 * @param {{ ids: string[], by: string, on: string, note?: string, commit?: string }} signoff
 * @returns {number} How many rows were signed.
 */
export function signOff(root, spec, { ids, by, on, note = '', commit = '' }) {
  const ssh = hasSignerFile(root);
  if (!(ssh ? SIGNER_RE : LEGACY_SIGNER_RE).test(by)) {
    throw new Refused('BAD_SIGNER', ssh ? 'sign with one principal: --by <principal>' : 'sign with initials or a first name: --by CO');
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
  if (ssh) {
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
 * Spec ids cited at the end of a commit header: `feat(x): subject [G1.2,K3]`. A landing header's
 * `+N` stands for rows only its trailer names, so it is not an id; the shared parser reads both.
 *
 * @param {string} header
 * @returns {string[]}
 */
export function citedIds(header) {
  return headerRows(header).shown;
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
  const kept = new Set(parseSpec(after, { strictGrammarVersion: false }).rows.map((row) => row.id));
  return parseSpec(before, { strictGrammarVersion: false }).rows.map((row) => row.id).filter((id) => !kept.has(id));
}
