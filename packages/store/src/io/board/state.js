import { currentProofCounters } from "../../../../verify/index.js";
import { ensureProofCounters } from "../../../../verify/index.js";
import { proofCounter } from "../../../../verify/index.js";
import { workQueue } from "../../../../items/index.js";
import { pipelineStats } from "../../../../stats/light.js";
/** @pullboard-test-input packages/doctrine/src/io/standard.md */
/** One complete native state builder for local HTTP and sealed relay projections [A2,H5,H16]. */
import { counterProofStats } from "../../../../verify/index.js";
import { createHash } from 'node:crypto';
import { fileSystemAdapter } from '../../../../fs/index.js';
import { join } from 'node:path';
import { CONFIG_FILE } from "../../../../config/index.js";
import { BLOCKS_FILE } from "../../../../items/index.js";
import * as store from "../board.js";
import { itemCheckBaseline } from "../../logic/board/item/baseline.js";
import { roadmap } from "./milestones.js";
import { displayAgentName } from "../../../../seats/index.js";
import { COORDINATOR } from "../../../../config/index.js";
import { loadConfig } from "../../../../config/index.js";
import { repoInfo } from "../../../../git/index.js";
import { listApiProjects } from "../../../../seats/index.js";
import { nativeStateClockWindow } from "../../logic/clock.js";
import { stageLimits } from "../../logic/clock.js";
import { landedOnMain } from '../../../../roadmap/index.js';
import { workProgress } from '../../../../roadmap/index.js';
import { milestoneRoadmap } from "../../../../roadmap/index.js";
import { proofStats } from "../../../../stats/light.js";
import { readCapacity } from "../../../../stats/light.js";
import { budgetState } from "../../../../stats/light.js";
import { loadMachineSettings } from "../../../../config/index.js";
import { hotStateEnabled } from "../../../../config/index.js";
import { hunkFreshnessEnabled } from "../../../../config/index.js";
import { splitRecent } from "../../../../items/index.js";
import { ruleProofCounts } from "../../../../verify/index.js";
import { milestoneNamesByItem } from "../../../../items/index.js";
import { withListFields } from "../../../../items/index.js";
import { projectRowDecisions } from "../../../../spec/index.js";
import { projectSpecApprovals } from "../../../../spec/index.js";
import { specApprovalState } from "../../../../spec/index.js";
import { personBlockWords } from "../../../../items/index.js";
import { verdictProjector } from "../../../../verify/index.js";
import { trunkRevisionReader } from "../../../../git/index.js";
import {
  dependencyValues,
  hasForeignDependencies,
} from "../../../../items/index.js";

const fs = fileSystemAdapter();

/**
 * Proof stats for one state build, taken from the stored counters [C7].
 *
 * Why: a board with no current counters made the first build read and fold the whole events table (about 2 s on the live board).
 * A writable board catches its counters up once here, inside a savepoint, so a refused write leaves the board untouched and the
 * legacy read of every event is only the last resort.
 */
export function stateProofStats(board, now, reads = { events: store.events, counterProofStats }) {
  if (!currentProofCounters(board)) {
    board.db.exec('SAVEPOINT state_proof_counters');
    try { ensureProofCounters(board, { refresh: false }); board.db.exec('RELEASE state_proof_counters'); }
    catch { board.db.exec('ROLLBACK TO state_proof_counters'); board.db.exec('RELEASE state_proof_counters'); }
  }
  return proofStats(board, { now }, reads);
}

/** How many dirty items make a build wide enough to read the event list once rather than once per item. */
const WIDE_BUILD_ITEMS = 64;

/** Build the complete local API state, including fields that the shared project snapshot omits. */
export function buildLocalBoardState(root, boardId, board, codeIsMain, { previous = null, previousHistory = null, fullItemRebuild = true, refreshVerdicts = false, afterSequence = 0, changedLeases = new Set(), onItemBuild, projects = listApiProjects, scopeCommonDir = null, observedAt = Date.now(), freshnessReader = null, localRelayHealth = null, localCapacity = false, hotState = hotStateEnabled() } = {}, ports) {
  if (!ports || typeof ports.openBoard !== 'function' || typeof ports.verifiedPasskeyRowDecision !== 'function' || typeof ports.pendingFit !== 'function' || typeof ports.projectFit !== 'function' || typeof ports.projectState !== 'function' || typeof ports.personRequestStatuses !== 'function' || typeof ports.personSigningPresentation !== 'function' || typeof ports.activeViewAgents !== 'function' || typeof ports.viewProofSummary !== 'function' || typeof ports.claimHealthSnapshot !== 'function') throw new TypeError('native state needs the explicit upper presentation ports');
  const { openBoard, verifiedPasskeyRowDecision, pendingFit, projectFit, projectState, personRequestStatuses, personSigningPresentation, activeViewAgents, viewProofSummary, claimHealthSnapshot } = ports;
  if (!Number.isSafeInteger(observedAt) || observedAt < 0) throw new TypeError('native projection needs an observation timestamp');
  board = Object.assign(Object.create(board), { clock: { ...board.clock, now: () => new Date(observedAt) } });
  board.db.exec('BEGIN');
  try {
    const sequence = board.db.prepare('SELECT COALESCE(MAX(event_id), 0) AS id FROM event').get().id;
    let rebuildAll = fullItemRebuild || (previous && previous.sequence > sequence);
    const eventRows = rebuildAll || !previous ? [] : board.db.prepare('SELECT event_id, item_id, event_kind FROM event WHERE event_id > ? ORDER BY event_id').all(afterSequence);
    if (!rebuildAll && previous && eventRows.length !== sequence - previous.sequence) rebuildAll = true;
    const dirtyIds = new Set(rebuildAll ? [] : [...changedLeases]);
    for (const event of eventRows) if (event.item_id !== null) dirtyIds.add(event.item_id);

    const foreignChanged = eventRows.some(event => event.event_kind === 'board_link_state' || event.event_kind === 'board_link');
    const currentItems = store.listItems(board, { all: true });
    const currentById = new Map(currentItems.map((item) => [item.item_id, item]));
    const currentDependencies = new Map(currentItems.map((item) => [item.item_id, dependencyIds(item)]));
    const milestoneNames = milestoneNamesByItem(store.milestones(board));
    for (const prior of previous?.itemMeta.values() ?? []) {
      if (!currentById.has(prior.id)) dirtyIds.add(prior.id);
    }
    for (const item of currentItems) {
      const prior = previous?.itemMeta.get(item.item_id);
      // E32 announcements and consent changes carry no local item_id, but change foreign blockers.
      if (foreignChanged && hasForeignDependencies(item)) dirtyIds.add(item.item_id);
      if (rebuildAll || !previous?.items.has(item.item_id) || !prior || prior.raw !== JSON.stringify(item)) dirtyIds.add(item.item_id);
      if (prior && prior.milestone !== (milestoneNames.get(item.item_id) ?? null)) dirtyIds.add(item.item_id);
    }
    // A dirty item's status affects the blockedBy list of every direct old or new dependent.
    const changedIds = [...dirtyIds];
    for (const dependent of previous?.itemMeta.values() ?? []) {
      if (changedIds.some((id) => dependent.dependencies.includes(id))) dirtyIds.add(dependent.id);
    }
    for (const [id, dependencies] of currentDependencies) {
      if (changedIds.some((changed) => dependencies.includes(changed))) dirtyIds.add(id);
    }

    const config = loadConfig(root);
    const projector = freshnessReader ? null : verdictProjector(root, board, { main: trunkRevisionReader(repoInfo(root))() ?? undefined }, { events: store.events, acceptedVerdict: store.acceptedVerdict, verdictReviewProblem: store.verdictReviewProblem, hunkKeyed: hunkFreshnessEnabled() });
    const freshness = freshnessReader ?? projector.state;
    // One cat-file answers every verified item's commit, rather than one Git process per item [C7].
    projector?.prime(currentItems.filter(item => dirtyIds.has(item.item_id) || refreshVerdicts));
    // A wide build reads every dirty item's verdict rows, receipts and reopens once, not one query set per item [C7].
    if (dirtyIds.size > WIDE_BUILD_ITEMS) board.verdictReads = store.verdictReads(board, dirtyIds);
    const state = projectState(root, { seen: null, board, itemProjector: (item, context) => {
      if (dirtyIds.has(item.item_id)) {
        const projected = context.project();
        const verdictState = freshness(item);
        return verdictState ? { ...projected, verdictState } : projected;
      }
      // A trunk move changes only whether each verdict is still fresh, so a kept item takes its verdict state again [C7].
      if (!refreshVerdicts) return previous.items.get(item.item_id);
      const { verdictState: _stale, ...kept } = previous.items.get(item.item_id);
      const verdictState = freshness(item);
      return verdictState ? { ...kept, verdictState } : kept;
    } });
    const progressById = workProgress(board, { onMain: landedOnMain(root, config) });
    const healthById = claimHealthSnapshot(board, config, new Date(observedAt));
    state.items = state.items.map(item => ({ ...item, progress: withoutClockReading(progressById.get(item.id)),
      claimHealth: claimHealthWithoutClock(healthById.get(item.id)) }));
    const allAgents = state.agents;
    state.agents = activeViewAgents(state.agents, observedAt).map((agent) => ({ ...agent, model: agent.agent_model ?? 'unknown', displayName: displayAgentName(agent, config.agents.names) }));
    state.board = boardId;
    // Minutes each stage may last, from the settings that govern it; a stage with no setting is absent [#6940].
    state.stageLimits = stageLimits(config);
    state.observedAt = new Date(observedAt).toISOString();
    state.decisionQueue = store.openDecisions(board, COORDINATOR);
    // The browser's state carries each lane hold and each item's own hold with its reason; the native projection says the same so their hashes match (#1256).
    state.holds = store.laneHolds(board);
    state.itemHolds = currentItems.filter((item) => item.item_hold_reason).map((item) => ({ item: item.item_id, reason: item.item_hold_reason, by: item.item_hold_by, at: item.item_hold_at }));
    const projectData = {
      requests: store.openRequests(board),
      personRequests: personRequestStatuses(board),
      milestones: scopeCommonDir === null
        ? milestoneRoadmap(root, board, { landedFromMain: config.landing?.landedFromMain === true, ports: { ...store, roadmap, openBoard, workQueue, listApiProjects } })
        : milestoneRoadmap(root, board, { projects, hideOutOfScope: true, landedFromMain: config.landing?.landedFromMain === true, ports: { ...store, roadmap, openBoard, workQueue } }),
      rowDecisions: store.rowDecisions(board),
      proofStats: viewProofSummary(stateProofStats(board, observedAt)),
    };
    state.proofStats = projectData.proofStats;
    state.requests = projectData.requests;
    state.personRequests = projectData.personRequests;
    Object.assign(state, personSigningPresentation(root, board, config));
    state.milestones = milestoneItemIds(projectData.milestones.map(milestoneWithoutClock));
    state.blocks = personBlockWords(repoInfo(root).commonDir, board.clock.now(), localCapacity ? machineBudgetState(board, observedAt) : undefined); // Needs you below is recomputed with them [C6].
    // Only the local HTTP host supplies its private telemetry; sealed projections omit it entirely.
    if (localRelayHealth !== null) state.relayHealthAlerts = localRelayHealth;
    // The forecast reads this machine's derived proof-counter index, which sealed exports omit, so only the local host adds it.
    if (localCapacity) state.capacityForecast = readCapacity(board, observedAt, { currentProofCounters, proofCounter });
    const decorated = projectSpecApprovals(projectFit(pendingFit(repoInfo(root).commonDir), projectRowDecisions(projectData.rowDecisions, state)), specApprovalState(root, { board, config }, { store, verifiedPasskeyRowDecision }));
    decorated.ruleCounts = ruleProofCounts(root, board, decorated.spec);
    const bases = new Map(decorated.items.map((item) => [item.id, item]));
    // The whole event list is read here, once, and the dirty items' threads cut from it: a state build kept one query per item, and
    // every item's build re-read the log and every board-wide main move (#8480). A few dirty items still read their own.
    const history = recordedHistory(board, previousHistory);
    const wide = dirtyIds.size > WIDE_BUILD_ITEMS;
    const threads = wide ? store.itemThreads(board, [...dirtyIds].filter(id => currentById.has(id)), history) : null;
    const moved = wide ? new Set(board.db.prepare("SELECT meta_key FROM board_meta WHERE meta_key LIKE 'item_redirect:%'").all().map(row => row.meta_key)) : null;
    for (const id of dirtyIds) {
      if (!currentById.has(id)) continue;
      // A wide build takes the check and its baseline from the listed row: the rest of what getItem reads (stage, head, source) is not state.
      const item = wide && !moved.has(`item_redirect:${id}`) ? currentById.get(id) : store.getItem(board, id);
      const baseline = wide && item === currentById.get(id) ? itemCheckBaseline(board, item) : item.item_check_baseline;
      const base = bases.get(id);
      const full = {
        ...base,
        check: item.item_check,
        ...(baseline ? { checkBaseline: baseline } : {}),
        thread: threads?.get(id) ?? store.itemThread(board, id),
      };
      bases.set(id, full);
      onItemBuild?.({ board: boardId, itemId: id });
    }
    decorated.items = decorated.items.map((item) => bases.get(item.id) ?? item);
    const leases = new Map(currentItems.map((item) => [item.item_id, item.item_lease_until ?? null]));
    const listFields = withListFields(decorated, leases, { previous, dirtyIds });
    const itemMeta = new Map(currentItems.map((item) => [item.item_id, {
      id: item.item_id,
      raw: JSON.stringify(item),
      dependencies: currentDependencies.get(item.item_id) ?? [],
      milestone: milestoneNames.get(item.item_id) ?? null,
    }]));
    // Both native and sealed relay readers use this exact recorded-history projection.
    listFields.state.statsPipeline = pipelineStats(history);
    const clockWindow = nativeStateClockWindow({ ...listFields.state, agents: allAgents }, history, currentItems, observedAt);
    board.db.exec('COMMIT');
    return { state: hotStateItems(listFields.state, { enabled: hotState, now: observedAt }), itemMeta, itemMoveCounts: listFields.itemMoveCounts, sequence, history, clockWindow };
  } catch (error) {
    try { board.db.exec('ROLLBACK'); } catch { /* Preserve the projection failure. */ }
    throw error;
  }
}

/** A finished item updated within this many milliseconds stays whole in a hot state build (7 days). */
export const HOT_RECENT_MS = 7 * 24 * 3600_000;

/**
 * The state with board.hotState applied: open and recently finished items stay whole, and older finished ones become
 * `finishedCounts`, by status. With the setting off the state comes back as it is, with no new field [C7,#9338].
 * Why: the state build and every delta carried every finished item, which grows without bound on a long-lived board.
 *
 * @param {{ items: object[] }} state a built state
 * @param {{ enabled: boolean, now: number, recentMs?: number }} options now is the build's observation time in ms
 * @returns {object} the same state when off, else a copy with the kept items and `finishedCounts`
 */
export function hotStateItems(state, { enabled, now, recentMs = HOT_RECENT_MS }) {
  if (enabled !== true) return state;
  const { kept, counts } = splitRecent(state.items, now, recentMs);
  return { ...state, items: kept, finishedCounts: counts };
}

/**
 * The board's whole event history, in order: the kept history of the last build extended by the events after it.
 * Why keep it: the log only grows, and every derived projection memoizes per event row, so rows read again each build
 * were decoded again each build. A kept prefix that no longer matches the board (fewer or other rows) is read anew.
 */
function recordedHistory(board, kept) {
  if (!Array.isArray(kept) || !kept.length) return store.events(board);
  const last = kept.at(-1).event_id;
  const prefix = board.db.prepare('SELECT COUNT(*) AS n, COALESCE(MAX(event_id), 0) AS id FROM event WHERE event_id <= ?').get(last);
  if (prefix.n !== kept.length || prefix.id !== last) return store.events(board);
  return kept.concat(board.db.prepare('SELECT * FROM event WHERE event_id > ? ORDER BY event_id').all(last));
}

/** Parse an item's ordered prerequisite IDs from its persisted row. */
export function dependencyIds(item) {
  return dependencyValues(item);
}


/** Name project and built-in files separately, even when their basenames collide. */
export function stateFileInputs(root, config, { fitFile }) {
  return [
    { name: `config:${CONFIG_FILE}`, path: join(root, CONFIG_FILE) },
    { name: `spec:${config.spec}`, path: join(root, config.spec) },
    { name: `practice:${config.practice}`, path: join(root, config.practice) },
    { name: 'builtin:standard-doctrine.md', path: new URL("../../../../doctrine/src/io/standard.md", import.meta.url) },
    ...['signoffs.jsonl', 'signers', 'first-commit', 'signers.initial'].map(name => ({ name: `approval:${name}`, path: join(root, '.pullboard', name) })),
    { name: 'fit:blueprint-fit.json', path: fitFile(repoInfo(root).commonDir) },
    // A new block changes Needs you without a board move, so the ledger is a state input [C6].
    { name: 'blocks:blocks.jsonl', path: join(repoInfo(root).commonDir, BLOCKS_FILE) },
  ];
}

/** Hash the exact bytes of one named input, preserving a missing-file marker. */
export function fileRevision(file) {
  if (!fs.exists(file.path)) return [file.name, null];
  return [file.name, createHash('sha256').update(fs.readFile(file.path, null)).digest('hex')];
}

/**
 * Spend against this machine's budget setting for Needs you [N2]; undefined with no budget set, so nothing is read.
 *
 * @param {object} board an open board
 * @param {number} now epoch milliseconds
 */
function machineBudgetState(board, now) {
  const settings = loadMachineSettings();
  return settings.budget ? budgetState(board, settings.costPrices, settings.budget, now) : undefined;
}

/** An item's progress as the page holds it: lastActivity says when, and the page derives the idle minutes, so no build carries a clock reading [C7]. */
function withoutClockReading(progress) {
  if (!progress) return progress;
  const { idleMinutes: _minutes, ...kept } = progress;
  return kept;
}

/** A claim's health as a build holds it: its state and waits, never the minutes it has been idle. */
function claimHealthWithoutClock(health) {
  if (!health) return null;
  const { idleMinutes: _minutes, ...kept } = health;
  return kept;
}

/** A milestone as a build holds it: its own progress names the latest activity, and its entries carry no per-item progress, which each item already holds, so a delta resends a milestone at a fraction of its size. */
function milestoneWithoutClock(milestone) {
  const items = milestone.items.map(({ progress: _held, ...entry }) => entry);
  const { idleMinutes: _minutes, ...progress } = milestone.progress;
  const latest = milestone.items.map(entry => entry.progress?.lastActivity).filter(Boolean).sort().at(-1) ?? null;
  return { ...milestone, items, progress: { ...progress, idleSince: latest } };
}

/**
 * Each milestone with its local items as ids: the page already holds every local item, so a row keeps only its id,
 * its roadmap state and its queue position, and the title, status and progress come from the state's items (#6666).
 * Items on other boards keep their whole row, since this state does not hold them.
 *
 * @param {any[]} milestones
 * @returns {any[]}
 */
export function milestoneItemIds(milestones) {
  return milestones.map(milestone => ({ ...milestone, items: milestone.items.map(entry => typeof entry.id !== "number" ? entry
    : { id: entry.id, state: entry.state, ...(entry.position === undefined ? {} : { position: entry.position }) }) }));
}
