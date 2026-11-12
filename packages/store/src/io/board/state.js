import { currentProofCounters } from "../../../../verify/index.js";
import { proofCounter } from "../../../../verify/index.js";
import { workQueue } from "../../../../items/index.js";
import { pipelineStats } from "../../../../stats/light.js";
/** @pullboard-test-input packages/doctrine/src/io/standard.md */
/** One complete native state builder for local HTTP and sealed relay projections [A2,H5,H16]. */
import { counterProofStats } from "../../../../verify/index.js";
import { createHash } from 'node:crypto';
import { existsSync } from 'node:fs';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { CONFIG_FILE } from "../../../../config/index.js";
import { BLOCKS_FILE } from "../../../../items/index.js";
import * as store from "../board.js";
import { roadmap } from "./milestones.js";
import { displayAgentName } from "../../../../seats/index.js";
import { COORDINATOR } from "../../../../config/index.js";
import { loadConfig } from "../../../../config/index.js";
import { repoInfo } from "../../../../git/index.js";
import { listApiProjects } from "../../../../seats/index.js";
import { nativeStateClockWindow } from "../../logic/clock.js";
import { workProgress } from '../../../../roadmap/index.js';
import { milestoneRoadmap } from "../../../../roadmap/index.js";
import { proofStats } from "../../../../stats/light.js";
import { readCapacity } from "../../../../stats/light.js";
import { budgetState } from "../../../../stats/light.js";
import { loadMachineSettings } from "../../../../config/index.js";
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

/** Build the complete local API state, including fields that the shared project snapshot omits. */
export function buildLocalBoardState(root, boardId, board, codeIsMain, { previous = null, previousHistory = null, fullItemRebuild = true, refreshVerdicts = false, afterSequence = 0, changedLeases = new Set(), onItemBuild, projects = listApiProjects, scopeCommonDir = null, observedAt = Date.now(), freshnessReader = null, localRelayHealth = null, localCapacity = false } = {}, ports) {
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
    const freshness = freshnessReader ?? verdictProjector(root, board, { main: trunkRevisionReader(repoInfo(root))() }, { events: store.events, acceptedVerdict: store.acceptedVerdict, verdictReviewProblem: store.verdictReviewProblem }).state;
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
    const progressById = workProgress(board);
    const healthById = claimHealthSnapshot(board, config, new Date(observedAt));
    state.items = state.items.map(item => ({ ...item, progress: progressById.get(item.id),
      claimHealth: healthById.get(item.id) ?? null }));
    const allAgents = state.agents;
    state.agents = activeViewAgents(state.agents, observedAt).map((agent) => ({ ...agent, model: agent.agent_model ?? 'unknown', displayName: displayAgentName(agent, config.agents.names) }));
    state.board = boardId;
    state.observedAt = new Date(observedAt).toISOString();
    state.decisionQueue = store.openDecisions(board, COORDINATOR);
    // The browser's state carries each lane hold and each item's own hold with its reason; the native projection says the same so their hashes match (#1256).
    state.holds = store.laneHolds(board);
    state.itemHolds = currentItems.filter((item) => item.item_hold_reason).map((item) => ({ item: item.item_id, reason: item.item_hold_reason, by: item.item_hold_by, at: item.item_hold_at }));
    const projectData = {
      requests: store.openRequests(board),
      personRequests: personRequestStatuses(board),
      milestones: scopeCommonDir === null
        ? milestoneRoadmap(root, board, { ports: { ...store, roadmap, openBoard, workQueue, listApiProjects } })
        : milestoneRoadmap(root, board, { projects, hideOutOfScope: true, ports: { ...store, roadmap, openBoard, workQueue } }),
      rowDecisions: store.rowDecisions(board),
      proofStats: viewProofSummary(proofStats(board, { now: observedAt }, { events: store.events, counterProofStats })),
    };
    state.proofStats = projectData.proofStats;
    state.requests = projectData.requests;
    state.personRequests = projectData.personRequests;
    Object.assign(state, personSigningPresentation(root, board, config));
    state.milestones = projectData.milestones;
    state.blocks = personBlockWords(repoInfo(root).commonDir, board.clock.now(), localCapacity ? machineBudgetState(board, observedAt) : undefined); // Needs you below is recomputed with them [C6].
    // Only the local HTTP host supplies its private telemetry; sealed projections omit it entirely.
    if (localRelayHealth !== null) state.relayHealthAlerts = localRelayHealth;
    // The forecast reads this machine's derived proof-counter index, which sealed exports omit, so only the local host adds it.
    if (localCapacity) state.capacityForecast = readCapacity(board, observedAt, { currentProofCounters, proofCounter });
    const decorated = projectSpecApprovals(projectFit(pendingFit(repoInfo(root).commonDir), projectRowDecisions(projectData.rowDecisions, state)), specApprovalState(root, { board, config }, { store, verifiedPasskeyRowDecision }));
    decorated.ruleCounts = ruleProofCounts(root, board, decorated.spec);
    const bases = new Map(decorated.items.map((item) => [item.id, item]));
    for (const id of dirtyIds) {
      if (!currentById.has(id)) continue;
      const item = store.getItem(board, id);
      const base = bases.get(id);
      const full = {
        ...base,
        check: item.item_check,
        ...(item.item_check_baseline ? { checkBaseline: item.item_check_baseline } : {}),
        thread: store.itemThread(board, id),
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
    const history = recordedHistory(board, previousHistory);
    // Both native and sealed relay readers use this exact recorded-history projection.
    listFields.state.statsPipeline = pipelineStats(history);
    const clockWindow = nativeStateClockWindow({ ...listFields.state, agents: allAgents }, history, currentItems, observedAt);
    board.db.exec('COMMIT');
    return { state: listFields.state, itemMeta, itemMoveCounts: listFields.itemMoveCounts, sequence, history, clockWindow };
  } catch (error) {
    try { board.db.exec('ROLLBACK'); } catch { /* Preserve the projection failure. */ }
    throw error;
  }
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
  if (!existsSync(file.path)) return [file.name, null];
  return [file.name, createHash('sha256').update(readFileSync(file.path)).digest('hex')];
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
