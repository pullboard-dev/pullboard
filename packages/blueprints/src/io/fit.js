/**
 * Blueprint fit: after a blueprint lands, a seat proposes how each drafted row, question and
 * starter item fits this repo, and the person approves every proposal as one batch [S1,E3].
 *
 * A proposal is keep, adapt (with the new text), drop (with a reason) or, for a question the repo
 * already settles, answer (with one of its choices). Proposals wait in one file in the git common
 * dir, beside the board, so every worktree of this clone records into the same batch and the
 * person sees them all from the main checkout. Nothing in SPEC.md or on the board changes until
 * the person approves: then each row proposal becomes the person's own row decision (the usual
 * pending apply), each starter adaptation becomes the item's new criterion and each starter drop
 * withdraws it, and every one keeps its reason and its blueprint source.
 *
 * The proposer is the seat's own identity, read by the caller from the board, and the seat's agent
 * session digest; no flag sets either. Any local process can still edit the file, so a proposal is
 * an unverified draft and is always shown as one, with its recorder named as recorded, never as
 * authenticated. The durable record is the person's batch approval on the board. Approval is the
 * person's alone: it refuses an agent session that recorded any proposal in the batch, then every
 * agent shell, remote shell and worktree, then any difference from what the person last read.
 *
 * The person's reading is bound by the person's own hand, not by a file: every listing prints a
 * batch code, a digest of each proposal's id, target and content, and approve takes that code as
 * its argument. The reading file beside the batch only lets a refusal name what differs; approve
 * first checks that the stored reading still hashes to the code the person typed, so a forged or
 * rewritten reading is refused, and only then compares it with the batch, entry by entry: a
 * proposal read but now missing, new since the reading, or changed is refused by name. Like a
 * person's row decision, which is trusted because the person's own channel records it, the
 * approval rests on input only the person gives; anything an agent can write is only a draft.
 */
import {
  createHash,
  randomUUID,
} from 'node:crypto';
import { fileSystemAdapter } from '../../../fs/index.js';
import {
  dirname,
  join,
} from 'node:path';
import {
  blueprintMarker,
  questionText,
  ruleText,
} from './main.js';
import { requirePersonChannel } from '../../../person/index.js';
import { Refused } from '../../../kernel/index.js';

const fs = fileSystemAdapter();

/** What a fit proposal can say about one target. */
export const FIT_DECISIONS = Object.freeze(['keep', 'adapt', 'drop', 'answer']);

/** The proposer a person's own edit records. */
const PERSON = 'person';

/**
 * Where this clone's fit proposals wait: beside the board in the git common dir, so every worktree
 * reads and writes the same batch.
 *
 * @param {string} commonDir
 * @returns {string}
 */
export function fitFile(commonDir) {
  return join(commonDir, 'pullboard', 'blueprint-fit.json');
}

/**
 * Every fit proposal recorded in this clone, waiting or decided, oldest first. A missing file holds
 * none; a file that is not a proposal list is refused rather than read as empty, so a damaged batch
 * is never approved as a smaller one.
 *
 * @param {string} commonDir
 * @returns {any[]}
 */
export function readFit(commonDir) {
  const file = fitFile(commonDir);
  if (!fs.exists(file)) return [];
  let value;
  try { value = JSON.parse(fs.readFile(file, 'utf8')); }
  catch (error) { throw new Refused('FIT_FILE', `${file} is not readable JSON (${error.message.split('\n')[0]})`); }
  if (!value || value.version !== 1 || !Array.isArray(value.proposals)) throw new Refused('FIT_FILE', `${file} is not a blueprint fit file`);
  // Every proposal has its own id. Two sharing one could let an unread proposal pass as the read
  // one, so a batch with any shared id is refused, naming every target that shares it.
  const seen = new Map();
  for (const proposal of value.proposals) seen.set(proposal?.id, [...(seen.get(proposal?.id) ?? []), proposal?.target]);
  const shared = [...seen.values()].filter((targets) => targets.length > 1).flat();
  if (shared.length) {
    throw new Refused('FIT_FILE', `${shared.join(', ')} share a proposal id in ${file}, so the blueprint fit batch cannot be read or approved`,
      `remove ${file} and have the seats record their proposals again with pullboard blueprint fit`);
  }
  return value.proposals;
}

/**
 * Replace the whole proposal list by rename, so a reader never sees half a batch.
 *
 * @param {string} commonDir
 * @param {any[]} proposals
 */
function writeFit(commonDir, proposals) {
  const file = fitFile(commonDir);
  fs.mkdir(dirname(file), { recursive: true });
  const temp = `${file}.${process.pid}.${randomUUID()}.tmp`;
  fs.writeFile(temp, `${JSON.stringify({ version: 1, proposals }, null, 2)}\n`);
  fs.rename(temp, file);
}

/**
 * The proposals that wait for the person.
 *
 * @param {string} commonDir
 * @returns {any[]}
 */
export function pendingFit(commonDir) {
  return readFit(commonDir).filter((proposal) => proposal.state === 'proposed');
}

/**
 * The blueprint's drafted rows, questions and open starter items as they sit on this board, by the
 * name a seat uses for them: a row id such as W3, or #12 for an item. A rule matches its row by
 * exact text in its own section, or as a unique shared draft from an earlier blueprint; a question
 * by its ask and choices, whatever default it landed with; a starter by its title and cited rows.
 * A row or item that has moved on (approved, reworded, claimed) is no longer a target.
 *
 * @param {import('./main.js').Blueprint} blueprint
 * @param {{ rows: any[], sections: { name: string }[] }} spec
 * @param {any[]} items - The board's items as store.listItems returns them.
 * @returns {Map<string, { kind: string, key: string, target: string, source: string, current: string, ask?: string, choices?: string[] }>}
 */
export function fitTargets(blueprint, spec, items) {
  const section = spec.sections.find((entry) => entry.name.replace(/^[A-Z][A-Z0-9]*\s*[·.:-]\s*/u, '') === blueprint.title.trim());
  const targets = new Map();
  const ownRows = section ? spec.rows.filter((row) => row.section === section.name) : [];
  /** Prefer this blueprint's section; otherwise accept only a unique shared row on the board. */
  const findDraft = (matches) => {
    const inRows = (rows) => rows.filter((row) => row.status === matches.status && matches.test(row));
    const own = inRows(ownRows);
    if (own.length === 1) return own[0];
    if (own.length > 1) return undefined;
    const shared = inRows(spec.rows);
    return shared.length === 1 ? shared[0] : undefined;
  };
  const ids = {};
  for (const rule of blueprint.rules) {
    const text = ruleText(rule);
    const row = findDraft({ status: 'draft', test: (entry) => entry.text === text });
    if (!row) continue;
    ids[rule.key] = row.id;
    targets.set(row.id, { kind: 'rule', key: rule.key, target: row.id, source: ruleText(rule), current: row.text });
  }
  for (const question of blueprint.questions) {
    const choices = question.choices.map((choice) => choice.trim());
    const row = findDraft({ status: 'pending', test: (entry) => entry.text.startsWith(`${question.ask.trim()}: `)
      && entry.text.endsWith(`. Choices: ${choices.join(', ')}.`) });
    if (!row) continue;
    ids[question.key] = row.id;
    targets.set(row.id, { kind: 'question', key: question.key, target: row.id, source: questionText(question), current: row.text, ask: question.ask.trim(), choices });
  }
  // Facts supply starter citations, but are not proposals waiting for approval.
  for (const entry of blueprint.defaults ?? []) {
    const row = findDraft({ status: 'fact', test: (row) => row.text === entry.text.trim() });
    if (row) ids[entry.key] = row.id;
  }
  for (const starter of blueprint.items) {
    const cites = starter.cites.map((key) => ids[key]).filter(Boolean).join(',');
    const item = items.find((entry) => entry.item_status === 'open' && entry.item_title === starter.title.trim() && (entry.item_spec_ids ?? '') === cites);
    if (!item) continue;
    const source = `${starter.title.trim()}${starter.criterion ? `; criterion: ${starter.criterion}` : ''}`;
    targets.set(`#${item.item_id}`, { kind: 'item', key: starter.key, target: `#${item.item_id}`, source, current: item.item_criterion ?? '' });
  }
  return targets;
}

/** The choice that takes a stack no named choice covers (#916). */
const OTHER_CHOICE = 'Something else';

/**
 * Check one proposal against its target and give the text it would apply: the new row text, the
 * answered question's row text or the item's new criterion, or null for keep and drop.
 *
 * @param {{ kind: string, target: string, ask?: string, choices?: string[] }} target
 * @param {{ decision?: string, text?: string, reason?: string }} proposal
 * @returns {{ decision: string, text: string | null, reason: string }}
 */
function checkProposal(target, { decision, text, reason }) {
  const line = (value) => typeof value === 'string' && value.trim() && !/[\r\n|]/u.test(value);
  if (!FIT_DECISIONS.includes(decision)) throw new Refused('USAGE', `say how ${target.target} fits: keep, adapt, drop or answer`);
  if (reason !== undefined && !line(reason)) throw new Refused('FIT_PROPOSAL', 'a reason is one nonempty line without a | character');
  if (['adapt', 'drop', 'answer'].includes(decision) && reason === undefined) {
    throw new Refused('FIT_PROPOSAL', `a ${decision} proposal keeps its reason; add --reason "why it fits this repo that way"`);
  }
  if (['keep', 'drop'].includes(decision)) {
    if (text !== undefined) throw new Refused('FIT_PROPOSAL', `a ${decision} proposal takes no --text; use adapt to change the wording`);
    return { decision, text: null, reason: reason?.trim() ?? '' };
  }
  if (!line(text)) throw new Refused('FIT_PROPOSAL', `an ${decision} proposal needs --text, one nonempty line without a | character`);
  if (decision === 'adapt') return { decision, text: text.trim(), reason: reason.trim() };
  if (target.kind !== 'question') throw new Refused('FIT_PROPOSAL', `${target.target} is no question; only a question takes an answer, so use keep, adapt or drop`);
  // A stack no named choice covers fits Something else, which takes the stack's name as its answer (#916).
  const named = target.choices.includes(text.trim()) || target.choices.includes(OTHER_CHOICE);
  if (!named) throw new Refused('FIT_PROPOSAL', `${text.trim()} is not one of ${target.target}'s choices (${target.choices.join(', ')})`);
  return { decision, text: questionText({ ask: target.ask, choices: target.choices, default: text.trim() }), reason: reason.trim() };
}

/**
 * Record a seat's fit proposal for one target of a blueprint this board has fully added. A later
 * proposal for the same target replaces the waiting one; nothing else changes.
 *
 * @param {{ commonDir: string, blueprint: import('./main.js').Blueprint, specSource: string, spec: any, items: any[], by: string, session: string | null, at: string }} where
 * @param {{ target?: string, decision?: string, text?: string, reason?: string }} proposal
 * @returns {any} the recorded proposal
 */
export function proposeFit({ commonDir, blueprint, specSource, spec, items, by, session, at }, { target, decision, text, reason }) {
  if (!specSource.split(/\r?\n/u).some((line) => line.trim() === blueprintMarker(blueprint))) {
    throw new Refused('BLUEPRINT_NOT_ADDED', `${blueprint.name} version ${blueprint.version} is not fully added to this board`);
  }
  const targets = fitTargets(blueprint, spec, items);
  const found = targets.get(String(target ?? '').trim());
  if (!found) {
    throw new Refused('FIT_TARGET', `${target ?? 'nothing'} is no drafted row, question or open starter of ${blueprint.name} here; targets: ${[...targets.keys()].join(', ') || 'none left'}`);
  }
  const checked = checkProposal(found, { decision, text, reason });
  return saveProposal(commonDir, { id: randomUUID(), blueprint: { name: blueprint.name, version: blueprint.version }, ...found, ...checked, by, session, at, state: 'proposed' });
}

/**
 * The person's edit of a waiting proposal: the same target and blueprint source, a new decision,
 * text or reason, recorded as the person's own proposal.
 *
 * @param {string} commonDir
 * @param {{ target?: string, decision?: string, text?: string, reason?: string, at: string }} edit
 * @returns {any} the edited proposal
 */
export function editFit(commonDir, { target, decision, text, reason, at }) {
  const waiting = pendingFit(commonDir).find((proposal) => proposal.target === String(target ?? '').trim());
  if (!waiting) throw new Refused('FIT_TARGET', `no fit proposal waits for ${target ?? 'that target'}; read the batch with pullboard spec fit`);
  const checked = checkProposal(waiting, { decision, text, reason });
  // The caller shows the whole batch again after an edit, so the person reads what they approve.
  return saveProposal(commonDir, { ...waiting, id: randomUUID(), ...checked, by: PERSON, session: null, at, editedFrom: waiting.id });
}

/**
 * Put one waiting proposal in the file, replacing any proposal still waiting for its target.
 *
 * @param {string} commonDir
 * @param {any} proposal
 * @returns {any}
 */
function saveProposal(commonDir, proposal) {
  const all = readFit(commonDir).map((entry) => (entry.state === 'proposed' && entry.target === proposal.target ? { ...entry, state: 'replaced', replacedBy: proposal.id } : entry));
  writeFit(commonDir, [...all, proposal]);
  return proposal;
}

/**
 * Where a proposal came from, as one line: the blueprint, its version, its key and its text.
 *
 * @param {any} proposal
 * @returns {string}
 */
export function fitSource(proposal) {
  return `${proposal.blueprint.name} v${proposal.blueprint.version} ${proposal.kind === 'item' ? 'starter' : proposal.kind} ${proposal.key}: ${proposal.source}`;
}

/**
 * One proposal as the person reads it: target, decision, proposer, new text, reason and source.
 *
 * @param {any} proposal
 * @returns {string}
 */
export function fitLine(proposal) {
  return `${proposal.target} ${proposal.decision} (unverified draft, recorded as ${proposal.by})${proposal.text ? `: ${proposal.text}` : ''}`
    + `${proposal.reason ? `; reason: ${proposal.reason}` : ''}; blueprint source: ${fitSource(proposal)}`;
}

/**
 * The lines pullboard spec prints for the waiting batch, or none: every proposal, then the batch
 * code the person approves this exact batch with.
 *
 * @param {{ proposals: any[], batch: string }} read - From readFitBatch.
 * @returns {string[]}
 */
export function fitSummary({ proposals, batch }) {
  if (!proposals.length) return [];
  return [`blueprint fit: ${proposals.length} unverified draft ${proposals.length === 1 ? 'proposal waits' : 'proposals wait'} for the person; nothing applies until the person approves the batch`,
    ...proposals.map((proposal) => `  ${fitLine(proposal)}`),
    `the person edits one with pullboard spec fit edit <target> keep|adapt|drop|answer, or approves exactly this batch with pullboard spec fit approve ${batch}`];
}

/**
 * The note a decision keeps: what the person approved, why, and where it came from.
 *
 * @param {any} proposal
 * @returns {string}
 */
function fitNote(proposal) {
  return `blueprint fit ${proposal.decision}${proposal.reason ? `: ${proposal.reason}` : ''}; recorded as ${proposal.by}, unverified; blueprint source: ${fitSource(proposal)}`;
}

/**
 * The person approves every waiting proposal as one batch. Each target must still read as it did
 * when proposed. Row proposals become one set of the person's row decisions (keep and adapt and
 * answer approve, drop declines with its reason), each with a note keeping the reason and the
 * blueprint source; then starter adaptations set the item's criterion and starter drops withdraw
 * it, each after a fact on the item keeping the same note. The batch is marked approved last.
 *
 * @param {{ commonDir: string, spec: any, items: any[], session: string | null, at: string, code: string }} where - code is the batch code the person typed
 * @param {{ decide: (rows: { proposal: any, note: string }[]) => Promise<any[]>, fact: (id: number, text: string) => Promise<any>, criterion: (id: number, text: string) => Promise<any>, withdraw: (id: number, reason: string) => Promise<any> }} moves
 * @returns {Promise<{ proposals: any[], decisions: any[], items: { id: number, decision: string }[] }>}
 */
export async function approveFit({ commonDir, spec, items, session, at, code }, moves) {
  const batch = refuseOwnFit(commonDir, session);
  refuseUnreadFit(commonDir, batch, code);
  if (!batch.length) throw new Refused('NO_FIT_PROPOSALS', 'no blueprint fit proposals wait for the person');
  return await approveBatch({ commonDir, spec, items, at, batch }, moves);
}

/**
 * Refuse an agent session that recorded any waiting proposal, before any other check reads the
 * caller: a seat never approves or edits its own proposal, whatever channel it comes through.
 * Returns the waiting batch.
 *
 * @param {string} commonDir
 * @param {string | null} session - The caller's agent session digest, or null outside an agent shell.
 * @returns {any[]}
 */
export function refuseOwnFit(commonDir, session) {
  const batch = pendingFit(commonDir);
  const own = session && batch.find((proposal) => proposal.session === session);
  if (own) throw new Refused('FIT_OWN_PROPOSAL', `this agent session recorded ${own.target}'s fit proposal as ${own.by}; a seat never approves its own proposal`);
  return batch;
}

/**
 * Apply an already-authorized batch; see approveFit.
 *
 * @param {{ commonDir: string, spec: any, items: any[], at: string, batch: any[] }} where
 * @param {any} moves
 * @returns {Promise<{ proposals: any[], decisions: any[], items: { id: number, decision: string }[] }>}
 */
async function approveBatch({ commonDir, spec, items, at, batch }, moves) {
  const stale = batch.filter((proposal) => {
    const item = proposal.kind === 'item' && items.find((entry) => `#${entry.item_id}` === proposal.target && entry.item_status === 'open');
    const now = proposal.kind === 'item'
      ? (item ? item.item_criterion ?? '' : null)
      : spec.rows.find((row) => row.id === proposal.target && ['draft', 'pending'].includes(row.status))?.text ?? null;
    return now !== proposal.current;
  });
  if (stale.length) {
    // The batch no longer matches the board, so none of it applies; the stale proposals leave the
    // batch, so the person can read what is left and approve that.
    const ids = new Set(stale.map((proposal) => proposal.id));
    writeFit(commonDir, readFit(commonDir).map((entry) => (ids.has(entry.id) ? { ...entry, state: 'stale', staleAt: at } : entry)));
    throw new Refused('FIT_STALE', `${stale.map((proposal) => proposal.target).join(', ')} changed after its fit proposal, so nothing in the batch was applied and those proposals left it`,
      'read what is left with pullboard spec fit, then approve it with the batch code it prints: pullboard spec fit approve <batch>');
  }
  const rows = batch.filter((proposal) => proposal.kind !== 'item');
  const decisions = rows.length ? await moves.decide(rows.map((proposal) => ({ proposal, note: fitNote(proposal) }))) : [];
  const changed = [];
  for (const proposal of batch.filter((entry) => entry.kind === 'item' && entry.decision !== 'keep')) {
    const id = Number(proposal.target.slice(1));
    await moves.fact(id, `The person approved this blueprint fit: ${fitNote(proposal)}`);
    if (proposal.decision === 'adapt') await moves.criterion(id, proposal.text);
    else await moves.withdraw(id, `blueprint fit drop: ${proposal.reason}`);
    changed.push({ id, decision: proposal.decision });
  }
  const approved = new Set(batch.map((proposal) => proposal.id));
  const events = new Map(decisions.map((record) => [record.id, record.event]));
  const after = readFit(commonDir).map((entry) => (approved.has(entry.id)
    ? { ...entry, state: 'approved', approvedBy: PERSON, approvedAt: at, ...(events.has(entry.target) ? { decisionEvent: events.get(entry.target) } : {}) }
    : entry));
  writeFit(commonDir, after);
  return { proposals: after.filter((entry) => approved.has(entry.id)), decisions, items: changed };
}

/**
 * Show the waiting batch in the shared view state: each row a proposal names carries it and a
 * stage saying it waits for the person, unless the person already decided that row; each starter
 * carries its proposal; and the state lists the whole batch as fit.
 *
 * @param {any[]} proposals - From pendingFit.
 * @param {any} state - The API state, after row decisions are projected.
 * @returns {any}
 */
export function projectFit(proposals, state) {
  if (!proposals.length) return state;
  // A recorder is shown only as recorded, never as an authenticated author, and no session digest leaves.
  const drafts = proposals.map(({ by, session, ...proposal }) => ({ ...proposal, recordedAs: by, verified: false }));
  const byTarget = new Map(drafts.map((proposal) => [proposal.target, proposal]));
  return { ...state,
    fit: drafts,
    spec: state.spec.map((row) => (byTarget.has(row.id) && !row.decision
      ? { ...row, fit: byTarget.get(row.id), stage: `fit draft, unverified: ${byTarget.get(row.id).decision}, waits for the person` } : row)),
    items: state.items.map((item) => (byTarget.has(`#${item.id}`) ? { ...item, fit: byTarget.get(`#${item.id}`) } : item)),
  };
}

/**
 * The digest of what a proposal says, so a reading can tell later whether it changed.
 *
 * @param {any} proposal
 * @returns {string}
 */
export function fitDigest(proposal) {
  const { id, blueprint, kind, key, target, source, current, decision, text, reason, by } = proposal;
  return createHash('sha256').update(JSON.stringify({ id, blueprint, kind, key, target, source, current, decision, text, reason, by })).digest('hex');
}

/**
 * Where the person's last reading is kept, so a refusal can name what differs from it. It is no
 * proof of anything by itself: approve checks it against the batch code the person typed.
 *
 * @param {string} commonDir
 * @returns {string}
 */
function viewedFile(commonDir) {
  return join(commonDir, 'pullboard', 'blueprint-fit-viewed.json');
}

/**
 * Each proposal of a batch as a reading holds it, one entry per proposal and never merged by id:
 * its id, its target and its digest, in id then digest order.
 *
 * @param {any[]} proposals
 * @returns {{ id: string, target: string, digest: string }[]}
 */
function readingOf(proposals) {
  const entries = proposals.map((proposal) => ({ id: String(proposal.id), target: String(proposal.target), digest: fitDigest(proposal) }));
  return entries.sort((a, b) => (a.id === b.id ? (a.digest < b.digest ? -1 : a.digest > b.digest ? 1 : 0) : a.id < b.id ? -1 : 1));
}

/**
 * The batch code of a reading: a short digest of every entry's id, target and proposal digest, each
 * entry on its own. The person approves by typing it, which binds the approval to exactly what
 * they read.
 *
 * @param {{ id: string, target: string, digest: string }[]} reading
 * @returns {string}
 */
export function batchCode(reading) {
  const entries = reading.map((entry) => [entry?.id, entry?.target, entry?.digest]);
  return createHash('sha256').update(JSON.stringify(entries)).digest('hex').slice(0, 12);
}

/**
 * The person's last reading, or null when there is none or it cannot be read.
 *
 * @param {string} commonDir
 * @returns {{ id: string, target: string, digest: string }[] | null}
 */
function readViewed(commonDir) {
  const file = viewedFile(commonDir);
  if (!fs.exists(file)) return null;
  let value;
  try { value = JSON.parse(fs.readFile(file, 'utf8')); }
  catch (error) {
    if (!(error instanceof SyntaxError)) throw error;
    // A damaged reading is no reading; approve refuses it and the person reads the batch again.
    return null;
  }
  const reading = value?.reading;
  const entry = (item) => item && ['id', 'target', 'digest'].every((key) => typeof item[key] === 'string');
  return Array.isArray(reading) && reading.every(entry) ? reading : null;
}

/**
 * The waiting batch for a reader, with its batch code. When the reader is the person, in the main
 * checkout's own terminal, this listing is the person's reading and replaces the last one. An
 * agent, a remote shell or a worktree sees the batch and its code without it counting as read.
 *
 * @param {string} commonDir
 * @param {{ isMain: boolean, channel?: string, at?: string }} reader
 * @returns {{ proposals: any[], batch: string }}
 */
export function readFitBatch(commonDir, { isMain, channel, at = new Date().toISOString() }) {
  const proposals = pendingFit(commonDir);
  const reading = readingOf(proposals);
  if (isMain && isPersonTerminal(channel)) {
    const file = viewedFile(commonDir);
    fs.mkdir(dirname(file), { recursive: true });
    const temp = `${file}.${process.pid}.${randomUUID()}.tmp`;
    fs.writeFile(temp, `${JSON.stringify({ version: 1, at, reading }, null, 2)}\n`);
    fs.rename(temp, file);
  }
  return { proposals, batch: batchCode(reading) };
}

/**
 * True when this terminal is the person's own, by the same rule person moves use.
 *
 * @param {string | undefined} channel
 * @returns {boolean}
 */
function isPersonTerminal(channel) {
  try { requirePersonChannel(channel ?? 'terminal'); return channel !== 'view'; }
  catch (error) {
    if (error instanceof Refused) return false;
    throw error;
  }
}

/**
 * Refuse unless the batch is exactly what the person last read. The stored reading must hash to
 * the code the person typed, or it was rewritten after the reading (FIT_READING). Then every id
 * the person read must still wait with the same digest, and nothing may wait that they did not
 * read (FIT_CHANGED, naming each). Nothing is written on either refusal.
 *
 * @param {string} commonDir
 * @param {any[]} batch
 * @param {string} code
 */
function refuseUnreadFit(commonDir, batch, code) {
  const reading = readViewed(commonDir);
  if (!reading || batchCode(reading) !== String(code ?? '').trim()) {
    throw new Refused('FIT_READING', `${code ?? 'no batch code'} is not the batch code of your last reading of the blueprint fit batch, or that reading was changed since; nothing was approved`,
      'read the batch again with pullboard spec fit, then approve it with the batch code it prints: pullboard spec fit approve <batch>');
  }
  const now = readingOf(batch);
  // Compared entry by entry, never merged by id: a shared id, on either side, is itself a difference.
  const count = (entries) => entries.reduce((ids, entry) => ids.set(entry.id, (ids.get(entry.id) ?? 0) + 1), new Map());
  const [readIds, nowIds] = [count(reading), count(now)];
  const named = [
    ...reading.filter((entry) => !nowIds.has(entry.id)).map((entry) => `${entry.target} (gone)`),
    ...now.filter((entry) => !readIds.has(entry.id)).map((entry) => `${entry.target} (new)`),
    ...now.filter((entry) => readIds.has(entry.id) && !reading.some((read) => read.id === entry.id && read.digest === entry.digest)).map((entry) => `${entry.target} (changed)`),
    ...[...reading, ...now].filter((entry) => readIds.get(entry.id) > 1 || nowIds.get(entry.id) > 1).map((entry) => `${entry.target} (shared id)`),
  ];
  if (named.length) {
    throw new Refused('FIT_CHANGED', `${named.join(', ')} differ from your last reading of the blueprint fit batch, so nothing was approved`,
      'read the batch again with pullboard spec fit, then approve it with the batch code it prints: pullboard spec fit approve <batch>');
  }
}
