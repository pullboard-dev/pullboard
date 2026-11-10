import { Refused } from './refused.js';
/** Accepted project registry obligations survive import-selection deferral [C7,V4,V16]. */

/** A literal repository path, or an input glob using only *, ** and ?. */
function projectPath(value, glob = false) {
  return typeof value === 'string' && value.trim() === value && value.length > 0
    && !/[:\\\p{Cc}]/u.test(value) && !/[\[\]{}]/u.test(value)
    && (glob || !/[*?]/u.test(value))
    && value.split('/').every(part => part && part !== '.' && part !== '..');
}

/** Reject ambiguous configuration rather than silently dropping a registry obligation. */
export function registryGuardsProblem(rules) {
  if (!Array.isArray(rules) || rules.some(rule => !rule || typeof rule !== 'object' || Array.isArray(rule)
    || Object.keys(rule).some(key => !['inputs', 'tests'].includes(key))
    || !Array.isArray(rule.inputs) || !rule.inputs.length || rule.inputs.some(path => !projectPath(path, true))
    || !Array.isArray(rule.tests) || !rule.tests.length || rule.tests.some(path => !projectPath(path)))) {
    return '"registryGuards" is a list of {inputs: [repository globs using *, ** or ?], tests: [literal repository test paths]}';
  }
  return null;
}

/** Match the entire repository-relative path, allowing recursive globs to cover no directories. */
function matches(path, glob) {
  const source = glob.split(/(\*\*\/|\*\*|\*|\?)/u).map(part => part === '**/' ? '(?:.*/)?' : part === '**' ? '.*'
    : part === '*' ? '[^/]*' : part === '?' ? '[^/]' : part.replace(/[.+^$()|[\]{}\\]/gu, '\\$&')).join('');
  return new RegExp(`^${source}$`, 'u').test(path);
}

/** Select from the same merge base as affected tests; the caller supplies its Git operation [C7,D3]. */
export function selectRegistryGuards(root, rules = [], { base, trunk, commit = 'HEAD', changed, git } = {}) {
  if (!rules.length) return [];
  if (trunk) {
    const mergeBase = git(root, ['merge-base', trunk, commit]).trim();
    const submitted = git(root, ['rev-parse', '--verify', `${commit}^{commit}`]).trim();
    if (mergeBase !== submitted) base = mergeBase;
    changed = undefined;
  }
  // No base is uncertainty, never evidence that none of the registries changed.
  if (base) changed ??= git(root, ['diff', '--no-renames', '--name-only', '-z', base, commit]).split('\0').filter(Boolean);
  return [...new Set(rules.filter(rule => !base || changed.some(path => rule.inputs.some(glob => matches(path, glob))))
    .flatMap(rule => rule.tests))].sort();
}


/** One immutable identity resolver is shared by every cross-board interface [E32,H16]. */

/** Refuse an ambiguous or untrusted reference before choosing any board. */
function invalid() { throw new Refused('BOARD_REFERENCE', 'use an immutable board ID or one exact qualified name from the authorized project inventory'); }

/** Validate an immutable board ID without treating a display name or local path as authority. */
export function boardReferenceId(value) {
  if (typeof value !== 'string' || !/^[0-9a-f]{32}$/u.test(value)) invalid();
  return value;
}

/** Preserve exact qualified-name bytes rather than silently renaming a signed board. */
function name(value) {
  if (typeof value !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/u.test(value)) invalid();
  return value;
}

/** Copy only the canonical public BoardRef fields. */
export function boardReference(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)
      || Object.keys(value).some(key => !['boardId', 'organization', 'handle'].includes(key))) invalid();
  return { boardId: boardReferenceId(value.boardId), organization: name(value.organization), handle: name(value.handle) };
}

/** Resolve only against the caller's authorized inventory, refusing duplicate IDs or names. */
export function resolveBoardReference(inventory, requested) {
  if (!Array.isArray(inventory) || inventory.length > 10000) invalid();
  const rows = inventory.map(boardReference);
  const ids = new Set();
  const names = new Set();
  for (const row of rows) {
    const qualified = `${row.organization}/${row.handle}`;
    if (ids.has(row.boardId) || names.has(qualified)) invalid();
    ids.add(row.boardId); names.add(qualified);
  }
  let found;
  if (typeof requested === 'string') {
    found = /^[0-9a-f]{32}$/u.test(requested)
      ? rows.find(row => row.boardId === requested)
      : rows.find(row => `${row.organization}/${row.handle}` === requested);
  } else if (requested && typeof requested === 'object' && !Array.isArray(requested)) {
    if (Object.keys(requested).some(key => !['boardId', 'organization', 'handle'].includes(key))) invalid();
    found = rows.find(row => row.boardId === boardReferenceId(requested.boardId));
    if (found && (requested.organization !== undefined && requested.organization !== found.organization
      || requested.handle !== undefined && requested.handle !== found.handle)) invalid();
  }
  if (!found) invalid();
  return { ...found };
}

/** Bind a numeric item ID to its immutable owning board at every composition boundary. */
export function boardItemReference(inventory, reference, itemId) {
  if (!Number.isSafeInteger(itemId) || itemId < 1) invalid();
  return { boardId: resolveBoardReference(inventory, reference).boardId, itemId };
}

/** Canonical bilateral consent and disclosure are independent of transport and key storage [E32,H17]. */

const MODES = ['states', 'counts', 'nothing'];
const STATES = ['open', 'claimed', 'submitted', 'verified', 'withdrawn'];

/** Reject a malformed link rather than normalizing away signed fields. */
export function boardLinkFormat(message) { throw new Refused('BOARD_LINK_FORMAT', `${message}; use the exact version 1 board-link contract`); }

/** Require a bounded correlation or link identifier that cannot become a path. */
export function boardLinkName(value) {
  if (typeof value !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/u.test(value)) boardLinkFormat('Use a bounded link or correlation ID');
  return value;
}

/** Validate the signed body and retain its fixed field order for the existing signature path. */
export function boardLinkBody(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)
    || Object.keys(value).some(key => !['version', 'linkId', 'parent', 'child', 'generation', 'disclosure', 'approvals', 'revocation'].includes(key))) boardLinkFormat('The link has unsupported fields');
  if (value.version !== 1 || !Number.isSafeInteger(value.generation) || value.generation < 1 || !MODES.includes(value.disclosure)) boardLinkFormat('Use a positive generation and a supported disclosure mode');
  const parent = boardReference(value.parent);
  const child = boardReference(value.child);
  if (parent.boardId === child.boardId) boardLinkFormat('A board cannot link to itself');
  return { version: 1, linkId: boardLinkName(value.linkId), parent, child, generation: value.generation, disclosure: value.disclosure };
}

/** Copy bounded public signature records before any asynchronous authority operation. */
function proof(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) boardLinkFormat('Use a signed board approval');
  const allowed = ['version', 'type', 'firstCommit', 'initialHash', 'id', 'file', 'kind', 'source', 'replacement',
    'text', 'decision', 'reason', 'commit', 'by', 'on', 'note', 'signature', 'boardId'];
  if (Object.keys(value).some(key => !allowed.includes(key))
    || Object.values(value).some(entry => entry !== null && !['string', 'number', 'boolean'].includes(typeof entry))) boardLinkFormat('The approval has unsupported fields');
  let encoded;
  try { encoded = JSON.stringify(value); } catch { boardLinkFormat('Use a JSON signature record'); }
  if (typeof encoded !== 'string' || Buffer.byteLength(encoded) > 20000) boardLinkFormat('The approval exceeds its bound');
  const result = JSON.parse(encoded);
  boardReferenceId(result.boardId);
  return result;
}

/** Copy the complete document without accepting mutable caller-owned signature containers. */
export function boardLinkRecord(value) {
  const body = boardLinkBody(value);
  if (!Array.isArray(value.approvals) || value.approvals.length > 2 || value.revocation === undefined) boardLinkFormat('Include approvals and an explicit revocation field');
  const approvals = value.approvals.map(proof).sort((a, b) => a.boardId.localeCompare(b.boardId));
  if (new Set(approvals.map(row => row.boardId)).size !== approvals.length) boardLinkFormat('Each board approves at most once');
  const ends = [body.parent.boardId, body.child.boardId];
  if (approvals.some(row => !ends.includes(row.boardId))) boardLinkFormat('Only the two endpoint boards approve a link');
  return { ...body, approvals, revocation: value.revocation === null ? null : proof(value.revocation) };
}

/** Bind each side and each action as well as the exact document to the SSH signature. */
export function boardLinkSigningText(body, boardId, action) {
  if (!['approve', 'revoke'].includes(action)) boardLinkFormat('Use a link approval or revocation');
  const normalized = boardLinkBody(body);
  if (![normalized.parent.boardId, normalized.child.boardId].includes(boardReferenceId(boardId))) boardLinkFormat('The signer must be an endpoint board');
  return JSON.stringify(['pullboard-board-link', 1, normalized, boardId, action]);
}

/** Strip forbidden text before persistence or transmission; no caller field survives by default. */
export function discloseBoardState(mode, rows) {
  if (!MODES.includes(mode)) throw new Refused('BOARD_LINK_DISCLOSURE', 'use the link’s signed states, counts or nothing disclosure mode');
  if (!Array.isArray(rows) || rows.length > 10000) boardLinkFormat('Use a bounded item-state array');
  if (mode === 'nothing') return [];
  const selected = rows.map(row => {
    if (!row || !Number.isSafeInteger(row.id) || row.id < 1 || !STATES.includes(row.state)) boardLinkFormat('Use exact numeric item IDs and native item states');
    return { board: boardReferenceId(row.board), id: row.id, state: row.state };
  });
  const seen = new Set();
  for (const row of selected) {
    const key = `${row.board}:${row.id}`;
    if (seen.has(key)) boardLinkFormat('An item appears only once in a state announcement');
    seen.add(key);
  }
  if (mode === 'states') return selected;
  const counts = {};
  for (const row of selected) counts[row.state] = (counts[row.state] ?? 0) + 1;
  return counts;
}

/** Exact conflict-note rendering without Git or workflow authority [C7,D1]. */
/**
 * A path as a reader sees it in a message or line: plain when it holds only ordinary path
 * characters, otherwise JSON-quoted, so a space or comma inside a name never reads as two names.
 *
 * @param {string} path
 * @returns {string}
 */
export function shownPath(path) {
  return /^[\w./@+-]+$/u.test(path) ? path : JSON.stringify(path);
}

/** Paths for a message or line, each shown unambiguously, separated by commas. */
export const shownPaths = (paths) => paths.map(shownPath).join(', ');

/** The note a conflict reopen records when the coordinator gives none. */
export function conflictNote({ files, trunk }) {
  return `conflicts with the trunk at ${trunk.slice(0, 12)} in ${shownPaths(files)}; merge main and resubmit`;
}

/** Canonical item-address grammar without native reader authority [B7,N19,A2]. */
/** Decode only the canonical item address; ordinary seats and lanes keep their old names. */
export function shoutItemId(to) {
  const match = /^item:([1-9]\d*)$/u.exec(String(to));
  const id = match ? Number(match[1]) : null;
  return Number.isSafeInteger(id) ? id : null;
}
