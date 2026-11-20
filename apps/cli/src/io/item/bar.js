/** Bars a builder cannot satisfy: a check or criterion naming paths missing from main [C7]. */
import { tryGit } from '../../../../../packages/git/index.js';
import { Refused } from '../../../../../packages/kernel/index.js';
import { trunkBranch } from './folder.js';
import { laneOf } from '../../../../../packages/seats/index.js';
import { isConfigFile } from '../../../../../packages/config/browser.js';
import { briefFiles } from '../../../../../packages/items/index.js';
import { outsideBuildProblem } from '../../../../../packages/items/index.js';

/** The coordinator's lane and seat id: laneOf names it for every path no lane owns. */
export const COORDINATOR = 'coordinator';

/**
 * The paths a bar names that the build cannot reach on main: absent from main and owned by no lane, such as the test/ and
 * bin/ layout the Cells move retired, which no seat may recreate. Why: 284 live items named such paths and every core
 * seat stopped on one; a path absent from main inside a lane's folders is how a bar asks for a new file, so it stays allowed.
 *
 * @param {{ criterion?: string, check?: string }} bar - Its check and criterion; a brief's file list is guidance, not the bar.
 * @param {(paths: string[]) => Set<string>} present - Which of these paths exist on main.
 * @param {(path: string) => boolean} owned - Whether a lane owns the path.
 * @param {Function} barPaths - The add command's path reader, passed in so the claim path never loads the add command.
 * @returns {string[]}
 */
export function missingBarPaths(bar, present, owned, barPaths) {
  const named = barPaths({ criterion: bar.criterion, check: bar.check }).filter(path => path !== 'pullboard.json');
  if (!named.length) return [];
  const found = present(named);
  return named.filter(path => !found.has(path.replace(/\/$/u, '')) && !owned(path));
}

/**
 * Which of `paths` (files or folders) exist on the trunk, from one Git listing of its tree;
 * every path when the trunk cannot be read, so an unreadable repository never refuses a bar.
 *
 * @param {string} root
 * @returns {(paths: string[]) => Set<string>}
 */
export function onTrunk(root) {
  return paths => {
    const clean = paths.map(path => path.replace(/\/$/u, ''));
    const listed = tryGit(root, ['ls-tree', '-r', '--name-only', trunkBranch(root)]);
    if (listed.status !== 0) return new Set(clean);
    const folders = new Set(), files = new Set(listed.stdout.split('\n').filter(Boolean));
    for (const file of files) for (let at = file.indexOf('/'); at > 0; at = file.indexOf('/', at + 1)) folders.add(file.slice(0, at));
    return new Set(clean.filter(path => files.has(path) || folders.has(path)));
  };
}

/** The BAR_PATH_MISSING refusal for a bar naming paths missing from main, or null. */
export async function missingPathRefusal(ctx, bar) {
  const missing = missingBarPaths(bar, onTrunk(ctx.info.root), path => laneOf(ctx.config, path) !== COORDINATOR, barPaths);
  return missing.length ? new Refused('BAR_PATH_MISSING', `the bar names ${missing.join(', ')}, missing from main, so no build can satisfy it`,
    'name the paths where they live on main now (pullboard edit <id> --criterion/--check/--brief), or withdraw the item') : null;
}

/**
 * Refuse a bar that names a new test file the layout rule would call a test-mirror violation, naming the mirror path (#10629).
 * Why: a frozen path that mirrors no source file fails the commit's LAYOUT_RATCHET, so the coordinator had to re-bar it; add
 * and edit catch it first. The codemap door loads lazily so the claim path that shares this module never pays for it.
 *
 * @param {any} ctx
 * @param {{ criterion?: string, check?: string }} bar
 * @param {boolean} on The items.testMirrorAtAdd machine setting; off accepts any path.
 */
export async function requireTestMirror(ctx, bar, on) {
  if (!on) return;
  const listed = tryGit(ctx.info.root, ['ls-tree', '-r', '--name-only', trunkBranch(ctx.info.root)]);
  if (listed.status !== 0) return;
  const tracked = listed.stdout.split('\n').filter(Boolean);
  const named = barPaths({ criterion: bar.criterion, check: bar.check });
  const { newTestMirrorFindings, isDefaultTestFile } = await import('../../../../../packages/codemap/index.js');
  requireRegistryRecord(tracked, named, isDefaultTestFile);
  const { bad, use } = newTestMirrorFindings(tracked, named);
  if (!bad.length) return;
  throw new Refused('LAYOUT_TEST_MIRROR', `the bar names ${bad.join(', ')}, a new test file that mirrors no source file`,
    use ? `name ${use}, the test that mirrors the source file the bar names, or put the cases in an existing test of that source`
      : 'name a test under tests/<logic|io>/ for the src/<logic|io>/ file it proves, or put the cases in an existing test of that source');
}

/**
 * Refuse a bar whose test file sits in a strict-registry cell (its tests folder holds a registry.test.js) while the bar names
 * none of that cell's fixtures registry records (#10677).
 * Why: a bare `clause N:` title in such a cell turned main red on 17 Nov; the refusal names the record file and the ID prefix.
 *
 * @param {string[]} tracked Every file on main.
 * @param {string[]} named The paths the bar names.
 * @param {(path: string) => boolean} isTest The codemap's test-file predicate, passed in so this module never names a test file itself.
 */
export function requireRegistryRecord(tracked, named, isTest) {
  for (const path of named) {
    const at = path.lastIndexOf('/tests/');
    if (at < 0 || !isTest(path) || path.slice(at).startsWith('/tests/registry')) continue;
    const cell = path.slice(0, at);
    if (!tracked.some(file => file.startsWith(`${cell}/tests/registry`) && isTest(file))) continue;
    if (named.some(other => other.startsWith(`${cell}/tests/fixtures/registry`) && other.endsWith('.json'))) continue;
    const record = `${cell}/tests/fixtures/registry.json`;
    throw new Refused('REGISTRY_TEST_ID', `the bar names ${path}, a test in a strict-registry cell, but not its registry record ${record}`,
      `name ${record} in the bar and title each test <cell id>.<area>.<name>: clause N: ..., not a bare clause N title`);
  }
}

/**
 * Refuse a bar that names a file on main which a lane other than the item's owns, LANE_FOREIGN_PATH (#11739).
 * Why: pre-commit refuses such a change as OUTSIDE_LANE, so the claim cost a builder a full cycle; add and edit catch it first.
 * Paths missing from main stay with BAR_PATH_MISSING, coordinator-owned paths with CROSS_OWNERSHIP, shared paths are open to
 * every lane, and the coordinator and the person may name any path.
 *
 * @param {any} ctx
 * @param {{ id: string }} me The filing seat.
 * @param {{ lane: string, criterion?: string, check?: string, by?: string }} item
 * @param {boolean} on The items.barRulesAtAdd machine setting; off accepts the bar as written.
 */
export function requireBarInLane(ctx, me, item, on) {
  if (!on || me.id === COORDINATOR || item.lane === COORDINATOR || item.by === 'person') return;
  const named = barPaths({ criterion: item.criterion, check: item.check });
  if (!named.length) return;
  const found = onTrunk(ctx.info.root)(named);
  const foreign = named.filter(path => found.has(path.replace(/\/$/u, '')) && !ctx.config.shared.some(prefix => path.startsWith(prefix)))
    .map(path => ({ path, owner: laneOf(ctx.config, path) })).filter(({ owner }) => owner !== COORDINATOR && owner !== item.lane);
  if (!foreign.length) return;
  const owners = [...new Set(foreign.map(({ owner }) => owner))];
  throw new Refused('LANE_FOREIGN_PATH', `the bar names ${foreign.map(({ path, owner }) => `${path} (${owner}'s)`).join(', ')}, which lane ${item.lane} does not own`,
    `file it in the owning lane (${owners.join(', ')}), or split it into the ${item.lane} piece and the ${owners.join('/')} piece filed with --after the first`);
}

/** A pass-with-no-tests flag of a test runner: the check goes green when the named test file does not exist. */
const PASS_EMPTY_FLAG = /--(?:passWithNoTests|pass-with-no-tests)\b/u;

/** A path shaped like a test file: under a tests folder, or named test or spec. */
const TEST_SHAPED = /(?:^|\/)(?:tests?|__tests__)\/|[._-](?:test|spec)\./u;

/**
 * Refuse a check that passes with no tests while its test file is absent from main, behind items.barRulesAtAdd (#11779).
 * Why: a check green on no tests proved nothing before any work existed, and the baseline guard only runs after add returns.
 * A check already guarded by `test -f <file> &&`, one without the flag, a test file on main and --accept-green all stay accepted.
 *
 * @param {any} ctx
 * @param {{ check?: string }} bar
 * @param {boolean} on The items.barRulesAtAdd machine setting; off accepts any check.
 * @param {string} [acceptGreen] The --accept-green reason, when given.
 */
export function requireNonEmptyCheck(ctx, bar, on, acceptGreen) {
  const check = bar.check ?? '';
  if (!on || acceptGreen || !PASS_EMPTY_FLAG.test(check) || /^\s*test -f /u.test(check)) return;
  const named = barPaths({ check }, { prose: false }).filter(path => TEST_SHAPED.test(path) && !path.endsWith('/'));
  const found = named.length ? onTrunk(ctx.info.root)(named) : new Set();
  const [absent] = named.filter(path => !found.has(path));
  if (!absent) return;
  throw new Refused('CHECK_PASSES_EMPTY', `the check passes with no tests, and ${absent} is absent from main, so it is green before any work exists`,
    `name the fixed check: test -f ${absent} && ${check.trim()}, or file it with --accept-green "<why>"`);
}

/**
 * Refuse a lane item filed with no spec row, so the filer supplies the row and a builder never drafts one (#11778).
 * Why: trial boards had builders run pullboard spec draft themselves, writing rows nobody approved; a draft written by add
 * would still be unapproved and fail UNKNOWN_SPEC until applied, so add refuses and names the two commands that fix it.
 *
 * @param {{ lane: string, title: string, specIds: string[] }} item The item as it is about to be filed.
 * @param {boolean} on The items.barRulesAtAdd machine setting; off files the item as written.
 */
export function requireSpecRow(item, on) {
  if (!on || item.lane === COORDINATOR || item.specIds?.length) return;
  throw new Refused('SPEC_ROW_NEEDED', `a ${item.lane} item needs a spec row, and this add names none`,
    `pullboard spec draft "${item.title}", then the same add with --specs <id>`);
}

/** Refuse an added or edited bar that names a path missing from main [C7]. */
export async function requireBarPathsOnMain(ctx, bar) {
  const refusal = await missingPathRefusal(ctx, bar);
  if (refusal) throw refusal;
}

/**
 * Refuse a claim of an open or claimed item whose bar names a path missing from main, on every claim route (claim,
 * next, run), so a builder is never handed a bar no build can satisfy (#5709).
 *
 * @param {any} ctx
 * @param {any} board
 * @param {number} id
 */
export async function refuseClaimMissingPaths(ctx, board, id) {
  const item = board.nativePorts.getItem(board, id);
  if (['open', 'claimed'].includes(item.item_status)) await requireBarPathsOnMain(ctx, { criterion: item.item_criterion, check: item.item_check });
}

/** Cross-ownership: a bar that names a coordinator-owned path cannot be built by a lane seat, so add and claim refuse it up front [C7,#2650]. */
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
    if (token.endsWith('/') || token.includes('.') || isConfigFile(token)) tokens.add(token);
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
 * @param {{ prose?: boolean, present?: (paths: string[]) => Set<string> }} [options] - `present` names which paths exist on main;
 *   with it, a path missing from main and owned by no lane is a planned file of the item's own lane, not a coordinator path (#6713).
 * @returns {string[]}
 */
export function coordinatorPaths(config, item, options) {
  const unowned = barPaths(item, options).filter(path => laneOf(config, path) === COORDINATOR);
  if (!options?.present || !unowned.length) return unowned;
  const found = options.present(unowned);
  return unowned.filter(path => found.has(path.replace(/\/$/u, '')));
}

/**
 * The repo paths an item's criterion, check and brief Files section name, resolved against a lane-scoped check [C7].
 * Why: claim compares their owning lanes under two policies, so only items whose own files changed lanes go stale.
 *
 * @param {{ criterion?: string, check?: string, brief?: string }} item - The item's bar.
 * @param {{ prose?: boolean, check?: boolean }} [options] - `check: false` leaves the check's paths out but keeps its lane-folder scope.
 * @returns {string[]}
 */
export function barPaths(item, { prose = true, check = true } = {}) {
  const named = [...(prose ? pathTokens(item.criterion) : []), ...(check ? pathTokens(item.check) : []), ...briefFiles(item.brief ?? '').flatMap(file => pathTokens(` ${file}`))];
  // A starter check scoped to its lane folder (`cd './app' && (...)`) runs there, so the paths its bar names are that folder's.
  const scope = /^cd '\.\/([^']+)' && \(/u.exec(item.check ?? '')?.[1];
  const scoped = scope ? named.map(path => (isConfigFile(path) || path.startsWith(`${scope}/`) ? path : `${scope}/${path}`)) : named;
  return [...new Set(scoped)];
}

/** The next step of a cross-ownership refusal: the lane piece, then the coordinator piece filed --after it. */
export function splitAdvice(lane, title, paths) {
  return `split it: file the lane piece with only ${lane} paths (pullboard add ${lane} "${title}"), then file the coordinator piece `
    + `(pullboard add coordinator "${title}: coordinator piece" --after <lane item id>) naming ${paths.join(', ')}`;
}

/**
 * The options that make add and edit judge ownership the way claim does, or undefined with items.barRulesAtAdd off [C7,#11777].
 * Why: with the setting on, the Files list alone says what an item changes, so a bar that cites a file the builder only reads is
 * filed, and the coordinator filing a lane item meets the same rule as a lane seat.
 *
 * @param {any} ctx
 * @param {boolean} on The items.barRulesAtAdd machine setting.
 */
export function barOwnerOptions(ctx, on) {
  return on ? { filesOnly: true, prose: false, check: false, present: onTrunk(ctx.info.root) } : undefined;
}

/**
 * Refuse a lane item whose bar names a coordinator-owned path; the coordinator and the person may name any path.
 * With filesOnly set (items.barRulesAtAdd) the coordinator exemption covers only coordinator-lane items and person filings.
 */
export function requireNoCoordinatorPath(config, me, item, options) {
  if ((me.id === COORDINATOR && !options?.filesOnly) || item.lane === COORDINATOR || item.by === 'person') return;
  const paths = coordinatorPaths(config, item, options);
  if (!paths.length) return;
  throw new Refused('CROSS_OWNERSHIP', `the bar names ${paths.join(', ')}, which no lane owns, so lane ${item.lane} cannot build it`,
    splitAdvice(item.lane, item.title, paths));
}

/**
 * Refuse a claim of a lane item whose brief Files list names a path no lane owns, on every claim route (claim, next, run),
 * judged by the lanes in main's committed config [C7,#11857].
 * Why: the check read the criterion and check too, so a bar naming a file the builder only reads (a vendored cell, a contract)
 * refused every claim; and explicit claim read the seat folder's own config while next skipped the check, so seats disagreed.
 * The Files list is what the item changes; a cited spec row's text in the criterion never adds a path.
 *
 * @param {any} ctx
 * @param {any} board
 * @param {number} id
 * @param {string} agentId The claiming seat.
 * @param {object} accepted Main's committed config, as mainPolicy reads it.
 */
export function refuseClaimCrossOwnership(ctx, board, id, agentId, accepted) {
  const item = board.nativePorts.getItem(board, id);
  if (!item || outsideBuildProblem(board, item)) return;
  requireNoCoordinatorPath(accepted, { id: agentId }, { lane: item.item_lane, title: item.item_title, check: item.item_check, brief: item.item_brief },
    { prose: false, check: false, present: onTrunk(ctx.info.root) });
}
