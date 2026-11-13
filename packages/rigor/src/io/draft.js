/** @pullboard-module-loads packages/doctrine/index.js packages/codemap/index.js packages/sentinels/index.js packages/rigor/src/io/proof.js */
/**
 * Rigor's second step: a repeated cause becomes a draft row with its proof [D1,D3,S1]. A work cause
 * becomes a Doctrine row whose check holds a count of 0; a product cause becomes a spec row gated
 * by its failing test; a cause that reads as both drafts one of each, and the person picks. The
 * proof is the check run on real commits: red on the bad one, green on the fix. Nothing here
 * approves or applies a row.
 */
import { createRequire } from 'node:module';
import { PERSON } from '../../../store/index.js';
import { Refused } from '../../../kernel/index.js';
import {
  causeProblem,
  rigorReport,
} from '../../../store/index.js';
import { draftRow } from '../../../spec/index.js';
import { rigorSource } from '../../../store/index.js';

const requireModule = createRequire(import.meta.url);
let draftPackagesLoaded = null;
/** The doctrine, history-map and sentinel packages and the proof runner a draft needs, loaded at the first draft: a board that only counts rigor never pays for them [C7]. */
function draftPackages() {
  return draftPackagesLoaded ??= {
    doctrine: requireModule('../../../doctrine/index.js'),
    codemap: requireModule('../../../codemap/index.js'),
    sentinels: requireModule('../../../sentinels/index.js'),
    proof: requireModule('./proof.js'),
  };
}

/**
 * Draft the rows for a repeated cause, after proving its check. Refused when the key is malformed,
 * has not repeated (pullboard rigor does not list it), the rule text is not one line, or the proof
 * does not hold. Returns the drafts with their evidence and proof.
 *
 * @param {{ root: string, config: any, events: any[], person: string, parseProcessCensus: (stdout: string) => Map<number, any> | null, reserve?: (row: any) => Promise<{ id: string }> }} board
 *   reserve: reserves a planned row's id on the board and returns the id to write (#878). It runs after the
 *   proof, right before each write, so a lane draft made while a slow proof runs, or at the same moment,
 *   keeps its own id.
 * @param {{ key: string, text: string, check?: string, red?: string, green?: string, section?: string }} request
 * @returns {Promise<{ key: string, reads: string, evidence: { items: { id: number, commits: string[] }[], occurrences: number, neverAgain: boolean }, proof: object, drafts: object[] }>}
 */
export async function rigorDraft({ root, config, events, person, agent, parseProcessCensus, reserve = async (row) => row, propose = null }, { key, text, check, red, green, section, sentinel = null }) {
  const malformed = causeProblem(key ?? '');
  if (malformed) throw malformed;
  key = draftPackages().codemap.mappedCause(draftPackages().codemap.historyPathMap(root), key);
  const cause = rigorReport(events, { person, root }).causes.find((entry) => entry.key === key);
  if (!cause) throw new Refused('RIGOR_UNNOTICED', `${key} has not repeated, so there is nothing to draft yet; pullboard rigor lists the causes that can become rules`);
  if (sentinel && (text !== undefined && (!text.trim() || /[\r\n]/u.test(text)))) throw new Refused('USAGE', 'give the watch\'s next step as one line, or leave it out: pullboard rigor draft <key> --sentinel --check "<command>" --red <commit> --green <commit>');
  if (!sentinel && (!text?.trim() || /[\r\n|]/u.test(text))) throw new Refused('USAGE', 'give the rule as one nonempty line without a field separator: pullboard rigor draft <key> "<rule>" --check "<command>" --red <commit> --green <commit>');
  if (cause.reads !== 'work' && / \| /u.test(check ?? '')) throw new Refused('USAGE', 'a spec row gate cannot hold " | "; put the pipeline in a script and name the script in --check');
  const proof = await draftPackages().proof.proveCauseCheck(root, cause, { check, red, green }, { agent, parseProcessCensus });
  const evidence = { items: cause.items, occurrences: cause.occurrences, neverAgain: cause.neverAgain };
  if (sentinel) {
    // A cause a command can watch becomes a pending watch instead of a rule; it cites the repeats and its proof (#776).
    const row = { name: draftPackages().sentinels.rigorSentinelName(key), check: proof.check, every: sentinel.every ?? 'hourly', owner: sentinel.owner ?? 'coordinator',
      next: text?.trim() || `find why ${key} went red again and repair it` };
    const proposed = await propose(row, { key, items: cause.items, occurrences: cause.occurrences,
      proof: { check: proof.check, red: { commit: proof.red.commit, exit: proof.red.exit }, green: { commit: proof.green.commit, exit: proof.green.exit } } });
    return { key, reads: cause.reads, evidence, proof: { check: proof.check, red: proof.red, green: proof.green }, drafts: [], sentinel: proposed };
  }
  const items = cause.items.map((item) => `#${item.id}`).join(', ');
  const why = `Why: rigor ${key.replaceAll('|', '/')} ${cause.neverAgain ? 'was marked never again by the person' : `failed on ${items}`}; red at ${proof.red.commit}, green at ${proof.green.commit}.`;
  const rowText = `${text.trim()} ${why}`;
  const source = rigorSource(cause, proof);
  /** Plan a row, reserve its id on the board, then write it at the reserved id. */
  const write = async (request) => {
    const planned = draftRow(root, config, { ...request, write: false }, { loadDoctrine: draftPackages().doctrine.loadDoctrine });
    return draftRow(root, config, { ...request, id: (await reserve({ ...planned.row, target: request.target })).id }, { loadDoctrine: draftPackages().doctrine.loadDoctrine });
  };
  const drafts = [];
  if (cause.reads !== 'product') drafts.push(await write({ target: 'doctrine', text: rowText, gate: `check ${proof.countCheck}`, fields: ['count: 0', `source: ${source}`], section }));
  if (cause.reads !== 'work') drafts.push(await write({ target: 'spec', text: rowText, gate: proof.check, fields: [`source: ${source}`], section }));
  return { key, reads: cause.reads, evidence, proof: { check: proof.check, red: proof.red, green: proof.green }, drafts };
}

/**
 * pullboard rigor draft (#714): prove the check red then green on real commits, then write the pending
 * row or rows through the spec draft writer. Nothing is approved or applied; the person approves the
 * rows in pullboard view or with pullboard spec approve [D1,D3,S1].
 *
 * @param {any} io
 * @param {{ second?: string, rest: string[], values: any }} args
 * @param {{ root: string, config: any, parseProcessCensus: (stdout: string) => Map<number, any> | null, read: () => { events: any[], actor: string }, reserve: (row: any) => Promise<{ id: string }>, propose?: (row: any, evidence: any) => Promise<any> }} deps
 *   read: the board's events and the asking agent; reserve: the CLI's board reservation; propose: records a
 *   pending watch with its evidence, for --sentinel (#776).
 * @returns {Promise<number>}
 */
export async function rigorDraftCommand(io, { second, rest, values }, { root, config, read, reserve, propose, parseProcessCensus }) {
  if (rest.length > 1) throw new Refused('USAGE', 'pullboard rigor draft <key> "<rule>" --check "<command>" --red <commit> --green <commit> [--section <letter>], or <key> --sentinel [--every hourly] [--owner <seat or lane>]');
  const { events, actor } = read();
  const sentinel = values.sentinel ? { every: values.every, owner: values.owner } : null;
  const result = await rigorDraft({ root, config, events, person: PERSON, agent: actor, reserve, propose, parseProcessCensus },
    { key: second, text: rest[0], check: values.check, red: values.red, green: values.green, section: values.section, sentinel });
  io.result?.(result);
  io.say(`proved ${result.key}: red at ${result.proof.red.commit.slice(0, 12)} (${result.proof.red.problems} problem lines, exit ${result.proof.red.exit}), green at ${result.proof.green.commit.slice(0, 12)} (exit ${result.proof.green.exit})`);
  if (result.sentinel) {
    io.say(`sentinel ${result.sentinel.name}: pending; ${result.sentinel.every}; owner ${result.sentinel.owner}\n  ${result.sentinel.check}`);
    io.say(`next: the person approves it with pullboard sentinel approve ${result.sentinel.name} or in Pullboard View, or declines it with --reason`);
    return 0;
  }
  for (const draft of result.drafts) io.say(`${draft.file}: ${draft.line}`);
  io.say(`next: the person approves ${result.drafts.map((draft) => draft.id).join(' or ')} in pullboard view or with pullboard spec approve; commit ${[...new Set(result.drafts.map((draft) => draft.file))].join(' and ')}`);
  return 0;
}
