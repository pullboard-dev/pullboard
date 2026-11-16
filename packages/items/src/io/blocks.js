/** The block ledger: refusals that stopped someone's command. Not in refused.js, which the browser loads [C6]. */
import {
  appendFileSync,
  closeSync,
  existsSync,
  fstatSync,
  openSync,
  readSync,
  statSync,
} from 'node:fs';
import {
  join,
  resolve,
} from 'node:path';
import {
  createHash,
  randomUUID,
} from 'node:crypto';
import {
  gitConfig,
  repoInfo,
} from "../../../git/light.js";
import { homedir } from 'node:os';

/** The ledger of refusals that stopped someone's command, beside the board in Git's common folder. */
export const BLOCKS_FILE = join('pullboard', 'blocks.jsonl');

/**
 * Append one block: its code, the command, who was stopped, who can clear it, and the plain reason
 * and step. A ledger beside the board, not a board event, so recording a block never needs the
 * board's lock or changes what the event log replays.
 *
 * @param {string} commonDir
 * @param {{ at: string, code: string, command: string, by: string, path: string, audience: string, reason: string, step: string }} block
 */
export function recordBlock(commonDir, block) {
  const folder = join(commonDir, 'pullboard');
  // A repository without a board has no ledger yet; the refusal itself still prints.
  if (!existsSync(folder)) return false;
  appendFileSync(join(commonDir, BLOCKS_FILE), JSON.stringify({ ...block, ...(block.moveKey ? { id: randomUUID() } : {}) }) + '\n');
  return true;
}

/** Lines this far older than `since` prove the tail read has reached back far enough despite clock skew. */
const TAIL_SLACK_MS = 3_600_000;

/**
 * The ledger bytes from `offset` to the end, read once into an unfilled buffer and cut to what was read.
 *
 * @param {string} file
 * @param {number} offset
 * @returns {Buffer}
 */
export function readLedgerBytes(file, offset) {
  const fd = openSync(file, 'r');
  try {
    const bytes = Buffer.allocUnsafe(Math.max(0, fstatSync(fd).size - offset));
    let length = 0;
    while (length < bytes.length) {
      const count = readSync(fd, bytes, length, bytes.length - length, offset + length);
      if (count === 0) break;
      length += count;
    }
    return bytes.subarray(0, length);
  } finally { closeSync(fd); }
}

/** The ledger text in `bytes` read from `offset`; a read that starts mid-file drops its first partial line. */
function ledgerText(bytes, offset) {
  const text = bytes.toString('utf8');
  return offset > 0 ? text.slice(text.indexOf('\n') + 1) : text;
}

/**
 * Whether the text holds a block recorded before the bound, so nothing inside the window lies further back.
 *
 * @param {string} text
 * @param {number} bound
 * @returns {boolean}
 */
function reachesBefore(text, bound) {
  for (const line of text.split('\n')) if (stampOf(line) < bound) return true;
  return false;
}

/**
 * The ledger lines, in order, that name one of the words, and every clear without move keys, found by searching the
 * text rather than splitting all of it.
 *
 * @param {string} text
 * @param {string[]} words
 * @returns {string[]}
 */
function linesNaming(text, words) {
  const starts = new Set();
  const lineAt = start => { const end = text.indexOf('\n', start); return text.slice(start, end < 0 ? text.length : end); };
  for (const word of words) {
    for (let at = text.indexOf(word); at >= 0; at = text.indexOf(word, at + word.length)) starts.add(text.lastIndexOf('\n', at) + 1);
  }
  const clear = '"kind":"clear"';
  for (let at = text.indexOf(clear); at >= 0; at = text.indexOf(clear, at + clear.length)) {
    const start = text.lastIndexOf('\n', at) + 1;
    if (!lineAt(start).includes('"moveKeys"')) starts.add(start);
  }
  return [...starts].sort((a, b) => a - b).map(lineAt);
}

/**
 * The time a ledger line was recorded, read from its own `"at"` field by a string scan, never a JSON parse, so a line
 * can be placed before or after a bound without parsing it. NaN for a torn or foreign line, which proves nothing about time.
 *
 * @param {string} line
 * @returns {number}
 */
function stampOf(line) {
  const found = /"at":"([^"]*)"/u.exec(line);
  return found ? Date.parse(found[1]) : NaN;
}

/**
 * The blocks recorded at or after `since`, oldest first. A torn last line from a crash is skipped.
 * With `since`, only the tail of the ledger is read, doubling backward until it holds a line older than the
 * bound, and no line older than the bound is parsed: a clear always follows the block it clears, so older lines
 * cannot change a block inside the window [C7].
 *
 * With `mentioning`, only blocks naming one of those strings are returned, and the only lines split out and parsed are
 * those naming one, plus any clear without move keys: the clear after every successful command split and parsed a
 * whole 29 MB ledger of 35,000 lines [C7]. A clear names the keys it completes, so one naming none of the words can
 * only drop another key from a returned block's pending keys, never the block itself.
 *
 * @param {string} commonDir
 * @param {{ since?: Date, mentioning?: string[], read?: (file: string, offset: number) => Buffer }} [options] - `read` replaces the
 *   ledger reader, for a test that counts reads.
 * @returns {any[]}
 */
export function readBlocks(commonDir, { since, mentioning, read = readLedgerBytes } = {}) {
  const file = join(commonDir, BLOCKS_FILE);
  if (!existsSync(file)) return [];
  const from = since ? since.getTime() : -Infinity;
  const size = statSync(file).size;
  let text;
  if (!since) {
    // With no bound every line counts, so the whole ledger is read once; a ledger naming none of the words is never decoded.
    const bytes = read(file, 0);
    if (mentioning && !mentioning.some(word => bytes.includes(word))) return [];
    text = ledgerText(bytes, 0);
  } else for (let window = 262_144; ; window *= 2) {
    const offset = Math.max(0, size - window);
    text = ledgerText(read(file, offset), offset);
    if (offset === 0 || reachesBefore(text, from - TAIL_SLACK_MS)) break;
  }
  if (mentioning && !mentioning.some(word => text.includes(word))) return [];
  const blocks = new Map();
  let legacy = 0;
  for (const line of mentioning ? linesNaming(text, mentioning) : text.split('\n')) {
    if (!line.trim()) continue;
    // A line recorded before the bound cannot change a block inside the window, so it is skipped unparsed.
    if (since && stampOf(line) < from) continue;
    let block;
    try { block = JSON.parse(line); } catch { continue; /* A torn line from an interrupted append carries no block. */ }
    if (block?.kind === 'clear' && Array.isArray(block.ids)) {
      for (const id of block.ids) {
        const previous = blocks.get(id);
        const pending = previous?.moveKeys?.filter(move => !block.moveKeys?.includes(move));
        if (block.moveKeys && pending?.length) blocks.set(id, { ...previous, moveKeys: pending });
        else blocks.delete(id);
      }
    } else if (typeof block?.code === 'string') blocks.set(block.id ?? `legacy:${legacy++}`, block);
  }
  return [...blocks.values()].filter(block => Date.parse(block.at) >= from);
}

/** Hash a local matching key; command text, argument bodies and credentials never enter the ledger. */
function key(value) { return createHash('sha256').update(JSON.stringify(value)).digest('hex'); }

/** The command branch and its target, excluding prose and option values. */
export function blockMoveKey(io) {
  const command = io.relayCommand;
  if (!command) return null;
  const name = command.cliOperation;
  const words = command.positionals ?? [];
  const branches = new Set(['spec', 'doctrine', 'sentinel', 'runner', 'relay', 'lane', 'milestone', 'hook', 'settings', 'loop', 'rigor', 'blueprint', 'flakes']);
  let verb = name === 'hold' ? command.values?.off ? 'off' : 'on'
    : name === 'land' && command.values?.waive !== undefined ? 'waive'
    : ['verify', 'fact'].includes(name) ? words[1] ?? ''
    : name === 'check' && words[0] === 'accept' ? 'accept' : branches.has(name) ? words[0] ?? '' : '';
  const itemTargets = new Set(['answer', 'claim', 'submit', 'verify', 'check', 'show', 'release', 'withdraw', 'merged', 'fact', 'escalate', 'hold', 'edit', 'refreeze', 'reopen', 'pass', 'log', 'why']);
  const namedTargets = new Set(['shout', 'join', 'worktree', 'list', 'inbox', 'prompt', 'forget', 'import', 'add']);
  let numericItem = itemTargets.has(name);
  let target = numericItem || namedTargets.has(name) ? words[0] ?? '' : '';
  if (name === 'check' && verb === 'accept') target = words[1] ?? '';
  if (name === 'land' && verb === 'waive') target = String(command.values.waive);
  if (name === 'next' && command.values?.verifyId !== undefined) {
    target = String(command.values.verifyId);
    numericItem = true;
  }
  // These handlers take a named entity after their verb, not prose or an option value.
  const namedBranches = new Set(['sentinel', 'runner', 'milestone', 'lane', 'loop', 'rigor', 'blueprint', 'flakes']);
  if (namedBranches.has(name) || name === 'relay' && verb === 'revoke'
      || name === 'spec' && ['answer', 'show'].includes(verb)) target = words[1] ?? '';
  if (name === 'spec' && ['approve', 'decline', 'signoff'].includes(verb)) {
    target = [...new Set(words.slice(1).flatMap(word => word.split(/[\s,]+/u)).filter(Boolean))].sort().join(',');
  }
  if (name === 'spec' && ['fit', 'signers'].includes(verb)) {
    verb += ':' + (words[1] ?? '');
    target = words[2] ?? '';
  }
  if (name === 'blueprint' && verb === 'add') {
    target = [...new Set([words[1], ...[].concat(command.values?.blueprint ?? [])].filter(Boolean))].sort();
  }
  if (name === 'spec' && verb === 'signers:add') {
    const root = repoInfo(io.cwd ?? process.cwd()).root;
    /** Read the signer's configured defaults without reading any key contents. */
    const setting = field => gitConfig(root, field, { flags: false }).stdout || '';
    const requested = command.values?.key || setting('user.signingkey') || join(homedir(), '.ssh/id_ed25519.pub');
    const expanded = requested === '~' ? homedir() : requested.startsWith('~/') ? join(homedir(), requested.slice(2)) : requested;
    target = { principal: command.values?.by || setting('user.email'), key: resolve(root, expanded).replace(/\.pub$/u, '') };
  }
  if (['forget', 'import'].includes(name) && target) target = resolve(io.cwd ?? process.cwd(), target);
  if (name === 'milestone' && verb === 'add') target = target.trim();
  // Item IDs accept #1 and 01 as aliases. Names such as milestones '01' and '1' remain distinct.
  if (numericItem && /^#?\d+$/u.test(target)) target = String(Number(target.replace(/^#/u, '')));
  return key({ command: name, verb, item: target });
}

/** A multirow refusal completes only after every target has its own later successful move. */
export function blockMoveKeys(io) {
  const command = io.relayCommand;
  if (command?.cliOperation === 'spec' && ['approve', 'decline', 'signoff'].includes(command.positionals?.[0])) {
    return [...new Set(command.positionals.slice(1).flatMap(word => word.split(/[\s,]+/u)).filter(Boolean))]
      .map(id => blockMoveKey({ relayCommand: { ...command, positionals: [command.positionals[0], id] } }));
  }
  if (command?.cliOperation === 'blueprint' && command.positionals?.[0] === 'add') {
    const refs = [...new Set([command.positionals[1], ...[].concat(command.values?.blueprint ?? [])].filter(Boolean))];
    return refs.map(reference => blockMoveKey({ ...io, relayCommand: { ...command,
      positionals: ['add', reference], values: { ...command.values, blueprint: [] } } }));
  }
  const move = blockMoveKey(io);
  return move ? [move] : [];
}

/** Agent blocks belong to that checkout's seat; person and coordinator blocks belong to this board. */
export function blockOwner(audience, info) {
  return audience === 'agent' ? key({ audience, seat: info.root }) : audience;
}

/**
 * Whether a completed command could clear a block: it names a move and this board has a block ledger. Lets the CLI skip
 * loading the person channel check after every read when nothing can clear [C7,#6483].
 */
export function blocksMayClear(io) {
  let info;
  try { info = repoInfo(io.cwd); } catch { return false; }
  return existsSync(join(info.commonDir, BLOCKS_FILE)) && blockMoveKeys(io).length > 0;
}

/**
 * Record only the matching completed move's clear, leaving later or unrelated blocks intact.
 * The person-channel check loads only when a person's block could clear, so a read that clears an agent's block loads no person cell [#6483].
 */
export async function clearCompletedBlocks(io, { loadPersonCheck }, now = io.clock?.now?.() ?? new Date()) {
  let info;
  try { info = repoInfo(io.cwd); } catch { return; }
  const moveKeys = blockMoveKeys(io);
  if (!moveKeys.length) return;
  const owners = new Set([blockOwner('agent', info)]);
  if (info.isMain) owners.add('coordinator');
  try {
    // A move key is a hex digest, so a block naming it holds it verbatim in its line.
    const matching = readBlocks(info.commonDir, { mentioning: moveKeys }).filter(block => block.id && (block.moveKeys ?? [block.moveKey]).some(move => moveKeys.includes(move))
      && Date.parse(block.at) <= now.getTime());
    if (matching.some(block => block.owner === 'person')) {
      const requirePersonChannel = await loadPersonCheck();
      try { requirePersonChannel(io.personChannel); owners.add('person'); } catch { /* An agent's success cannot clear a person's block. */ }
    }
    const ids = matching.filter(block => owners.has(block.owner)).map(block => block.id);
    if (!ids.length) return;
    appendFileSync(join(info.commonDir, BLOCKS_FILE), JSON.stringify({ kind: 'clear', at: now.toISOString(), ids, moveKeys }) + '\n');
  } catch (error) { io.err(`pullboard: the move completed, but its earlier block could not be cleared (${error.message})`); }
}

/**
 * The last day's blocks only the person can clear, carrying only their plain words, never a local
 * path, for every Needs you projection: the CLI, the local API and the sealed relay page [C6].
 *
 * @param {string} commonDir
 * @param {Date} now
 * @param {{state: string, spend: number, limit: number|null, which: string|null}} [budget] a budgetState result, shown as one budget line
 */
export function personBlockWords(commonDir, now, budget) {
  return [
    ...readBlocks(commonDir, { since: new Date(now.getTime() - 86_400_000) })
      .filter(block => block.audience === 'person')
      .map(({ at, code, command, audience, reason, step }) => ({ at, code, command, audience, reason, step })),
    ...budgetWords(budget, now),
  ];
}

/**
 * The one budget line Needs you shows once spend reaches 80 percent of a limit, naming spend and limit;
 * an ok state, or no budget set, shows none [N2]. A line rather than a block, so nothing is written to the ledger.
 *
 * @param {{state: string, spend: number, limit: number|null, which: string|null}|undefined} budget a budgetState result
 * @param {Date} now
 * @returns {Array<{at: string, code: string, command: string, audience: string, reason: string, step: string}>}
 */
export function budgetWords(budget, now) {
  if (!budget || budget.limit === null || (budget.state !== 'warn' && budget.state !== 'stop')) return [];
  const stop = budget.state === 'stop';
  const period = budget.which === 'dailyUsd' ? 'daily' : 'total';
  return [{
    at: now.toISOString(),
    code: stop ? 'BUDGET_STOP' : 'BUDGET_WARN',
    command: 'pullboard settings budget',
    audience: 'person',
    reason: `Spend is $${budget.spend.toFixed(2)} of the $${budget.limit.toFixed(2)} ${period} budget${stop ? ': the limit is reached' : ''}.`,
    step: 'Raise the budget in the machine settings, or let the seats idle until the period ends.',
  }];
}
