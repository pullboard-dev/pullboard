import { seatFamily } from '../../../../packages/items/index.js';
/** Helpers for `pullboard blueprint`: adding a blueprint and its private names. Split from src/cli.js, which re-exports it [C7]. */
import { readFileSync } from 'node:fs';
import { hostname } from 'node:os';
import { join } from 'node:path';
import * as store from '../../../../packages/store/index.js';
import { context } from './context.js';
import { withBoard } from './context.js';
import { CONFIG_FILE } from '../../../../packages/config/index.js';
import { COORDINATOR } from '../../../../packages/config/index.js';
import { displayAgentName } from '../../../../packages/seats/index.js';
import { restoreRowApply } from '../../../../packages/spec/index.js';
import { writeRowApply } from '../../../../packages/spec/index.js';
import { tryGit } from '../../../../packages/git/index.js';
import { askedLaneNotes } from './init.js';
import { proposeLanes } from './init.js';
import { starterLane } from './init.js';
import { starterLaneNotes } from './init.js';
import { Refused } from '../../../../packages/kernel/index.js';
import { loadSpec } from '../../../../packages/spec/index.js';
import { readSignoffs } from '../../../../packages/spec/index.js';
import { landBlueprint } from '../../../../packages/blueprints/index.js';
import { planBlueprint } from '../../../../packages/blueprints/index.js';
import { starterCheck } from '../../../../packages/blueprints/index.js';
import { readBlueprint } from '../../../../packages/blueprints/index.js';
import { repoAnswers } from '../../../../packages/blueprints/index.js';
import { blueprintStarterNote } from '../../../../packages/blueprints/index.js';
import { sharedRowLines } from '../../../../packages/blueprints/index.js';
import { ENGINE_VERSION } from '../../../../packages/state/index.js';
import { TWO_TIER_DIAGNOSIS_ENGINE } from '../../../../packages/state/index.js';
import { ordered } from './claim.js';
import { whoAmI } from './join.js';

/**
 * Add a blueprint to the board of the checkout io.cwd names, exactly as pullboard blueprint add
 * does; init --blueprint calls it after setting up the repo. With report false it prints nothing
 * and leaves the command's JSON result to the caller. A caller that already read the blueprint
 * passes it, so the file is read once: init checks it before writing anything and must add the
 * very blueprint it checked.
 *
 * @param {any} io
 * @param {string} reference - A bundled blueprint name or a path to a blueprint file, relative to io.cwd.
 * @param {{ report?: boolean, blueprint?: ReturnType<typeof readBlueprint>, drafted?: Map<string, string> }} [options] - drafted: see addBlueprint.
 * @returns {Promise<BlueprintAdded>}
 */
export async function addBlueprintHere(io, reference, { report = true, blueprint = readBlueprint(reference, io.cwd), drafted } = {}) {
  const ctx = context(io);
  return await withBoard(ctx, async (board) => await addBlueprint(ctx, board, whoAmI(ctx, board), blueprint, { report, drafted }));
}

/**
 * @typedef {object} BlueprintAdded
 * @property {{ name: string, title: string, version: number }} blueprint
 * @property {string} section - The SPEC.md section heading the rows are in.
 * @property {{ key: string, id: string, status: string, text: string, source?: string }[]} rows - New rows; each waits for the person, with the source its rule names.
 * @property {{ id: number, key: string, title: string, lane: string, askedLane?: string, specIds: string[], after: number[], check?: string }[]} items - New open items.
 * @property {string | null} gate - The gate set in pullboard.json, or null when it was left alone.
 * @property {boolean} marked - This blueprint version was already on the board, so nothing was added.
 * @property {number[]} checksNotRun - New items that carry a check; no check baseline ran for them.
 * @property {{ name: string, owns: string[] }[]} proposedLanes - Proposed, unwritten lanes new starters were filed in.
 * @property {{ key: string, id: string }[]} shared - Keys that cite a row an earlier blueprint in the same command drafted.
 */

/**
 * The route a starter is filed on. Once light needs a diagnosis, which only follows the add, a light
 * starter is filed mid, the route plain add gives it (#3120), so the blueprint add is not refused.
 *
 * @param {object} board
 * @param {string} route
 * @returns {string}
 */
function filedRoute(board, route) {
  return route === 'light' && (board.executionEngineVersion ?? ENGINE_VERSION) >= TWO_TIER_DIAGNOSIS_ENGINE ? 'mid' : route;
}

/**
 * Add a blueprint to this board in one step (I1): its rules and questions as draft and pending rows
 * in a new SPEC.md section, its starter items as open items citing them, and its gate when
 * pullboard.json has none. Rows are written the way spec draft writes them, so nothing is approved;
 * a repeat of the same blueprint version adds nothing.
 *
 * @param {any} ctx
 * @param {any} board
 * @param {{ id: string }} me
 * @param {import('../../../../packages/blueprints/index.js').Blueprint} blueprint
 * @param {{ report?: boolean, result?: boolean, drafted?: Map<string, string> }} [options] - report false prints nothing and sets no
 *   JSON result; result false prints but sets none. drafted: rows earlier blueprints of this command drafted, by text (#720).
 * @returns {Promise<BlueprintAdded>}
 */
export async function addBlueprint(ctx, board, me, blueprint, { report = true, result = report, drafted = new Map() } = {}) {
  const io = report ? (result ? ctx.io : { say: (text) => ctx.io.say(text) }) : { say: () => {} };
  const spec = loadSpec(ctx.info.root, ctx.config);
  if (!spec.exists) throw new Refused('NO_SPEC', `no ${ctx.config.spec}; run: pullboard init`);
  const malformed = [[spec.file, spec.problems], [ctx.doctrine.repo.file, ctx.doctrine.repo.problems]].find(([, problems]) => problems.length);
  if (malformed) throw new Refused('SPEC_INVALID', `fix the unparsed row in ${malformed[0]} before adding a blueprint; an existing id may be ambiguous`);
  const source = readFileSync(spec.file, 'utf8');
  const configFile = join(ctx.info.root, CONFIG_FILE);
  const configSource = readFileSync(configFile, 'utf8');
  // A question takes the answer this repo already shows as its default, read from package.json
  // only: nothing runs and nothing is fetched (#725).
  const plan = planBlueprint(landBlueprint(blueprint, repoAnswers(ctx.info.root)), { source, spec, doctrine: ctx.doctrine,
    existingItems: store.listItems(board, { all: true }).map((item) => ({ id: item.item_id, title: item.item_title, specIds: item.item_spec_ids ? item.item_spec_ids.split(',') : [] })),
    gate: String(JSON.parse(configSource).gate ?? ''), drafted, reserved: store.rowDrafts(board).map((draft) => draft.id) });
  for (const row of plan.rows) drafted.set(row.text, row.id);
  // Every starter is checked before anything is written, so a refusal leaves the board as it was.
  // Starters go to a build lane, never the coordinator's; a proposed lane is named, not written (#732).
  const proposals = proposeLanes(ctx.info.root, ctx.config);
  const lanes = plan.items.map((entry) => starterLane(entry.lane, ctx.config, proposals));
  const proposedLanes = proposals.filter((lane) => lanes.some((placed) => placed.proposal === lane));
  const starters = plan.items.map((entry, index) => ({ key: entry.key, afterKeys: entry.after, asked: lanes[index].asked, item: { by: me.id, lane: lanes[index].lane,
    title: entry.title, criterion: entry.criterion, specIds: entry.specIds, parentId: null, after: [], brief: entry.brief, route: filedRoute(board, entry.route),
    ...(entry.check === undefined ? {} : { check: starterCheck(blueprint, entry.check, lanes[index], ctx.config) }) } }));
  // Bundled checks are scoped at placement; add stores checks without executing them or starting a baseline.
  // Every bundled starter carries a check (#724), and only the coordinator sets one, so an agent's
  // add is refused with the step that works: add it from the coordinator's checkout.
  if (me.id !== COORDINATOR && starters.some(({ item }) => item.check !== undefined)) {
    throw new Refused('COORDINATOR_CHECK', `the ${blueprint.name} blueprint's starter items carry checks, and only the coordinator sets an item check; run pullboard blueprint add from the main checkout, or ask your coordinator: pullboard shout coordinator --kind question "please add the ${blueprint.name} blueprint"`,
      'run the same pullboard blueprint add from the main checkout, where the coordinator works');
  }
  for (const { item } of starters) store.validateItemAddition(board, item);
  // Each new row's id is reserved on the board before SPEC.md names it; if another writer took one first, this add runs again for the next ids (#878).
  for (const row of plan.rows) if ((await ordered(ctx, board, 'draftSpecRow', [{ agentId: me.id, row: { id: row.id, text: row.text, target: 'spec' }, written: true }])).id !== row.id) throw new Refused('ROW_ID_TAKEN', `${row.id} was just reserved by another writer; run the same pullboard blueprint add again for the next free id`);
  const files = [];
  if (plan.specRows !== source) files.push({ file: ctx.config.spec, before: source, after: plan.specRows });
  if (plan.gate) {
    const newline = configSource.includes('\r\n') ? '\r\n' : '\n';
    files.push({ file: CONFIG_FILE, before: configSource,
      after: `${JSON.stringify({ ...JSON.parse(configSource), gate: plan.gate }, null, 2).replaceAll('\n', newline)}${newline}` });
  }
  const write = { records: [], files, signoffs: { before: null, receipts: [] } };
  writeRowApply(ctx.info.root, write);
  const added = [];
  try {
    // A retry starts from the starters a failed add already put on the board.
    const byKey = { ...plan.existing };
    for (const { key, afterKeys, asked, item } of starters) {
      item.after = afterKeys.map((before) => byKey[before]).filter(Boolean);
      const id = await ordered(ctx, board, 'addItem', [item]);
      byKey[key] = id;
      // The starter keeps its blueprint's name, in the link #734 reads back (#720).
      await ordered(ctx, board, 'appendFact', [id, { agentId: me.id, kind: 'note', text: blueprintStarterNote(blueprint, key) }]);
      added.push({ id, key, title: item.title, lane: item.lane, ...(asked ? { askedLane: asked } : {}), specIds: item.specIds, after: item.after, ...(item.check ? { check: item.check } : {}) });
    }
  } catch (error) {
    // Items already added stay on the board; with no marker yet, a retry adds only what is missing.
    if (!added.length) restoreRowApply(ctx.info.root, write);
    throw error;
  }
  // The marker goes in last, once every row and item is on the board.
  if (plan.specAfter !== plan.specRows) {
    writeRowApply(ctx.info.root, { records: [], files: [{ file: ctx.config.spec, before: plan.specRows, after: plan.specAfter }], signoffs: { before: null, receipts: [] } });
  }
  if (plan.specAfter !== source && !files.some((file) => file.file === ctx.config.spec)) files.unshift({ file: ctx.config.spec });
  const rows = plan.rows.map(({ key, id, status, text, source }) => ({ key, id, status, text, ...(source ? { source } : {}) }));
  const summary = { blueprint: { name: blueprint.name, title: blueprint.title, version: blueprint.version },
    section: plan.section.name, rows, items: added.map((item) => ({ ...item, blueprint: blueprint.name })), gate: plan.gate, shared: plan.shared, marked: plan.marked, proposedLanes: added.length ? proposedLanes : [],
    // Item checks are stored and never run during add; the caller tells the reader so.
    checksNotRun: added.filter((item) => item.check).map((item) => item.id) };
  io.result?.(summary);
  if (plan.marked) {
    io.say(`${blueprint.title} (version ${blueprint.version}) is already on this board; nothing added; see its starters with pullboard blueprint starters ${blueprint.name}`);
    // A board an older Pullboard set up gets the blueprint's kind recorded beside its marker (#720).
    if (plan.specRows !== source) io.say(`  recorded its kind (${blueprint.kind ?? 'none'}) in ${ctx.config.spec}; commit ${ctx.config.spec}`);
    return summary;
  }
  io.say(`added ${blueprint.title} (version ${blueprint.version}) as drafts in ${ctx.config.spec}, section ${plan.section.name}`);
  for (const row of rows) io.say(`  ${row.id} ${row.status}  ${row.text}`);
  for (const item of added) io.say(`  #${item.id} open  ${item.title}${item.specIds.length ? `  cites ${item.specIds.join(', ')}` : ''}${item.after.length ? `  waits on #${item.after.join(', #')}` : ''}`);
  const checked = added.filter((item) => item.check);
  if (checked.length) io.say(`  checks stored, not run: ${checked.map((item) => `#${item.id}`).join(', ')}; no check baseline ran during add, so read each check before work starts: pullboard show <id>`);
  for (const note of [...askedLaneNotes(added, ctx.config), ...starterLaneNotes(summary.proposedLanes)]) io.say(`  ${note}`);
  if (plan.gate) io.say(`  gate set in ${CONFIG_FILE}: ${plan.gate}`);
  for (const line of sharedRowLines(summary)) io.say(`  ${line}`);
  const changed = files.map((file) => file.file);
  io.say(`next: the person approves the rows in pullboard view or with pullboard spec approve <ids>${changed.length ? `; commit ${changed.join(' and ')}` : ''}`);
  return summary;
}

/**
 * Every private name a saved blueprint must never carry: each agent's id, display name, model
 * and family, the person's Git name and email, everyone who signed off or signs rows, and this
 * machine's host name, whole, plus the parts of each (a first name, an email's user) to match
 * only as written. Missing sources add nothing; they never stop the save [S1].
 */
export function privateNames(root, board, spec) {
  const names = new Set();
  const parts = new Set();
  const add = (value) => {
    const text = typeof value === 'string' ? value.trim() : '';
    // "unknown" is the label for an undeclared model, not anyone's name.
    if (!text || text === 'unknown') return;
    names.add(text);
    for (const part of text.split(/[\s@.<>()]+/u)) if (part.length >= 3 && part !== 'unknown' && part !== text) parts.add(part);
  };
  for (const agent of store.listAgents(board)) {
    add(agent.agent_id); add(agent.agent_model); add(seatFamily(board, agent.agent_id)); add(displayAgentName(agent)); add(displayAgentName(agent, 'prefix'));
  }
  for (const key of ['user.name', 'user.email']) add(tryGit(root, ['config', '--get', key]).stdout);
  for (const ident of ['GIT_AUTHOR_IDENT', 'GIT_COMMITTER_IDENT']) {
    const found = /^(.*?)\s*<([^>]*)>/u.exec(tryGit(root, ['var', ident]).stdout ?? '');
    if (found) { add(found[1]); add(found[2]); }
  }
  try { for (const record of readSignoffs(root)) add(record.by); } catch { /* An unreadable sign-off file adds no names. */ }
  for (const row of spec.rows) for (const signer of row.signers ?? []) add(signer);
  add(hostname());
  add(hostname().split('.')[0]);
  return { names: [...names], parts: [...parts] };
}
