import { resolve } from 'node:path';
import { sep } from 'node:path';
import { requireOwnLaneCheck } from '../lane.js';
import {
  COORDINATOR,
  coordinatorPaths,
  requireNoCoordinatorPath,
  splitAdvice,
} from '../item/bar.js';
export {
  barPaths,
  coordinatorPaths,
  pathTokens,
  requireNoCoordinatorPath,
  splitAdvice,
} from '../item/bar.js';
import { itemText } from '../../../../../packages/search/index.js';
import { nearestOpenItems } from '../../../../../packages/search/index.js';
import { searchSidecarPath } from '../../../../../packages/search/index.js';
import { requireBarPathsOnMain } from '../item/bar.js';
import { requireTestMirror } from '../item/bar.js';
import { requireSpecGateRows } from '../item/bar.js';
import { guardDuplicate } from '../item/duplicate.js';
import { guardBar } from '../../../../../packages/state/index.js';
import { addWarnUnnamedTest } from '../../../../../packages/config/index.js';
import { itemsTestMirrorAtAdd } from '../../../../../packages/config/index.js';
import { itemsBarRulesAtAdd } from '../../../../../packages/config/index.js';
import { parseExpectedBuildMinutes } from '../../../../../packages/items/index.js';
import { parseCheckTiming } from '../../../../../packages/items/index.js';
import { criterionSize } from '../../../../../packages/items/index.js';
import { ENGINE_VERSION } from '../../../../../packages/state/index.js';
import { TWO_TIER_DIAGNOSIS_ENGINE } from '../../../../../packages/state/index.js';
import { criterionCells } from '../../../../../packages/items/index.js';
import { checkTestFiles } from '../../../../../packages/items/index.js';
import { shapeRoute } from '../../../../../packages/items/index.js';
import { requirePersonChannel } from '../../../../../packages/person/index.js';
import { githubPullClient } from '../../../../../packages/github/index.js';
import { githubRepository } from '../../../../../packages/github/index.js';
import {
  confirmBarEffect,
  executingBarEffect,
  personBarMode,
} from '../../../../../packages/person/index.js';
import { dependencyValues } from '../../../../../packages/items/index.js';
import {
  referenceAuthors,
  referenceAuthority,
} from '../../../../../packages/spec/index.js';
/** The pullboard add command, in its own module so an item adding another command never edits these lines. */
import * as store from '../../../../../packages/store/index.js';
import {
  prepareCheckBaseline,
  refuseCheckSyntax,
  refuseCheckPullboardTest,
  sayCheckBaseline,
} from '../../../../../packages/gate/index.js';
import {
  isLane,
  listProjects,
} from '../../../../../packages/seats/index.js';
import {
  Refused,
} from '../../../../../packages/kernel/index.js';
import {
  relayCommandReceipt,
  relayCommandReceiptReported,
} from '../../../../../packages/link/index.js';
import {
  gateFiles,
  idProblems,
  loadSpec,
  parseSpec,
} from '../../../../../packages/spec/index.js';
import {
  actOn,
  personMode,
  barActorForCommand,
  briefArg,
  briefInLane,
  buildInFilelessLane,
  idArg,
  idList,
  ordered,
  launchBaseline,
  CHECKOUT_LEASES,
} from '../entry.js';
import { anyRunnerLive } from '../runner/local.js';

/** A path in a bar that leaves this board's folder: absolute, home-relative or climbing out with `../`. */
const LEAVES_BOARD = /(?:^|[\s`'"(\[,])(?:~?\/|\.\.\/)/u;

/**
 * Whether the other-board check can matter: the bar names a path outside this board's folder, or another registered board sits inside it.
 * Why: the guard module loads only then, so a plain one-board add pays no module load for it [C7].
 */
function mayNameOtherBoard(ctx, item) {
  if (LEAVES_BOARD.test([item.criterion, item.check, item.brief].filter(Boolean).join('\n'))) return true;
  const root = resolve(ctx.info.root);
  try { return listProjects({ pruneMissing: false }).some(project => resolve(project.root).startsWith(root + sep)); } catch { return false; }
}

/**
 * The route an add files for a shape route. A diagnosis can only follow the add, so on a board that requires one a light
 * route would refuse DIAGNOSIS_REQUIRED on every plain add; it is filed mid, the route next already offers (#3120, #8628).
 */
function addedRoute(board, route) {
  return route === 'light' && (board.executionEngineVersion ?? ENGINE_VERSION) >= TWO_TIER_DIAGNOSIS_ENGINE ? 'mid' : route;
}

/** Run `pullboard add` and return its exit code. */
export async function run(io, args) {
  const command = 'add';
  const { first, second, rest, values } = args;
  const act = (work) => actOn(io, work, { privateBoard: values.private === true });
  return act(async (ctx, board, me) => {
  const recovered = values.private ? null : await relayCommandReceipt(ctx.info.root, io.relayCommand, io);
  if (recovered) {
    io.recordedMove = true;
    for (const event of recovered.events) io.onEvent?.(event);
    const id = recovered.result;
    const filed = store.getItem(board, id);
    io.result?.({ item: filed, route: filed.item_route, level: filed.item_route, review: filed.item_review_tier ?? 'standard', review_tier: filed.item_review_tier ?? 'standard' });
    io.say(`#${id}`);
    sayCheckBaseline(io, store.getItem(board, id));
    await relayCommandReceiptReported(ctx.info.root, recovered.move.id, io);
    return 0;
  }
  if (!first || !isLane(ctx.config, first)) throw new Refused('NO_LANE', `no lane "${first ?? ''}"; see: pullboard lanes`);
  const specIds = idList(values.specs);
  const problems = idProblems(loadSpec(ctx.info.root, ctx.config), specIds, ctx.doctrine);
  if (problems.length) throw new Refused('UNKNOWN_SPEC', `${problems.join('; ')}`);
  const parentId = values.parent ? idArg(values.parent, 'a parent item id') : null;
  const after = dependencyValues(idList(values.after));
  const title = [second, ...rest].filter(Boolean).join(' ');
  const wholeBar = { criterion: values.criterion ?? '', check: values.check, brief: briefArg(io, values) ?? '' };
  // With --split-coordinator the coordinator-owned part of the bar leaves for its own item, filed after this one [C7,#3246].
  const split = values['split-coordinator'] === true ? splitBar(ctx.config, wholeBar) : null;
  if (split?.paths.length && !split.lane.criterion.trim()) throw new Refused('CROSS_OWNERSHIP', `every clause of the bar names ${split.paths.join(', ')}, which no lane owns, so lane ${first} has nothing to build`,
    splitAdvice(first, title, split.paths));
  const laneBar = split ? split.lane : wholeBar;
  // Before the brief's own lane check, so a coordinator-owned path gets the cross-ownership code and the split, not a bare lane refusal [C7,#2650].
  requireNoCoordinatorPath(ctx.config, me, { by: io.personRequest?.phase === 'execute' ? store.PERSON : me.id, lane: first, title, ...laneBar });
  let item = {
    by: io.personRequest?.phase === 'execute' ? store.PERSON : me.id,
    lane: first,
    title,
    criterion: laneBar.criterion,
    specIds,
    parentId,
    after,
    brief: briefInLane(ctx, first, laneBar.brief),
    reviewFamily: values['review-family'],
    ...(values.readiness === undefined ? {} : { readinessCommand: values.readiness }),
    ...(values['expected-minutes'] === undefined ? {} : { expectedBuildMinutes: parseExpectedBuildMinutes(values['expected-minutes']) }),
    // Light when the shape is small, proven and briefed, otherwise strong; an explicit --route wins [C7,#3081].
    route: values.route ?? addedRoute(board, shapeRoute({ criterion: values.criterion ?? '', check: values.check,
      // A check naming a test file fills the brief, so it counts as one.
      brief: briefArg(io, values) || (values.check && checkTestFiles(values.check).length ? 'filled from the check' : '') })),
    ...(values.sensitive === undefined ? {} : { sensitive: values.sensitive }),
    ...(values['review-family'] === undefined ? {} : { reviewFamily: values['review-family'] }),
    check: laneBar.check,
    ...(values['check-timing'] === undefined ? {} : { checkTiming: parseCheckTiming(values['check-timing']) }),
  };
  const sealed = executingBarEffect(ctx, board, 'add');
  if (sealed) item = { ...sealed };
  if (sealed) {
    const sealedProblems = idProblems(loadSpec(ctx.info.root, ctx.config), item.specIds, ctx.doctrine);
    if (sealedProblems.length) throw new Refused('UNKNOWN_SPEC', sealedProblems.join('; '));
    briefInLane(ctx, item.lane, item.brief);
  }
  const asPerson = personBarMode(ctx, board, me, values, personMode);
  const barWarnings = guardBar(item.criterion, { allowLong: Boolean(values['force-size']?.trim()), warnUnnamedTest: addWarnUnnamedTest(), brief: item.brief });
  const size = criterionSize(item.criterion, criterionCells(ctx.info.root));
  const sizeReason = values['force-size']?.trim();
  if (values['force-size'] !== undefined && !sizeReason) throw new Refused('ITEM_SIZE_REASON', '--force-size needs a nonempty reason', 'use --force-size "why this scope must stay together"');
  // Only the person grants size overrides; an agent or the coordinator splits the item instead [C7].
  if (sizeReason && !asPerson) throw new Refused('ITEM_FORCE_SIZE_PERSON', '--force-size is a size override only the person grants', 'split the item with --after into pieces of 30 minutes or less, or ask the person');
  if (size.oversized && !sizeReason) throw new Refused('ITEM_TOO_LARGE', `criterion names ${size.cells.length} cells and ${size.clauses} clauses (size ${size.score})`,
    `split it into one item per named cell (${size.cells.join(', ') || 'none'}) and at most three numbered clauses per item; or use --force-size "reason"`);
  const confirmed = await confirmBarEffect(ctx, board, me, { verb: 'add', args: {
    lane: item.lane, title: item.title, ...(values.wait ? { wait: true } : {}), as: 'person',
  } }, item, asPerson);
  if (confirmed !== null) return confirmed;
  buildInFilelessLane(ctx.config, item.lane, item.after);
  const authority = referenceAuthority(ctx, me.id, item.brief, undefined, { requirePersonChannel });
  if (authority) item.referenceAuthority = authority;
  const authors = referenceAuthors(ctx.info.root, item.brief, { githubPullClient });
  if (authors.length) item.referenceAuthors = authors;
  requireOwnLaneCheck(ctx.config, me, item.lane, item.check);
  requireNoCoordinatorPath(ctx.config, me, item);
  if (item.check) refuseCheckPullboardTest(item.check);
  await requireBarPathsOnMain(ctx, { criterion: item.criterion, check: item.check });
  await requireTestMirror(ctx, { criterion: item.criterion, check: item.check }, itemsTestMirrorAtAdd());
  await requireSpecGateRows(ctx, { criterion: item.criterion }, itemsBarRulesAtAdd(), asPerson || me.id === COORDINATOR, { parseSpec, gateFiles });
  const { command, brief, evidenceWarnings = [] } = store.validateItemAddition(board, item);
  item.brief = brief;
  if (command) refuseCheckSyntax(command);
  if (command) item.checkBaseline = prepareCheckBaseline(ctx.info.root, command);
  if (command) store.guardGreenCheck(board, item.checkBaseline, values['accept-green']);
  item.barActor = barActorForCommand(ctx, board, { asPerson });
  const differs = guardDuplicate(ctx, board, item, values['not-duplicate-of']);
  // The guard module loads only when the bar can name another board's files (or --here is given), so a one-board add pays nothing for it [C7].
  const elsewhere = values.here !== undefined || mayNameOtherBoard(ctx, item) ? (await import('../item/other-board.js')).guardOtherBoard(ctx, item, values.here) : null;
  const id = await ordered(ctx, board, 'addItem', [item]);
  if (elsewhere) await ordered(ctx, board, 'appendFact', [id, { agentId: me.id, kind: 'note', text: `Filed here though its files belong to the ${elsewhere.boards.join(', ')} board: ${elsewhere.reason}` }]);
  if (differs) await ordered(ctx, board, 'appendFact', [id, { agentId: me.id, kind: 'note', text: `Not a duplicate of #${differs.id}: ${differs.reason}` }]);
  const piece = split?.paths.length ? await fileCoordinatorPiece(ctx, board, { id, item, split, title, specIds }) : null;
  if (sizeReason) await ordered(ctx, board, 'appendFact', [id, { agentId: me.id, kind: 'note',
    text: `Criterion size override: ${sizeReason}\n${JSON.stringify(size)}` }]);
  if (item.checkBaseline?.result === 'pending') {
    const exited = await launchBaseline(ctx, board, id, item.checkBaseline, { wait: Boolean(values.wait) });
    if (values.wait) {
      // The recorded move is complete; do not hold checkout authority while the worker measures.
      CHECKOUT_LEASES.get(io)?.release();
      CHECKOUT_LEASES.delete(io);
      // Return only after the worker has exited: its result commit is not its last write, and a write
      // after this point would race the next command's claim (BOARD_BUSY).
      await exited;
    }
  }
  const warnings = [...evidenceWarnings, ...barWarnings];
  const filed = store.getItem(board, id);
  io.result?.({ item: filed, route: filed.item_route, level: filed.item_route, review: filed.item_review_tier ?? 'standard', review_tier: filed.item_review_tier ?? 'standard', ...(piece === null ? {} : { coordinatorPiece: store.getItem(board, piece) }), ...(warnings.length ? { warnings } : {}) });
  for (const warning of warnings) io.err(`warning: [${warning.code ?? 'BAR'}] ${warning.message}`);
  io.say(`#${id}`);
  if (piece !== null) io.say(`#${piece} coordinator piece, after #${id}`);
  sayCheckBaseline(io, store.getItem(board, id), { runnerLive: anyRunnerLive() });
  sayRelated(io, ctx, board, id, item);
  return 0;
});
}

/**
 * Print the nearest open items to a new item as quiet advice after it is filed.
 * Why here and never inside the move: advice must not cost the move any time or fail it; a missing or broken index prints nothing.
 */
function sayRelated(io, ctx, board, id, item) {
  let related;
  try {
    related = nearestOpenItems(board, itemText(item), { sidecar: searchSidecarPath(ctx.info.root, ctx.info.commonDir), exclude: [id], limit: 3 });
  } catch { return; }
  if (!related.length) return;
  // Quiet advice: stderr in text mode and a diagnostics entry in JSON, so the one `#id` line on stdout stays what scripts read.
  io.err('related open items:');
  for (const row of related) io.err(`  ${row.score.toFixed(3)}  #${row.id}  ${row.title}`);
}

/**
 * File the coordinator piece of a split add: the clauses, check and files no lane owns, waiting on the lane item.
 * Why: the lane item is already filed when this runs, so a seat whose grant cannot file into the coordinator lane gets the
 * exact command that finishes the split instead of a bare grant refusal and a lane item with no partner [C7,#3246].
 *
 * @returns {Promise<number>} The coordinator piece's item id.
 */
async function fileCoordinatorPiece(ctx, board, { id, item, split, title, specIds }) {
  const piece = { ...item, lane: COORDINATOR, title: `${title}: coordinator piece`, criterion: split.coordinator.criterion, check: split.coordinator.check,
    brief: split.coordinator.brief, after: [id], specIds, route: 'strong' };
  delete piece.checkBaseline;
  const { command, brief } = store.validateItemAddition(board, piece);
  piece.brief = brief;
  if (command) refuseCheckSyntax(command);
  if (command) piece.checkBaseline = prepareCheckBaseline(ctx.info.root, command);
  try { return await ordered(ctx, board, 'addItem', [piece]); }
  catch (error) {
    if (!String(error?.code).startsWith('AGENT_GRANT_')) throw error;
    throw new Refused('CROSS_OWNERSHIP', `#${id} is filed with the lane part of the bar, but this seat cannot file the coordinator piece (${error.code})`,
      `claim #${id}, then run: pullboard add coordinator "${piece.title}" --after ${id} with the coordinator part of the bar naming ${split.paths.join(', ')}`);
  }
}

/** Split a criterion into its numbered clauses; text before the first number is a preamble kept on both sides. */
function criterionClauses(criterion) {
  const text = String(criterion ?? '');
  const marks = [...text.matchAll(/(?:^|\s)\d+\.\s/gu)];
  if (!marks.length) return { preamble: '', clauses: [text.trim()].filter(Boolean), numbered: false };
  const clauses = marks.map((mark, at) => text.slice(mark.index + mark[0].length, at + 1 < marks.length ? marks[at + 1].index : undefined).trim());
  return { preamble: text.slice(0, marks[0].index).trim(), clauses, numbered: true };
}

/** Join clauses back into a criterion, numbering them again when the original was numbered. */
function joinClauses({ preamble, numbered }, clauses) {
  if (!clauses.length) return '';
  const body = numbered ? clauses.map((clause, at) => `${at + 1}. ${clause}`).join(' ') : clauses.join(' ');
  return preamble ? `${preamble} ${body}` : body;
}

/**
 * Divide a bar between the lane and the coordinator: clauses, brief lines and the check that name a coordinator-owned
 * path go to the coordinator piece, everything else stays with the lane item. A brief line under a section other than
 * Files (Test, notes) is kept by the coordinator piece too, so it still shows how the piece is proved.
 *
 * @param {object} config - The frozen policy with its lanes.
 * @param {{ criterion: string, check?: string, brief: string }} bar - The whole bar as given.
 * @returns {{ paths: string[], lane: object, coordinator: object }}
 */
export function splitBar(config, bar) {
  const owned = text => coordinatorPaths(config, { criterion: text }).length > 0;
  const parts = criterionClauses(bar.criterion);
  const checkOwned = bar.check !== undefined && coordinatorPaths(config, { check: bar.check }).length > 0;
  let section = '';
  const laneLines = [];
  const pieceLines = [];
  for (const line of String(bar.brief ?? '').split('\n')) {
    const header = /^(\w[\w ]*):/u.exec(line);
    if (header) { section = header[1].toLowerCase(); laneLines.push(line); pieceLines.push(line); continue; }
    if (section === 'files' && owned(line)) { pieceLines.push(line); continue; }
    laneLines.push(line);
    if (section !== 'files') pieceLines.push(line);
  }
  return { paths: coordinatorPaths(config, { criterion: bar.criterion, check: bar.check, brief: bar.brief }),
    lane: { criterion: joinClauses(parts, parts.clauses.filter(clause => !owned(clause))), check: checkOwned ? undefined : bar.check, brief: laneLines.join('\n') },
    coordinator: { criterion: joinClauses(parts, parts.clauses.filter(owned)), check: checkOwned ? bar.check : undefined, brief: pieceLines.join('\n') } };
}

/** The one GitHub read client and repository resolver the commands share, so contribute check --issue reaches GitHub through this front-door import and adds no client of its own. */
export { githubPullClient, githubRepository };
