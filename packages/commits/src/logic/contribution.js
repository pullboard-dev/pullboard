/**
 * A contribution record's machine part parses with a strict YAML subset and every refusal names its field, rule and fix [CR2,CR2a,CR5].
 *
 * The record is untrusted text from an outside issue or PR. The subset has top-level `key: value` lines, `key:` followed by
 * two-space `- item` lines, and `key: |` followed by two-space text lines (raw text, last). Anything else YAML allows is refused
 * by name, so no other reader of the same bytes can disagree about what the record says.
 */
import { Refused } from '../../../kernel/index.js';

export const CONTRIBUTION_SHAPES = Object.freeze(['Bug', 'Ask', 'Flaky', 'Performance', 'Fix', 'Proposal', 'Security']);
export const MAX_RECORD_BYTES = 16 * 1024;
export const MAX_CLAUSES = 50;
/** The most characters a record summary holds: RFC 0009 asks for 2-3 sentences of at most 20 words [CR1]. */
export const MAX_SUMMARY_CHARS = 600;

const ALL_BUT_ASK = ['Bug', 'Flaky', 'Performance', 'Fix', 'Proposal', 'Security'];
const FACTS = ['Bug', 'Security', 'Flaky', 'Performance'];

/** Which shapes may carry each key (the closed list of CR2), and whether the key is a list, text or a scalar. */
const FIELDS = Object.freeze({
  rows: { shapes: ALL_BUT_ASK, type: 'list' },
  env: { shapes: FACTS, type: 'scalar' },
  version: { shapes: FACTS, type: 'scalar' },
  ran: { shapes: ['Bug', 'Security'], type: 'scalar' },
  cause: { shapes: FACTS, type: 'scalar' },
  blocks: { shapes: ['Bug', 'Flaky', 'Performance'], type: 'scalar' },
  impact: { shapes: ['Security'], type: 'scalar' },
  disclose: { shapes: ['Security'], type: 'scalar' },
  test: { shapes: ['Flaky'], type: 'scalar' },
  rate: { shapes: ['Flaky'], type: 'scalar' },
  since: { shapes: ['Flaky', 'Performance'], type: 'scalar' },
  metric: { shapes: ['Performance'], type: 'scalar' },
  baseline: { shapes: ['Performance'], type: 'scalar' },
  measured: { shapes: ['Performance'], type: 'scalar' },
  refs: { shapes: ['Fix'], type: 'list' },
  draft: { shapes: ['Fix', 'Proposal'], type: 'scalar' },
  have: { shapes: ['Ask'], type: 'scalar' },
  want: { shapes: ['Ask'], type: 'scalar' },
  conflicts_with: { shapes: ['Proposal'], type: 'list' },
  decision_needed: { shapes: ['Proposal'], type: 'scalar' },
  forbidden: { shapes: ['Bug', 'Fix'], type: 'list' },
  compat: { shapes: ['Bug', 'Fix'], type: 'list' },
  status: { shapes: ['Fix', 'Proposal'], type: 'scalar' },
  bar: { shapes: ALL_BUT_ASK, type: 'list' },
  later_bar: { shapes: ['Proposal'], type: 'list' },
  check: { shapes: ALL_BUT_ASK, type: 'list' },
  evidence: { shapes: ['Fix'], type: 'list' },
  refusal: { shapes: ['Bug'], type: 'text' },
  error: { shapes: ['Bug'], type: 'text' },
});

/** The keys each shape must carry (CR2a); Bug also needs one of refusal or error, and any bar needs its check. */
const REQUIRED = Object.freeze({
  Bug: ['version', 'ran', 'blocks', 'bar', 'check'],
  Ask: ['have', 'want'],
  Fix: ['bar', 'check'],
  Proposal: ['rows', 'decision_needed', 'bar'],
  Security: ['version', 'impact', 'disclose', 'bar'],
  Flaky: ['test', 'rate', 'env', 'bar'],
  Performance: ['metric', 'baseline', 'measured', 'bar', 'check'],
});

const HIDDEN = /[­͏؜ᅟᅠ឴឵᠋-᠎​-‏‪-‮⁠-⁯ㅤ︀-️﻿ﾠ]/u;
const KEY = /^[a-z][a-z_]*$/u;
const ID = /^[A-Za-z0-9][A-Za-z0-9._:-]*$/u;

/** Refuse with the field, the rule broken and the fix in one message. */
function refuse(code, field, rule, fix) {
  return new Refused(code, `field "${field}": ${rule}; fix: ${fix}`, fix);
}

/** Read one scalar value: double quoted, single quoted, or plain text, refusing YAML features outside the subset. */
function scalar(raw, field) {
  const text = raw.trim();
  if (text.startsWith('"')) {
    let value;
    try { value = JSON.parse(text); } catch { value = undefined; }
    if (typeof value !== 'string') throw refuse('CONTRIB_QUOTE', field, 'a double-quoted value must be one closed JSON-style string', 'close the quote on the same line and escape inner quotes with a backslash');
    return value;
  }
  if (text.startsWith("'")) {
    if (text.length < 2 || !text.endsWith("'") || /[^']'[^']/u.test(text.slice(1, -1).replace(/''/gu, ''))) throw refuse('CONTRIB_QUOTE', field, 'a single-quoted value must be one closed string', "close the quote on the same line and double any inner ' mark");
    return text.slice(1, -1).replace(/''/gu, "'");
  }
  if (text.startsWith('&')) throw refuse('CONTRIB_ANCHOR', field, 'anchors are not allowed', 'write the value out in full instead of naming it with &');
  if (text.startsWith('*')) throw refuse('CONTRIB_ALIAS', field, 'aliases are not allowed', 'write the value out in full instead of pointing at it with *');
  if (text.startsWith('!')) throw refuse('CONTRIB_TAG', field, 'tags are not allowed', 'remove the ! tag and write a plain or quoted string');
  if (text.startsWith('[') || text.startsWith('{')) throw refuse('CONTRIB_FLOW', field, 'inline lists and maps are not allowed', 'write a list as "- item" lines under the key');
  if (/^[>|]/u.test(text)) throw refuse('CONTRIB_BLOCK', field, 'block text is allowed only for refusal and error', 'put the text on one line, quoted if it holds a colon');
  if (text.startsWith('<<')) throw refuse('CONTRIB_MERGE', field, 'merge keys are not allowed', 'write the value out in full');
  return text;
}

/** Refuse input the subset cannot trust before any line is read. */
function checkBytes(text) {
  if (typeof text !== 'string') throw refuse('CONTRIB_INPUT', 'record', 'the machine part must be text', 'pass the YAML block of the record as a string');
  if (Buffer.byteLength(text, 'utf8') > MAX_RECORD_BYTES) throw refuse('CONTRIB_SIZE', 'record', `the record is over ${MAX_RECORD_BYTES} bytes`, 'cut the record to 16 KB; keep constraints in fields and shorten the prose');
  if (HIDDEN.test(text)) throw refuse('CONTRIB_HIDDEN', 'record', 'bidirectional, zero-width and invisible characters are not allowed anywhere', 'delete the invisible characters and retype the line');
  if (text.includes('\0')) throw refuse('CONTRIB_HIDDEN', 'record', 'null bytes are not allowed', 'remove the null bytes');
}

/** Split into top-level entries: each key with its value text or its indented children. */
function entries(text) {
  const out = [], seen = new Set();
  let current = null;
  for (const [index, source] of text.replace(/\r\n?/gu, '\n').split('\n').entries()) {
    const where = `line ${index + 1}`;
    if (/^(---|\.\.\.)\s*$/u.test(source)) throw refuse('CONTRIB_MULTIDOC', where, 'document markers and multiple documents are not allowed', 'send one YAML block with no --- or ... lines');
    if (source.trim() === '') { if (current?.children.length) current.children.push({ where, text: '' }); continue; }
    if (source.match(/^\s*/u)[0].includes('\t')) throw refuse('CONTRIB_TAB', where, 'tabs are not allowed in indentation', 'indent with two spaces');
    if (source.startsWith('#')) continue;
    if (/^\s/u.test(source)) {
      if (current === null) throw refuse('CONTRIB_INDENT', where, 'an indented line has no key above it', 'start each field at the left edge');
      current.children.push({ where, text: source });
      continue;
    }
    const match = source.match(/^([^:\s][^:]*):(?:\s+(.*)|\s*)$/u);
    if (!match) throw refuse('CONTRIB_LINE', where, 'a line must be "key: value" or "key:" with indented items', 'write one field per line as key: value');
    const key = match[1];
    if (!KEY.test(key)) throw refuse('CONTRIB_KEY', key, 'keys are lowercase ASCII letters and underscores', 'rename the key to one of the closed field names');
    if (seen.has(key)) throw refuse('CONTRIB_DUPLICATE', key, 'the key appears twice', 'keep one copy of the key');
    seen.add(key);
    current = { key, where, value: match[2] ?? '', children: [] };
    out.push(current);
  }
  return out;
}

/** The value of one entry, shaped as its field type says. */
function valueOf(entry, spec) {
  const { key } = entry;
  const kids = entry.children.filter(child => child.text !== '' || spec.type === 'text');
  while (kids.length && kids.at(-1).text === '') kids.pop();
  if (spec.type === 'text') {
    if (/^\|[-+]?\s*$/u.test(entry.value)) {
      const rows = kids.map(child => {
        if (child.text !== '' && !child.text.startsWith('  ')) throw refuse('CONTRIB_INDENT', key, 'text lines indent by two spaces', 'indent every line of the text by two spaces');
        return child.text.slice(2);
      });
      return rows.join('\n');
    }
    if (kids.length) throw refuse('CONTRIB_BLOCK', key, 'multi-line text needs the | marker', `write "${key}: |" and indent the lines under it`);
    return scalar(entry.value, key);
  }
  if (spec.type === 'list') {
    if (/^[[{]/u.test(entry.value.trim())) scalar(entry.value, key);
    if (entry.value !== '') throw refuse('CONTRIB_LIST', key, 'this field is a list', `write "${key}:" then one "  - item" line per entry`);
    if (!kids.length) throw refuse('CONTRIB_LIST', key, 'the list is empty', `add "  - item" lines under ${key}, or delete the field`);
    return kids.map(child => {
      const item = child.text.match(/^ {2}- (.*)$/u);
      if (!item || item[1].trim() === '') throw refuse('CONTRIB_LIST', key, `${child.where} is not a "  - item" line`, 'indent by two spaces and start each entry with "- "');
      return scalar(item[1], key);
    });
  }
  if (kids.length) throw refuse('CONTRIB_NESTED', key, 'this field holds one value, not nested lines', `put the value on the ${key} line, or quote it`);
  if (entry.value.trim() === '') throw refuse('CONTRIB_EMPTY', key, 'the value is empty', `write a value after "${key}:" or delete the field`);
  return scalar(entry.value, key);
}

/** Per-field value rules that a closed vocabulary or a fixed form can state. */
function checkValue(key, value) {
  if (key === 'want' && !['guidance', 'feature'].includes(value)) throw refuse('CONTRIB_VALUE', key, 'want is guidance or feature', 'write want: guidance or want: feature');
  if (key === 'status' && !['failed', 'not_run', 'not_claimed'].includes(value)) throw refuse('CONTRIB_VALUE', key, 'status is failed, not_run or not_claimed', 'use one of those three words; the gate proves passes');
  if (key === 'draft' && !['true', 'false'].includes(value)) throw refuse('CONTRIB_VALUE', key, 'draft is true or false', 'write draft: true or draft: false');
  if (key === 'rate' && !/^\d+\/\d+$/u.test(value)) throw refuse('CONTRIB_VALUE', key, 'rate is <failures>/<runs>', 'write the counts like 3/20');
  if (key === 'rows' || key === 'conflicts_with') for (const id of value) if (!ID.test(id)) throw refuse('CONTRIB_ID', key, `"${id}" is not an ASCII row id`, 'use ids such as G1.2 with letters, digits, dots, colons and hyphens');
  if (key === 'refs') for (const id of value) if (!/^#?\d+$/u.test(id)) throw refuse('CONTRIB_ID', key, `"${id}" is not an issue number`, 'list same-repo issue numbers such as 42');
}

/** The numbered clause an entry of bar, check or evidence belongs to, or null. */
function clauseNumber(line) {
  return line.match(/^(\d+):\s+\S/u)?.[1] ?? null;
}

/**
 * Parse a record's YAML block for one shape, or refuse naming the field, the rule and the fix.
 * Why: the gate and the skill call this one function, so a record means the same thing wherever it is read [CR2,CR2a,CR5].
 *
 * @param {string} text - The YAML block of the record.
 * @param {string} shape - One of CONTRIBUTION_SHAPES; the template sets it, the record never names it.
 * @returns {{ shape: string, fields: Record<string, string | string[]> }}
 */
export function parseContributionRecord(text, shape) {
  if (!CONTRIBUTION_SHAPES.includes(shape)) throw refuse('CONTRIB_SHAPE', 'shape', `"${shape}" is not a record shape`, `use one of ${CONTRIBUTION_SHAPES.join(', ')}`);
  checkBytes(text);
  const fields = {};
  for (const entry of entries(text)) {
    const spec = FIELDS[entry.key];
    if (!spec) throw refuse('CONTRIB_KEY', entry.key, 'the key is not in the closed field list', 'delete it, or move its content into a listed field or the summary');
    if (!spec.shapes.includes(shape)) throw refuse('CONTRIB_KEY', entry.key, `${shape} records do not carry this key`, `delete it; it belongs to ${spec.shapes.join(', ')}`);
    const value = valueOf(entry, spec);
    checkValue(entry.key, value);
    fields[entry.key] = value;
  }
  for (const key of REQUIRED[shape]) if (!(key in fields)) throw refuse('CONTRIB_REQUIRED', key, `${shape} records require this field`, `add ${key} to the record`);
  if (shape === 'Bug' && !('refusal' in fields) && !('error' in fields)) throw refuse('CONTRIB_REQUIRED', 'refusal', 'Bug records need the exact refusal or error text', 'add refusal: or error: with the text, last');
  if (fields.bar && !fields.check) throw refuse('CONTRIB_REQUIRED', 'check', 'every bar clause needs a check', 'add check with one "n: command" line per clause');
  if (fields.bar && fields.bar.length > MAX_CLAUSES) throw refuse('CONTRIB_CLAUSES', 'bar', `${fields.bar.length} clauses is over the ${MAX_CLAUSES} limit`, 'merge or drop clauses until there are at most 50');
  if (fields.check) {
    const checked = new Set(fields.check.map(clauseNumber));
    for (const line of fields.bar ?? []) {
      const n = clauseNumber(line);
      if (n === null) throw refuse('CONTRIB_CLAUSE', 'bar', `"${line.slice(0, 40)}" does not start with "n: "`, 'write each clause as "1: what must hold [kind]"');
      if (!checked.has(n)) throw refuse('CONTRIB_REQUIRED', 'check', `bar clause ${n} has no check`, `add "${n}: <command>" to check`);
    }
  }
  return { shape, fields };
}

/**
 * Every failure a contribution record can return maps to a rule, a fix line and the skill command that fixes it [CR5].
 *
 * Why: the gate comment names the rule, the fix and the command for each failure (RFC 0009), so the table is data
 * and a test fails when a refusal code in the parser or the clause runner has no row here.
 */

/** The skill command that re-reads a record after the fix. */
export const CONTRIBUTION_CHECK_COMMAND = 'pullboard contribute check <file>';

/** One row per refusal code: the rule broken, the fix, and the skill command. */
export const CONTRIBUTION_FIXES = Object.freeze({
  CONTRIB_INPUT: Object.freeze({ rule: 'the machine part must be text', fix: 'pass the YAML block of the record as text', command: CONTRIBUTION_CHECK_COMMAND }),
  CONTRIB_SIZE: Object.freeze({ rule: 'a record is at most 16 KB', fix: 'cut the record to 16 KB; keep constraints in fields and shorten the prose', command: CONTRIBUTION_CHECK_COMMAND }),
  CONTRIB_HIDDEN: Object.freeze({ rule: 'no bidirectional, zero-width, invisible or null characters anywhere', fix: 'delete the invisible characters and retype the line', command: CONTRIBUTION_CHECK_COMMAND }),
  CONTRIB_SHAPE: Object.freeze({ rule: 'a record has one of the seven shapes', fix: 'use Bug, Ask, Flaky, Performance, Fix, Proposal or Security', command: CONTRIBUTION_CHECK_COMMAND }),
  CONTRIB_MULTIDOC: Object.freeze({ rule: 'one YAML document, no --- or ... lines', fix: 'send one YAML block with no document markers', command: CONTRIBUTION_CHECK_COMMAND }),
  CONTRIB_TAB: Object.freeze({ rule: 'indent with spaces, never tabs', fix: 'indent with two spaces', command: CONTRIBUTION_CHECK_COMMAND }),
  CONTRIB_INDENT: Object.freeze({ rule: 'an indented line belongs under a key, in two-space steps', fix: 'start each field at the left edge and indent children by two spaces', command: CONTRIBUTION_CHECK_COMMAND }),
  CONTRIB_LINE: Object.freeze({ rule: 'a line is key: value or key: with indented items', fix: 'write one field per line as key: value', command: CONTRIBUTION_CHECK_COMMAND }),
  CONTRIB_SECRET: Object.freeze({ rule: 'a record holds no secret-looking value', fix: 'delete the key or token from the record and rotate it if it was real', command: CONTRIBUTION_CHECK_COMMAND }),
  CONTRIB_KEY: Object.freeze({ rule: 'keys come from the closed field list for the shape', fix: 'delete the key, or move its content into a listed field or the summary', command: CONTRIBUTION_CHECK_COMMAND }),
  CONTRIB_DUPLICATE: Object.freeze({ rule: 'a key appears once', fix: 'keep one copy of the key', command: CONTRIBUTION_CHECK_COMMAND }),
  CONTRIB_REQUIRED: Object.freeze({ rule: 'each shape carries its required fields, and every bar clause its check', fix: 'add the missing field or check line', command: CONTRIBUTION_CHECK_COMMAND }),
  CONTRIB_EMPTY: Object.freeze({ rule: 'a field has a value', fix: 'write a value after the key or delete the field', command: CONTRIBUTION_CHECK_COMMAND }),
  CONTRIB_NESTED: Object.freeze({ rule: 'a scalar field holds one value', fix: 'put the value on the key line, or quote it', command: CONTRIBUTION_CHECK_COMMAND }),
  CONTRIB_LIST: Object.freeze({ rule: 'a list field is a key then two-space - item lines', fix: "write the key, then one '  - item' line per entry", command: CONTRIBUTION_CHECK_COMMAND }),
  CONTRIB_BLOCK: Object.freeze({ rule: 'block text is only for refusal and error, marked with |', fix: "put the text on one line, or write 'key: |' and indent the lines", command: CONTRIBUTION_CHECK_COMMAND }),
  CONTRIB_QUOTE: Object.freeze({ rule: 'a quoted value is one closed string', fix: 'close the quote on the same line and escape inner quotes', command: CONTRIBUTION_CHECK_COMMAND }),
  CONTRIB_ANCHOR: Object.freeze({ rule: 'YAML anchors are not allowed', fix: 'write the value out in full', command: CONTRIBUTION_CHECK_COMMAND }),
  CONTRIB_ALIAS: Object.freeze({ rule: 'YAML aliases are not allowed', fix: 'write the value out in full', command: CONTRIBUTION_CHECK_COMMAND }),
  CONTRIB_TAG: Object.freeze({ rule: 'YAML tags are not allowed', fix: 'remove the tag and write a plain or quoted string', command: CONTRIBUTION_CHECK_COMMAND }),
  CONTRIB_FLOW: Object.freeze({ rule: 'inline lists and maps are not allowed', fix: "write a list as '  - item' lines under the key", command: CONTRIBUTION_CHECK_COMMAND }),
  CONTRIB_MERGE: Object.freeze({ rule: 'merge keys are not allowed', fix: 'write the value out in full', command: CONTRIBUTION_CHECK_COMMAND }),
  CONTRIB_VALUE: Object.freeze({ rule: 'a field with a closed vocabulary or fixed form takes only that', fix: 'use a listed value, such as want: guidance or rate: 3/20', command: CONTRIBUTION_CHECK_COMMAND }),
  CONTRIB_ID: Object.freeze({ rule: 'row and issue ids are plain ASCII', fix: 'use ids such as G1.2 for rows and 42 for issues', command: CONTRIBUTION_CHECK_COMMAND }),
  CONTRIB_CLAUSE: Object.freeze({ rule: 'each bar clause starts with its number', fix: "write each clause as '1: what must hold [kind]'", command: CONTRIBUTION_CHECK_COMMAND }),
  CONTRIB_CLAUSES: Object.freeze({ rule: 'a record has at most 50 bar clauses', fix: 'merge or drop clauses until there are at most 50', command: CONTRIBUTION_CHECK_COMMAND }),
  CLAUSE_NUMBER: Object.freeze({ rule: 'each bar clause starts with its number', fix: "write each clause as '1: what must hold [kind]'", command: CONTRIBUTION_CHECK_COMMAND }),
  CLAUSE_KIND: Object.freeze({ rule: 'a clause ends with its kind, or its check is none with a reason', fix: 'end the clause with [test], [test, kept], [command] or [measurement]', command: CONTRIBUTION_CHECK_COMMAND }),
  CLAUSE_NONE_REASON: Object.freeze({ rule: 'a check of none says why', fix: "write 'none: <why the gate cannot run it here>'", command: CONTRIBUTION_CHECK_COMMAND }),
  CLAUSE_PATH: Object.freeze({ rule: 'a path names a file inside the repository', fix: 'use a relative path with no .. segment, and no symlink out of the repository', command: CONTRIBUTION_CHECK_COMMAND }),
  CLAUSE_TEST_CHECK: Object.freeze({ rule: "a test check is '<test file> > <test name>'", fix: "write the check as '<test file in repo> > <test name>'", command: CONTRIBUTION_CHECK_COMMAND }),
  CLAUSE_COMMAND_EMPTY: Object.freeze({ rule: 'a command check is not empty', fix: 'write the command the gate should run', command: CONTRIBUTION_CHECK_COMMAND }),
  CLAUSE_COMMAND_SYNTAX: Object.freeze({ rule: 'a check command is plain words with no shell syntax', fix: 'remove the shell syntax and use plain words and repository paths', command: CONTRIBUTION_CHECK_COMMAND }),
  CLAUSE_NOT_ALLOWLISTED: Object.freeze({ rule: "a check command is on the repository's allowlist", fix: 'use a command the repository allowlists', command: CONTRIBUTION_CHECK_COMMAND }),
  CLAUSE_THRESHOLD: Object.freeze({ rule: 'a measurement clause states its threshold', fix: "state it in the clause, such as 'under 100 ms' or 'at most 3'", command: CONTRIBUTION_CHECK_COMMAND }),
  CLAUSE_GIT: Object.freeze({ rule: 'the clause runner needs a repository holding base and head', fix: 'pass a repository that holds both commits', command: CONTRIBUTION_CHECK_COMMAND }),
  CLAUSE_NODE_PIN: Object.freeze({ rule: 'the clause runner uses its pinned Node', fix: 'run the gate with the pinned Node version', command: CONTRIBUTION_CHECK_COMMAND }),
  CLAUSE_SCRATCH: Object.freeze({ rule: 'the scratch folder is an empty absolute path outside the repository', fix: 'pass an empty absolute folder outside the repository', command: CONTRIBUTION_CHECK_COMMAND }),
});

/**
 * The rule, fix line and skill command for a refusal code, or null when the code has no row.
 *
 * @param {string} code - A CONTRIB_ or CLAUSE_ refusal code.
 * @returns {{ rule: string, fix: string, command: string } | null}
 */
export function contributionFix(code) {
  return Object.hasOwn(CONTRIBUTION_FIXES, code) ? CONTRIBUTION_FIXES[code] : null;
}
