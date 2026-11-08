import { requireOwnLaneCheck } from '../lane-check.js';
import { briefFiles } from '../../../../../packages/items/index.js';
import { parseExpectedBuildMinutes } from '../../../../../packages/items/index.js';
import { parseCheckTiming } from '../../../../../packages/items/index.js';
import { criterionSize } from '../../../../../packages/items/index.js';
import { criterionCells } from '../../../../../packages/items/index.js';
import { checkTestFiles } from '../../../../../packages/items/index.js';
import { defaultItemRoute } from '../../../../../packages/items/index.js';
import { ENGINE_VERSION } from '../../../../../packages/state/index.js';
import { TWO_TIER_DIAGNOSIS_ENGINE } from '../../../../../packages/state/index.js';
import { requirePersonChannel } from '../../../../../packages/person/index.js';
import { githubPullClient } from '../../../../../packages/github/index.js';
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
  sayCheckBaseline,
} from '../../../../../packages/gate/index.js';
import {
  isLane,
  laneOf,
} from '../../../../../packages/seats/index.js';
import {
  Refused,
} from '../../../../../packages/kernel/index.js';
import {
  relayCommandReceipt,
  relayCommandReceiptReported,
} from '../../../../../packages/link/index.js';
import {
  idProblems,
  loadSpec,
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
} from '../cli.js';

/**
 * The default route for an add with a check. A diagnosis can only follow the add, so on a board that requires one a
 * light default would refuse DIAGNOSIS_REQUIRED on every plain add; it starts mid, as next already offers it (#3120).
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
    io.result?.({ item: store.getItem(board, id) });
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
  // Before the brief's own lane check, so a coordinator-owned path gets the cross-ownership code and the split, not a bare lane refusal [C7,#2650].
  requireNoCoordinatorPath(ctx.config, me, { by: io.personRequest?.phase === 'execute' ? store.PERSON : me.id, lane: first, title,
    criterion: values.criterion ?? '', check: values.check, brief: briefArg(io, values) ?? '' });
  let item = {
    by: io.personRequest?.phase === 'execute' ? store.PERSON : me.id,
    lane: first,
    title,
    criterion: values.criterion ?? '',
    specIds,
    parentId,
    after,
    brief: briefInLane(ctx, first, briefArg(io, values) ?? ''),
    reviewFamily: values['review-family'],
    ...(values['expected-minutes'] === undefined ? {} : { expectedBuildMinutes: parseExpectedBuildMinutes(values['expected-minutes']) }),
    // Mid needs a brief, which a check naming a test file fills in; with neither, the item is strong (#3178).
    route: values.route ?? (values.check && (checkTestFiles(values.check).length || briefArg(io, values)) ? addedRoute(board, defaultItemRoute(values.criterion ?? '', criterionCells(ctx.info.root))) : 'strong'),
    ...(values.sensitive === undefined ? {} : { sensitive: values.sensitive }),
    ...(values['review-family'] === undefined ? {} : { reviewFamily: values['review-family'] }),
    check: values.check,
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
  const size = criterionSize(item.criterion, criterionCells(ctx.info.root));
  const sizeReason = values['force-size']?.trim();
  if (values['force-size'] !== undefined && !sizeReason) throw new Refused('ITEM_SIZE_REASON', '--force-size needs a nonempty reason', 'use --force-size "why this scope must stay together"');
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
  const { command, brief, evidenceWarnings = [] } = store.validateItemAddition(board, item);
  item.brief = brief;
  if (command) refuseCheckSyntax(command);
  if (command) item.checkBaseline = prepareCheckBaseline(ctx.info.root, command);
  item.barActor = barActorForCommand(ctx, board, { asPerson });
  const id = await ordered(ctx, board, 'addItem', [item]);
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
  io.result?.({ item: store.getItem(board, id), ...(evidenceWarnings.length ? { warnings: evidenceWarnings } : {}) });
  for (const warning of evidenceWarnings) io.err(warning.message);
  io.say(`#${id}`);
  sayCheckBaseline(io, store.getItem(board, id));
  return 0;
});
}

/** Cross-ownership: a bar that names a coordinator-owned path cannot be built by a lane seat, so add and claim refuse it up front [C7,#2650]. */
/** The coordinator's lane and seat id: laneOf gives it every path no lane owns (the queue cell's COORDINATOR). */
const COORDINATOR = 'coordinator';

/** A path-like token: a directory with a trailing slash, a dotted folder, or a file with an extension, or pullboard.json. */
const PATH_TOKEN = /(?:^|[\s`'"(\[,])((?:\.?[\w-]+\/)+(?:[\w.-]*\.[\w-]+|[\w.-]*(?=[\s`'")\],;:]|$))|pullboard\.json)/gu;

/**
 * The path-like tokens in free text, with a leading ./ removed.
 * Why: criterion, check and brief are prose, so only tokens shaped like paths can be judged by lane ownership.
 */
export function pathTokens(text) {
  const tokens = new Set();
  for (const match of String(text ?? '').matchAll(PATH_TOKEN)) {
    const token = match[1].replace(/^\.\//u, '');
    if (token.endsWith('/') || token.includes('.') || token === 'pullboard.json') tokens.add(token);
  }
  return [...tokens];
}

/**
 * The paths an item's criterion, check or brief Files section names that no lane owns, so only the coordinator may change them.
 * Why: add and claim both read all three, so a lane item already on the board whose criterion alone names a
 * coordinator-owned path is refused at claim as it would be at add; `prose: false` reads only the check and Files list.
 *
 * @param {object} config - The frozen policy with its lanes.
 * @param {{ criterion?: string, check?: string, brief?: string }} item - The item's bar.
 * @param {{ prose?: boolean }} [options]
 * @returns {string[]}
 */
export function coordinatorPaths(config, item, { prose = true } = {}) {
  const named = [...(prose ? pathTokens(item.criterion) : []), ...pathTokens(item.check), ...briefFiles(item.brief ?? '').flatMap(file => pathTokens(` ${file}`))];
  return [...new Set(named)].filter(path => laneOf(config, path) === COORDINATOR);
}

/** The next step of a cross-ownership refusal: the lane piece, then the coordinator piece filed --after it. */
export function splitAdvice(lane, title, paths) {
  return `split it: file the lane piece with only ${lane} paths (pullboard add ${lane} "${title}"), then file the coordinator piece `
    + `(pullboard add coordinator "${title}: coordinator piece" --after <lane item id>) naming ${paths.join(', ')}`;
}

/** Refuse a lane item whose bar names a coordinator-owned path; the coordinator and the person may name any path. */
export function requireNoCoordinatorPath(config, me, item, options) {
  if (me.id === COORDINATOR || item.lane === COORDINATOR || item.by === 'person') return;
  const paths = coordinatorPaths(config, item, options);
  if (!paths.length) return;
  throw new Refused('CROSS_OWNERSHIP', `the bar names ${paths.join(', ')}, which no lane owns, so lane ${item.lane} cannot build it`,
    splitAdvice(item.lane, item.title, paths));
}
