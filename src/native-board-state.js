/** @pullboard-test-input src/standard-doctrine.md */
/** One complete native state builder for local HTTP and sealed relay projections [A2,H5,H16]. */
import { verifiedPasskeyRowDecision } from './person-row-proof.js';
import { counterProofStats } from './proof-counter-read.js';
import { createHash } from 'node:crypto';
import { existsSync } from 'node:fs';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { CONFIG_FILE } from './config.js';
import { fitFile } from './blueprint-fit.js';
import { BLOCKS_FILE } from './blocks.js';
import * as store from './board.js';
import { displayAgentName } from './agent-names.js';
import { COORDINATOR } from './config.js';
import { loadConfig } from './config.js';
import { repoInfo } from './git.js';
import { listApiProjects } from './projects.js';
import { nativeStateClockWindow } from './native-state-clock.js';
import { milestoneRoadmap } from './roadmap.js';
import { proofStats } from './stats.js';
import { activeViewAgents } from './view-state-summary.js';
import { viewProofSummary } from './view-state-summary.js';
import { ruleProofCounts } from './rule-proof-counts.js';
import { milestoneNamesByItem } from './item-list.js';
import { withListFields } from './item-list.js';
import { projectRowDecisions } from './row-decisions.js';
import { projectSpecApprovals } from './spec-approval.js';
import { specApprovalState } from './spec-approval.js';
import { pendingFit } from './blueprint-fit.js';
import { projectFit } from './blueprint-fit.js';
import { personBlockWords } from './blocks.js';
import { verdictProjector } from './verdict-freshness.js';
import { trunkRevisionReader } from './trunk-revision.js';
import { projectState } from './serve.js';
import { personRequestStatuses } from './relay-requests.js';
import { personSigningPresentation } from './person-signing-presentation.js';
import {
  dependencyValues,
  hasForeignDependencies,
} from './item-dependencies.js';

/** Build the complete local API state, including fields that the shared project snapshot omits. */
export function buildLocalBoardState(root, boardId, board, codeIsMain, { previous = null, fullItemRebuild = true, afterSequence = 0, changedLeases = new Set(), onItemBuild, projects = listApiProjects, scopeCommonDir = null, observedAt = Date.now(), freshnessReader = null, localRelayHealth = null } = {}) {
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
      return previous.items.get(item.item_id);
    } });
    const allAgents = state.agents;
    state.agents = activeViewAgents(state.agents, observedAt).map((agent) => ({ ...agent, model: agent.agent_model ?? 'unknown', displayName: displayAgentName(agent, config.agents.names) }));
    state.board = boardId;
    state.observedAt = new Date(observedAt).toISOString();
    state.decisionQueue = store.openDecisions(board, COORDINATOR);
    const projectData = {
      requests: store.openRequests(board),
      personRequests: personRequestStatuses(board),
      milestones: scopeCommonDir === null
        ? milestoneRoadmap(root, board)
        : milestoneRoadmap(root, board, { projects, hideOutOfScope: true }),
      rowDecisions: store.rowDecisions(board),
      proofStats: viewProofSummary(proofStats(board, { now: observedAt }, { events: store.events, counterProofStats })),
    };
    state.proofStats = projectData.proofStats;
    state.requests = projectData.requests;
    state.personRequests = projectData.personRequests;
    Object.assign(state, personSigningPresentation(root, board, config));
    state.milestones = projectData.milestones;
    state.blocks = personBlockWords(repoInfo(root).commonDir, board.clock.now()); // Needs you below is recomputed with them [C6].
    // Only the local HTTP host supplies its private telemetry; sealed projections omit it entirely.
    if (localRelayHealth !== null) state.relayHealthAlerts = localRelayHealth;
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
    const history = store.events(board);
    const clockWindow = nativeStateClockWindow({ ...listFields.state, agents: allAgents }, history, currentItems, observedAt);
    board.db.exec('COMMIT');
    return { state: listFields.state, itemMeta, itemMoveCounts: listFields.itemMoveCounts, sequence, history, clockWindow };
  } catch (error) {
    try { board.db.exec('ROLLBACK'); } catch { /* Preserve the projection failure. */ }
    throw error;
  }
}

/** Parse an item's ordered prerequisite IDs from its persisted row. */
export function dependencyIds(item) {
  return dependencyValues(item);
}


/** Name project and built-in files separately, even when their basenames collide. */
export function stateFileInputs(root, config) {
  return [
    { name: `config:${CONFIG_FILE}`, path: join(root, CONFIG_FILE) },
    { name: `spec:${config.spec}`, path: join(root, config.spec) },
    { name: `practice:${config.practice}`, path: join(root, config.practice) },
    { name: 'builtin:standard-doctrine.md', path: new URL('./standard-doctrine.md', import.meta.url) },
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
