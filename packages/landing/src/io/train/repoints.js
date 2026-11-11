/** Plan and apply exact check repairs for test files split by a native train landing [C7,H16]. */
import { isDefaultTestFile } from '../../../../gate/index.js';
import { listItems } from '../../../../store/index.js';
import { getItem } from '../../../../store/index.js';
import { COORDINATOR } from '../../../../config/index.js';
import { git } from '../../../../git/index.js';
import { Refused } from '../../../../kernel/index.js';

/** Split Git's NUL-delimited name-status stream without interpreting paths as shell text. */
function changedTests(root, base, tip) {
  const fields = git(root, ['diff', '--no-renames', '--name-status', '-z', base, tip, '--']).split('\0').filter(Boolean);
  const deleted = [], added = [];
  for (let index = 0; index + 1 < fields.length;) {
    const status = fields[index++];
    const path = fields[index++];
    if (status === 'D' && isDefaultTestFile(path)) deleted.push(path);
    else if (status === 'A' && isDefaultTestFile(path)) added.push(path);
  }
  return { deleted: [...new Set(deleted)].sort(), added: [...new Set(added)].sort() };
}

/** A split successor keeps the deleted test's directory, stem and test extension. */
function successorsFor(oldPath, added) {
  const match = /^(.*\/)?([^/]+)\.test\.(js|mjs)$/u.exec(oldPath);
  if (!match) return [];
  const directory = match[1] ?? '';
  const prefix = `${directory}${match[2]}-`;
  const suffix = `.test.${match[3]}`;
  return added.filter(path => path.startsWith(prefix) && !path.slice(directory.length).includes('/') && path.endsWith(suffix)
    && path.length > prefix.length + suffix.length).sort();
}

/** Tokenize shell words with their source spans; comments and quoted separators stay opaque. */
function shellWords(command) {
  const words = [];
  let value = '', start = -1, quote = '', escaped = false, segment = 0;
  const flush = end => { if (start >= 0) words.push({ value, start, end, segment }); value = ''; start = -1; };
  for (let index = 0; index < command.length; index += 1) {
    const character = command[index];
    if (escaped) { value += character; escaped = false; continue; }
    if (quote) {
      if (character === quote) quote = '';
      else if (character === '\\' && quote === '"') escaped = true;
      else value += character;
      continue;
    }
    if (character === '\\') { if (start < 0) start = index; escaped = true; continue; }
    if (character === "'" || character === '"') { if (start < 0) start = index; quote = character; continue; }
    if (character === '#' && start < 0) {
      while (index < command.length && command[index] !== '\n') index += 1;
      segment += 1;
      continue;
    }
    if (/\s/u.test(character)) { flush(index); if (character === '\n') segment += 1; continue; }
    if (';&|()<>'.includes(character)) {
      flush(index);
      if ((character === '&' || character === '|') && command[index + 1] === character) index += 1;
      segment += 1;
      continue;
    }
    if (start < 0) start = index;
    value += character;
  }
  flush(command.length);
  return { words, malformed: Boolean(quote || escaped) };
}

/** Shell-quote only literal paths accepted by the test-file classifier. */
function quotePath(path) { return `'${path.replaceAll("'", "'\\''")}'`; }

/** Replace exact named test arguments only in recognized Node test-runner commands. */
function rewriteCheck(check, pathMap) {
  const parsed = shellWords(check);
  if (parsed.malformed) return { error: 'the check has an unclosed quote or escape' };
  const bySegment = new Map();
  for (const word of parsed.words) {
    const list = bySegment.get(word.segment) ?? [];
    list.push(word);
    bySegment.set(word.segment, list);
  }
  const replacements = [];
  const found = new Set();
  for (const words of bySegment.values()) {
    const runner = words[0]?.value === 'node' && ['apps/cli/src/io/run/tests.js', './apps/cli/src/io/run/tests.js', '--test', '--test-force-exit'].includes(words[1]?.value);
    for (let index = 0; index < words.length; index += 1) {
      const word = words[index];
      const normalized = word.value.startsWith('./') ? word.value.slice(2) : word.value;
      const successors = pathMap.get(normalized);
      if (!successors) continue;
      found.add(normalized);
      if (!runner || index < 2 || words.slice(2, index).some(entry => entry.value.startsWith('-'))) {
        return { found: [...found], error: `the deleted path is not an unambiguous positional test argument in ${words[0]?.value ?? 'this command'}` };
      }
      const prefix = word.value.startsWith('./') ? './' : '';
      replacements.push({ start: word.start, end: word.end, text: successors.map(path => quotePath(prefix + path)).join(' ') });
    }
  }
  let result = check;
  for (const replacement of replacements.sort((a, b) => b.start - a.start)) {
    result = result.slice(0, replacement.start) + replacement.text + result.slice(replacement.end);
  }
  return { check: result, found: [...found] };
}

/** Seal check changes for one exact train base/tip; unsupported mappings stay visible by item ID. */
export function prepareTrainCheckRepointPlan(root, board, base, tip) {
  const { deleted, added } = changedTests(root, base, tip);
  if (!deleted.length) return null;
  const successors = new Map(deleted.map(path => {
    const candidates = successorsFor(path, added);
    return [path, candidates.length >= 2 ? candidates : []];
  }));
  const pathMap = new Map([...successors].filter(([, paths]) => paths.length).map(([path, paths]) => [path, paths]));
  const entries = [], blocked = [];
  for (const item of listItems(board)) {
    if (!['open', 'claimed', 'submitted'].includes(item.item_status)) continue;
    const check = item.item_check ?? '';
    const parsedWords = shellWords(check).words;
    const literalMentions = deleted.filter(path => parsedWords.some(word =>
      word.value === path || word.value === `./${path}`));
    const rewritten = rewriteCheck(check, pathMap);
    const mentions = rewritten.found ?? literalMentions.filter(path => pathMap.has(path));
    const unmapped = literalMentions.filter(path => !successors.get(path)?.length);
    if (!mentions.length && !unmapped.length) continue;
    const files = [...new Set([...mentions, ...unmapped])].sort();
    if (item.item_status === 'submitted') {
      const canRepoint = !rewritten.error && !unmapped.length && rewritten.check !== item.item_check;
      blocked.push({ id: item.item_id, status: item.item_status, previousCheck: item.item_check,
        ...(canRepoint ? { nextCheck: rewritten.check } : {}), files,
        ...(canRepoint ? { successors: files.flatMap(path => successors.get(path) ?? []) } : {}),
        reason: 'submitted checks require a review-safe correction path' });
    } else if (rewritten.error || unmapped.length || rewritten.check === item.item_check) {
      blocked.push({ id: item.item_id, status: item.item_status, files, reason: rewritten.error ?? 'no unambiguous split successors' });
    } else {
      entries.push({ id: item.item_id, status: item.item_status, previousCheck: item.item_check,
        nextCheck: rewritten.check, files, successors: files.flatMap(path => successors.get(path) ?? []) });
    }
  }
  if (!entries.length && !blocked.length) return null;
  return { version: 1, base, tip, entries, blocked };
}

/** Revalidate under the caller's enclosing ordered transaction and apply canonical editItem writes. */
export function applyTrainCheckRepointPlan(board, plan, editItemOperation) {
  if (!plan || plan.version !== 1 || !/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/u.test(plan.base ?? '')
    || !/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/u.test(plan.tip ?? '')
    || !Array.isArray(plan.entries) || !Array.isArray(plan.blocked)
    || plan.entries.some(entry => !Number.isSafeInteger(entry?.id) || entry.id < 1
      || typeof entry.previousCheck !== 'string' || typeof entry.nextCheck !== 'string'
      || !Array.isArray(entry.files) || !Array.isArray(entry.successors))
    || plan.blocked.some(entry => !Number.isSafeInteger(entry?.id) || entry.id < 1
      || typeof entry.reason !== 'string' || !Array.isArray(entry.files)
      || entry.previousCheck !== undefined && typeof entry.previousCheck !== 'string'
      || entry.nextCheck !== undefined && typeof entry.nextCheck !== 'string'
      || entry.successors !== undefined && !Array.isArray(entry.successors))) {
    throw new Refused('LAND_RECEIPT_UNBOUND', 'the sealed split-check plan is invalid; rebuild and gate the landing');
  }
  if (typeof editItemOperation !== 'function') throw new TypeError('split-check repointing needs the canonical editItem operation');
  const result = { applied: [], alreadyApplied: [], blocked: [...plan.blocked] };
  for (const entry of plan.entries) {
    const item = getItem(board, entry.id);
    if (item.item_check === entry.nextCheck) { result.alreadyApplied.push(entry.id); continue; }
    if (!['open', 'claimed'].includes(item.item_status) || item.item_check !== entry.previousCheck) {
      result.blocked.push({ id: entry.id, status: item.item_status, files: entry.files, reason: 'item status or check changed after the landing plan was sealed' });
      continue;
    }
    editItemOperation(board, entry.id, { agentId: COORDINATOR, check: entry.nextCheck,
      reason: `the landing split ${entry.files.join(', ')} into ${entry.successors.join(', ')}` });
    result.applied.push(entry.id);
  }
  for (const entry of plan.blocked) {
    if (typeof entry.previousCheck !== 'string' || typeof entry.nextCheck !== 'string') continue;
    const reportIndex = result.blocked.indexOf(entry);
    const item = getItem(board, entry.id);
    if (item.item_check === entry.nextCheck) {
      result.blocked.splice(reportIndex, 1);
      result.alreadyApplied.push(entry.id);
      continue;
    }
    if (item.item_check !== entry.previousCheck) {
      result.blocked[reportIndex] = { ...entry, status: item.item_status,
        reason: 'item check changed after the landing plan was sealed' };
      continue;
    }
    if (!['open', 'claimed'].includes(item.item_status)) {
      if (item.item_status !== 'submitted') result.blocked[reportIndex] = { ...entry, status: item.item_status,
        reason: 'item status changed after the landing plan was sealed' };
      continue;
    }
    editItemOperation(board, entry.id, { agentId: COORDINATOR, check: entry.nextCheck,
      reason: `the landing split ${entry.files.join(', ')} into ${entry.successors.join(', ')}` });
    result.blocked.splice(reportIndex, 1);
    result.applied.push(entry.id);
  }
  return result;
}
