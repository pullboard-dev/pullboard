/** Deterministically seed a disposable Pullboard board through its public board operations. */
import { createHash } from 'node:crypto';
import { deflateSync } from 'node:zlib';
import { existsSync } from 'node:fs';
import assert from 'node:assert/strict';
import { mkdirSync } from 'node:fs';
import { mkdtempSync } from 'node:fs';
import { realpathSync } from 'node:fs';
import { rmSync } from 'node:fs';
import { writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename } from 'node:path';
import { dirname } from 'node:path';
import { join } from 'node:path';
import { resolve } from 'node:path';
import { spawnSync } from 'node:child_process';
import { performance } from 'node:perf_hooks';
import { loadDoctrine } from '../../../../../../packages/doctrine/index.js';
import { STATUSES } from '../../../../../../packages/spec/index.js';
import { frozenCriterion } from '../../../../../../packages/spec/index.js';
import { loadSpec } from '../../../../../../packages/spec/index.js';
import { ACCEPT_REASON } from '../../../../../../packages/store/index.js';
import { addItem } from '../../../../../../packages/store/index.js';
import { allShouts } from '../../../../../../packages/store/index.js';
import { appendFact } from '../../../../../../packages/store/index.js';
import { atomic } from '../../../../../../packages/store/index.js';
import { claim } from '../../../../../../packages/store/index.js';
import { closeBoard } from '../../../../../../packages/store/index.js';
import { board_ensureCoordinator as ensureCoordinator } from '../../../../../../packages/store/index.js';
import { events } from '../../../../../../packages/store/index.js';
import { getItem } from '../../../../../../packages/store/index.js';
import { listAgents } from '../../../../../../packages/store/index.js';
import { listItems } from '../../../../../../packages/store/index.js';
import { milestones } from '../../../../../../packages/store/index.js';
import { recordAttempt } from '../../../../../../packages/store/index.js';
import { register } from '../../../../../../packages/store/index.js';
import { reopen } from '../../../../../../packages/store/index.js';
import { shout } from '../../../../../../packages/store/index.js';
import { verify } from '../../../../../../packages/store/index.js';
import { withdraw } from '../../../../../../packages/store/index.js';
import { addMilestone } from '../../../../../../packages/store/index.js';
import { openBoard } from '../../../../../lib/index.js';
import { submitFixture } from '../../board/submit.js';
import { appliedSequence } from '../../../../../../packages/state/index.js';
import { applyEngineMove } from '../../../../../../packages/state/index.js';
import { PROOF_RUN_ENGINE } from '../../../../../../packages/state/light.js';

const ROOT = resolve(import.meta.dirname, '../../../../../..');
const BIN = join(ROOT, 'apps', 'cli', 'pullboard.js');
const LANES = ['core', 'view', 'coordinator', 'docs'];
const FIXED_NOW = new Date('2026-10-01T12:00:00.000Z');
const LEASE_MS = 100 * 365 * 24 * 60 * 60 * 1000;
const STATUS_WEIGHTS = [502, 58, 30, 14, 1];
const STATUS_NAMES = ['verified', 'open', 'withdrawn', 'submitted', 'claimed'];
const LANE_WEIGHTS = [317, 199, 46, 43];

/** Hash one stable tuple for generated commits, trees, criterion digests and fact ids. */
function digest(seed, ...parts) {
  return createHash('sha256').update(JSON.stringify([seed, ...parts])).digest('hex');
}

/** Retain the long historical stress corpus through real pre-limit replay, without relaxing current writes. */
function historicalShout(board, { seed, index, from, text }) {
  const move = { version: 1, engine: PROOF_RUN_ENGINE - 1, id: digest(seed, 'pre-limit-shout', index),
    operation: 'shout', args: [{ from, to: 'all', text, lanes: LANES }] };
  const result = applyEngineMove(board, move, { sequence: appliedSequence(board) + 1, at: FIXED_NOW.toISOString() });
  assert.equal(result.error, undefined, 'the synthetic pre-limit record replays through the public engine');
}

/** Build a deterministic text body near the requested size without storing fixture randomness. */
function textOf(seed, label, targetLength) {
  const piece = `${label} ${seed} records a reviewed change with its context, expected result, and follow-up. `;
  return (piece.repeat(Math.ceil(targetLength / piece.length))).slice(0, targetLength);
}

/** Allocate all five lifecycle states proportionally while keeping each state represented. */
export function statusCounts(size) {
  const totalWeight = STATUS_WEIGHTS.reduce((sum, weight) => sum + weight, 0);
  const exact = STATUS_WEIGHTS.map((weight) => size * weight / totalWeight);
  const counts = exact.map(Math.floor);
  for (let index = 0; index < counts.length; index += 1) counts[index] = Math.max(1, counts[index]);
  while (counts.reduce((sum, count) => sum + count, 0) > size) {
    const candidate = counts.map((count, index) => ({ count, index, fraction: exact[index] - Math.floor(exact[index]) }))
      .filter((entry) => entry.count > 1).sort((left, right) => left.fraction - right.fraction || right.count - left.count)[0];
    counts[candidate.index] -= 1;
  }
  while (counts.reduce((sum, count) => sum + count, 0) < size) {
    const candidate = exact.map((value, index) => ({ index, fraction: value - Math.floor(value) }))
      .sort((left, right) => right.fraction - left.fraction || left.index - right.index)[0];
    counts[candidate.index] += 1;
    exact[candidate.index] = Math.floor(exact[candidate.index]);
  }
  return Object.fromEntries(STATUS_NAMES.map((name, index) => [name, counts[index]]));
}

/** Run a fixture process with explicit arguments and a private, deterministic environment. */
function run(command, args, cwd, env) {
  const result = spawnSync(command, args, { cwd, env, encoding: 'utf8', stdio: 'pipe' });
  if (result.status !== 0 || result.signal || result.error) {
    throw new Error(`${command} ${args.join(' ')} failed with status ${result.status ?? 'null'}: ${result.stderr ?? result.error?.message ?? ''}`);
  }
  return result.stdout;
}

/**
 * Start from a caller environment without inherited board, machine or gate identity switches.
 * NODE_TEST_CONTEXT goes too: inside a test run, init refuses to register a board whose home is outside the temp folder,
 * so a stress board cached under the runner's home came out with an empty registry and the view said "No boards yet" [N26].
 */
function cleanEnvironment() {
  return Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.startsWith('PULLBOARD_') && key !== 'NODE_TEST_CONTEXT'));
}

/** Build a spec whose row count scales with board size and whose first draft appears in the default view. */
function specText(seed, size) {
  const count = Math.max(5, Math.round(size * 250 / 605));
  const rows = Array.from({ length: count }, (_, index) =>
    `- P${index + 1} [${index === 0 ? 'draft' : 'approved'}, must] ${textOf(seed, `Spec row ${index + 1}`, 68)} | gate: none`);
  return `# Generated stress board\n\n## P · Performance fixtures\n${rows.join('\n')}\n`;
}

/** Write a private board config with the lanes exercised by the generated items. */
function writeConfig(root) {
  const lanes = Object.fromEntries([...LANES.filter((lane) => lane !== 'coordinator'), 'review'].map((lane) => [lane, {
    owns: lane === 'review' ? [] : [`${lane}/`], specs: lane === 'review' ? [] : ['P'],
  }]));
  const config = { name: 'Generated stress board', project: 'Pullboard performance fixture', spec: 'SPEC.md',
    gate: 'node --check apps/cli/pullboard.js', verify: { policy: 'any', family: 'off' }, lease: '2h', lanes, shared: [] };
  writeFileSync(join(root, 'pullboard.json'), `${JSON.stringify(config, null, 2)}\n`);
}

/** Choose integer counts that follow the measured board proportions for arbitrary sizes. */
function lifecyclePlan(size) {
  const counts = statusCounts(size);
  return STATUS_NAMES.flatMap((status) => Array.from({ length: counts[status] }, () => status));
}

/** Distribute item lanes in the observed 317/199/46/43 share without clustering one lane. */
function lanePlan(size) {
  const total = LANE_WEIGHTS.reduce((sum, weight) => sum + weight, 0);
  const exact = LANE_WEIGHTS.map((weight) => size * weight / total);
  const counts = exact.map((value) => Math.max(1, Math.floor(value)));
  while (counts.reduce((sum, count) => sum + count, 0) > size) {
    const candidate = counts.map((count, index) => ({ count, index, fraction: exact[index] - Math.floor(exact[index]) }))
      .filter((entry) => entry.count > 1).sort((left, right) => left.fraction - right.fraction || right.count - left.count)[0];
    counts[candidate.index] -= 1;
  }
  const remainder = size - counts.reduce((sum, count) => sum + count, 0);
  const priority = exact.map((value, index) => ({ index, fraction: value - counts[index] }))
    .sort((left, right) => right.fraction - left.fraction || left.index - right.index);
  for (let index = 0; index < remainder; index += 1) counts[priority[index].index] += 1;
  const current = counts.map(() => 0);
  const sequence = [];
  for (let index = 0; index < size; index += 1) {
    for (let lane = 0; lane < counts.length; lane += 1) current[lane] += counts[lane];
    let selected = 0;
    for (let lane = 1; lane < counts.length; lane += 1) if (current[lane] > current[selected]) selected = lane;
    sequence.push(LANES[selected]);
    current[selected] -= size;
  }
  return { sequence, counts: Object.fromEntries(LANES.map((lane, index) => [lane, counts[index]])) };
}

/** Register a stable pool of builders, a reviewer, and the live idle writer through board APIs. */
function registerAgents(board, root, size, count) {
  const target = count ?? Math.min(354, Math.max(12, Math.round(size * 354 / 605)));
  const byLane = Object.fromEntries(LANES.map((lane) => [lane, lane === 'coordinator' ? ['coordinator'] : []]));
  const builderCount = Math.max(0, target - 3);
  const builderLanes = ['core', 'view', 'docs'];
  for (let index = 0; index < builderCount; index += 1) {
    const lane = builderLanes[index % builderLanes.length];
    const agent = register(board, { lane, path: join(root, '.stress', lane, String(index + 1)), route: 'strong', family: 'builder', model: 'fixture' });
    byLane[lane].push(agent);
  }
  const writer = register(board, { lane: 'view', path: join(root, '.stress', 'writer'), route: 'strong', family: 'writer', model: 'fixture' });
  byLane.view.push(writer);
  const reviewer = register(board, { lane: 'review', path: join(root, '.stress', 'reviewer'), route: 'strong', family: 'reviewer', model: 'fixture' });
  return { byLane, reviewer, writer };
}

/** Freeze a generated item with the same serialized policy shape used by real claims. */
function freezeItem(item, spec, doctrine) {
  return frozenCriterion(spec, item, doctrine);
}

/**
 * Write one fixed-date child commit of the fixture head straight into the object store.
 * Byte-identical to `git commit-tree`, which cost a process per generated item and made up most of the seed time.
 */
function writeChildCommit(repo, message) {
  const stamp = `${Math.floor(FIXED_NOW.getTime() / 1000)} +0000`, who = 'Stress fixture <stress@pullboard.invalid>';
  const body = Buffer.from(`tree ${repo.tree}\nparent ${repo.head}\nauthor ${who} ${stamp}\ncommitter ${who} ${stamp}\n\n${message}\n`);
  const object = Buffer.concat([Buffer.from(`commit ${body.length}\0`), body]);
  const id = createHash('sha1').update(object).digest('hex');
  const file = join(repo.root, '.git', 'objects', id.slice(0, 2), id.slice(2));
  if (!existsSync(file)) { mkdirSync(dirname(file), { recursive: true }); writeFileSync(file, deflateSync(object), { flag: 'wx', mode: 0o444 }); }
  return id;
}

/**
 * Move one synthetic item through a committed submission using Pullboard board operations.
 * Since 8078e19a4a submit diffs the claim head against the submitted commit, so both are real objects in the
 * fixture repository: main's commit, and a seeded child commit with fixed dates that stays the same per seed.
 */
function submitItem(board, id, seed, lane, builder, commitNumber, freezer, repo) {
  const commit = writeChildCommit(repo, `chore: generated ${digest(seed, 'commit', id, commitNumber).slice(0, 40)}`);
  const tree = repo.tree;
  const frozen = claim(board, id, { agentId: builder, lane,
    leaseMs: LEASE_MS, freeze: freezer, head: repo.head });
  submitFixture(board, id, { agentId: builder, commit, tree, files: [`generated/${id}.txt`] });
  return { commit, tree, digest: frozen.digest };
}

/** Give one synthetic item a reject, an explicit reopen, a second rejection, and final acceptance. */
function exerciseReopen(board, id, seed, lane, builder, reviewer, freezer, repo) {
  submitItem(board, id, seed, lane, builder, 1, freezer, repo);
  reopen(board, id, { agentId: 'coordinator', note: 'Exercise the reopened submission path in the generated board.' });
  const second = submitItem(board, id, seed, lane, builder, 2, freezer, repo);
  verify(board, id, { agentId: reviewer, decision: 'REJECT', reason: 'BEHAVIOR_MISMATCH',
    note: 'Exercise a reject before the final generated acceptance.', clause: JSON.parse(getItem(board, id).item_frozen).criterion, head: second.commit, digest: second.digest,
    policy: 'any', familyPolicy: 'off' });
  const final = submitItem(board, id, seed, lane, builder, 3, freezer, repo);
  verify(board, id, { agentId: reviewer, decision: 'ACCEPT', reason: ACCEPT_REASON,
    note: 'The generated state records a final accepted review.', head: final.commit, digest: final.digest,
    policy: 'any', familyPolicy: 'off', check: 'none' });
}

/** Add one fact and enough ordinary attempt records to reach the chosen item history length. */
function fillHistory(board, id, seed, agentId, targetEvents, usedEvents, factCount) {
  for (let index = 0; index < factCount; index += 1) {
    appendFact(board, id, { agentId: 'coordinator', kind: 'note', text: textOf(seed, `Fact ${index + 1} for item ${id}`, 180),
      factId: `${digest(seed, 'fact-id').slice(0, 10)}-${id}-${index + 1}` });
  }
  const attempts = Math.max(0, targetEvents - usedEvents - factCount);
  for (let index = 0; index < attempts; index += 1) {
    recordAttempt(board, id, { agentId, n: index + 1, seconds: 1 + (index % 17), result: `fixture observation ${index + 1}` });
  }
}

/** Return the canonical, path-free projection used to compare two generated boards. */
function boardSnapshot(board, seed, source, baselineEventId) {
  // Project only stable board content: the random board_id and temporary agent paths are omitted.
  // Synthetic fact IDs are supplied from seed/item/index, so the fact events remain reproducible.
  return {
    seed,
    spec: source,
    agents: listAgents(board).map(({ agent_id, agent_lane, agent_route, agent_family, agent_model }) =>
      ({ id: agent_id, lane: agent_lane, route: agent_route, family: agent_family, model: agent_model })),
    items: listItems(board, { all: true }).map((item) => ({
      id: item.item_id, parent: item.item_parent_id, lane: item.item_lane, title: item.item_title,
      criterion: item.item_criterion, specs: item.item_spec_ids, after: item.item_after, brief: item.item_brief,
      route: item.item_route, check: item.item_check, status: item.item_status, owner: item.item_owner,
      leaseUntil: item.item_lease_until, frozen: item.item_frozen, frozenDigest: item.item_frozen_digest,
      builtBy: item.item_built_by, builderFamily: item.item_builder_family, commit: item.item_commit,
      tree: item.item_tree, verdict: item.item_verdict, verifiedBy: item.item_verified_by,
      mergedCommit: item.item_merged_commit, withdrawnReason: item.item_withdrawn_reason,
      holdReason: item.item_hold_reason, holdBy: item.item_hold_by, holdAt: item.item_hold_at,
      createdBy: item.item_created_by, createdAt: item.item_created_at, updatedAt: item.item_updated_at,
    })),
    events: events(board).filter((event) => event.event_id > baselineEventId)
      .map((event) => ({ id: event.event_id, at: event.event_at, by: event.event_by, kind: event.event_kind,
        itemId: event.item_id, detail: event.event_detail })),
    shouts: allShouts(board).map((entry) => ({ id: entry.shout_id, from: entry.shout_from, to: entry.shout_to,
      text: entry.shout_text, at: entry.shout_at })),
    milestones: milestones(board),
  };
}

/** Generate a reproducible fixture in a disposable repository without writing its SQLite file directly. */
export function generateStressBoard({ seed = 'pullboard-perf-606', size = 150, parent = tmpdir(), agents: agentCount, shouts: requestedShouts } = {}) {
  if (typeof seed !== 'string' || !seed.trim()) throw new TypeError('seed must be a nonempty string');
  if (!Number.isSafeInteger(size) || size < 5 || size > 100_000) throw new RangeError('size must be an integer from 5 through 100000');
  if (agentCount !== undefined && (!Number.isSafeInteger(agentCount) || agentCount < 12 || agentCount > 10000)) throw new RangeError('agents must be an integer from 12 through 10000');
  if (requestedShouts !== undefined && (!Number.isSafeInteger(requestedShouts) || requestedShouts < 1 || requestedShouts > 100000)) throw new RangeError('shouts must be an integer from 1 through 100000');
  const workspace = mkdtempSync(join(parent, 'pullboard-stress-'));
  // Per-stage wall time of this build (#11716): each stage() call names the work since the previous mark.
  const stages = [];
  let mark = performance.now();
  let historyMs = 0;
  const stage = (name, ms) => { const now = performance.now(); stages.push({ name, ms: Math.round(ms ?? now - mark) }); mark = now; };
  let board = null;
  let keepWorkspace = false;
  try {
    const root = join(workspace, 'board');
    const home = join(workspace, 'home');
    const machineHome = join(workspace, 'machine-home');
    mkdirSync(root, { recursive: true });
    mkdirSync(home, { recursive: true });
    mkdirSync(machineHome, { recursive: true });
    const canonicalRoot = realpathSync(root);
    // #851: cleanEnvironment drops every PULLBOARD_ variable, including the fixture opt-out, so init would start a background view.
    const env = { ...cleanEnvironment(), HOME: home, PULLBOARD_HOME: home, PULLBOARD_FIXTURE_BOARD: '1', PULLBOARD_MACHINE_HOME: machineHome, PULLBOARD_VIEW_BACKGROUND: '0',
      GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_NOSYSTEM: '1', GIT_AUTHOR_NAME: 'Stress fixture',
      GIT_AUTHOR_EMAIL: 'stress@pullboard.invalid', GIT_COMMITTER_NAME: 'Stress fixture', GIT_COMMITTER_EMAIL: 'stress@pullboard.invalid',
      GIT_AUTHOR_DATE: FIXED_NOW.toISOString(), GIT_COMMITTER_DATE: FIXED_NOW.toISOString() };
    run('git', ['init', '-q', '-b', 'main'], root, env);
    stage('git-init');
    run(process.execPath, [BIN, 'init', '--model', 'Stress fixture'], root, env);
    stage('pullboard-init');
    writeConfig(root);
    const source = specText(seed, size);
    writeFileSync(join(root, 'SPEC.md'), source);
    writeFileSync(join(root, 'DOCTRINE.md'), '# Performance fixture rules\n\n## Rules\n- R1 [approved, must] Keep the generated board readable. | gate: review\n');
    // Submit reads the clause policy from main's commit since 8078e19a4a, so the fixture commits its config, spec and doctrine; init's agent files name the run's own paths, so they stay out of the seeded commit.
    run('git', ['add', 'pullboard.json', 'SPEC.md', 'DOCTRINE.md'], root, env);
    // Plumbing, like the generated item commits: init installs the project's hooks, which need an installed pullboard.
    const tree = run('git', ['write-tree'], root, env).trim();
    const head = run('git', ['commit-tree', tree, '-m', 'chore: create the stress fixture'], root, env).trim();
    run('git', ['update-ref', 'refs/heads/main', head], root, env);
    stage('spec-and-commit');
    const repo = { root, env, head, tree };
    const spec = loadSpec(root, { spec: 'SPEC.md' });
    const doctrine = loadDoctrine(root, { practice: 'DOCTRINE.md' });
    const freezer = (item) => freezeItem(item, spec, doctrine);
    const boardFile = join(root, '.git', 'pullboard', 'board.sqlite');
    board = openBoard(boardFile, { now: () => new Date(FIXED_NOW) });
    ensureCoordinator(board, canonicalRoot);
    stage('open-board');
    const initialEvent = events(board).at(-1)?.event_id ?? 0;
    // This isolated fixture has no readers until return; retain every native move and commit
    // the generated population together, instead of paying an outer transaction per record.
    const manifest = atomic(board, () => {
      const agents = registerAgents(board, root, size, agentCount);
      stage('agents');
      const statuses = lifecyclePlan(size);
      const firstOpenIndex = statuses.indexOf('open');
      const longestHistoryIndex = statuses.indexOf('claimed');
      const { sequence: itemLanes, counts: laneTotals } = lanePlan(size);
      // Keep claims within ONE_CLAIM while preserving the generated lane proportions. The synthetic
      // coordinator owns its lane; move any later coordinator-lane claims onto an unused docs item.
      for (let index = 0; index < statuses.length; index += 1) {
        if (statuses[index] !== 'claimed' || itemLanes[index] !== 'coordinator') continue;
        const replacement = statuses.findIndex((status, candidate) => status !== 'claimed' && itemLanes[candidate] === 'docs');
        if (replacement < 0) throw new Error('the generated lane mix has no docs item to keep coordinator claims unique');
        [itemLanes[index], itemLanes[replacement]] = [itemLanes[replacement], itemLanes[index]];
      }
      const ids = [];
      let smallItemId = null;
      let smallItemTitle = null;
      let longestHistoryItemId = null;
      let longestHistoryTitle = null;
      const claimOrdinalByLane = Object.fromEntries(LANES.map((lane) => [lane, 0]));
      for (let index = 0; index < statuses.length; index += 1) {
        const status = statuses[index];
        const lane = itemLanes[index];
        const title = index === firstOpenIndex ? `Small item ${seed}` : `Board item ${index + 1} in ${lane}`;
        const briefLength = index === firstOpenIndex ? 500 : index === Math.floor(size / 3) ? 3_300 : 1_350;
        const id = addItem(board, { by: 'coordinator', lane, title, specIds: [`P${(index % Math.max(5, Math.round(size * 250 / 605))) + 1}`],
          criterion: `The generated board retains item ${index + 1} in ${status}.`,
          brief: textOf(seed, `Item ${index + 1} brief`, briefLength), route: 'strong' });
        ids.push(id);
        if (status === 'open' && smallItemId === null) { smallItemId = id; smallItemTitle = title; }
        if (index === longestHistoryIndex) {
          longestHistoryItemId = id;
          longestHistoryTitle = title;
        }
        const laneBuilders = agents.byLane[lane];
        const builder = laneBuilders[index % laneBuilders.length];
        let usedEvents = 1;
        if (status === 'withdrawn') {
          withdraw(board, id, { agentId: 'coordinator', reason: 'The generated board includes withdrawn work.' });
          usedEvents += 1;
        } else if (status === 'claimed') {
          const claimOrdinal = claimOrdinalByLane[lane]++;
          if (claimOrdinal >= laneBuilders.length) throw new Error(`the generated ${lane} claim count exceeds its unique fixture agents`);
          const claimBuilder = laneBuilders[claimOrdinal];
          claim(board, id, { agentId: claimBuilder, lane, leaseMs: LEASE_MS, freeze: freezer,
            head: digest(seed, 'claim-head', id, 0).slice(0, 40) });
          usedEvents += 1;
        } else if (status === 'submitted') {
          submitItem(board, id, seed, lane, builder, 1, freezer, repo);
          usedEvents += 2;
        } else if (status === 'verified') {
          if (index === statuses.indexOf('verified')) {
            exerciseReopen(board, id, seed, lane, builder, agents.reviewer, freezer, repo);
            usedEvents += 9;
          } else {
            const submitted = submitItem(board, id, seed, lane, builder, 1, freezer, repo);
            verify(board, id, { agentId: agents.reviewer, decision: 'ACCEPT', reason: ACCEPT_REASON,
              note: 'The generated state records a verified review.', head: submitted.commit, digest: submitted.digest,
              policy: 'any', familyPolicy: 'off', check: 'none' });
            usedEvents += 3;
          }
        }
        const targetHistory = id === longestHistoryItemId ? 168 : index % 100 === 0 ? 37 : index % 10 === 0 ? 18 : 8;
        const historyStart = performance.now();
        fillHistory(board, id, seed, builder, targetHistory, usedEvents, id === longestHistoryItemId ? 8 : index % 12 === 0 ? 2 : 0);
        historyMs += performance.now() - historyStart;
      }
      stage('items', performance.now() - mark - historyMs);
      stage('histories', historyMs);
      const shoutCount = requestedShouts ?? Math.round(7_289 * size / 605);
      for (let index = 0; index < shoutCount; index += 1) {
        const text = index === 0 ? textOf(seed, 'Longest generated shout', 14_000) : textOf(seed, `Generated board update ${index + 1}`, 410);
        historicalShout(board, { seed, index, from: agents.writer, text });
      }
      const historicalCount = allShouts(board).length;
      assert.throws(() => shout(board, { from: agents.writer, to: 'all', text: 'x'.repeat(401), lanes: LANES }),
        error => error.code === 'SHOUT_TOO_LONG', 'new writes still obey the landed 400-character cap');
      assert.equal(allShouts(board).length, historicalCount, 'the current-write refusal creates no extra fixture shout');
      stage('shouts');
      const milestoneCount = Math.max(1, Math.round(size * 56 / 605));
      const rowCount = Math.max(milestoneCount, Math.round(size * 384 / 605));
      for (let index = 0, cursor = 0; index < milestoneCount; index += 1) {
        const itemCount = Math.floor(rowCount / milestoneCount) + (index < rowCount % milestoneCount ? 1 : 0);
        const referenced = Array.from({ length: itemCount }, () => ids[cursor++ % ids.length]);
        addMilestone(board, { agentId: 'coordinator', name: `Milestone ${index + 1}`, note: textOf(seed, `Roadmap note ${index + 1}`, 120), items: referenced, reason: 'Arrange stress fixture release' });
      }
      stage('milestones');
      const snapshot = boardSnapshot(board, seed, source, initialEvent);
      const boardDigest = createHash('sha256').update(JSON.stringify(snapshot)).digest('hex');
      const itemEvents = events(board).filter((event) => event.event_id > initialEvent && event.item_id !== null).length;
      const actualItems = listItems(board, { all: true });
      const statusTotals = Object.fromEntries(STATUS_NAMES.map((name) => [name, actualItems.filter((item) => item.item_status === name).length]));
      const actualLaneTotals = Object.fromEntries(LANES.map((lane) => [lane, actualItems.filter((item) => item.item_lane === lane).length]));
      const specStatusTotals = Object.fromEntries(STATUSES.map((status) => [status, spec.rows.filter((row) => row.status === status).length]));
      if (JSON.stringify(statusTotals) !== JSON.stringify(Object.fromEntries(STATUS_NAMES.map((name) => [name, statuses.filter((status) => status === name).length])))) {
        throw new Error('the generated board lifecycle does not match its planned state counts');
      }
      if (JSON.stringify(actualLaneTotals) !== JSON.stringify(laneTotals)) throw new Error('the generated board lanes do not match their planned counts');
      stage('snapshot');
      return { version: 1, seed, size, digest: boardDigest, root, home, machineHome, boardFile, parent: resolve(parent),
        smallItemId, smallItemTitle, longestHistoryItemId, longestHistoryTitle, liveWriter: agents.writer, itemEvents, shoutCount,
        milestoneCount, milestoneRows: rowCount, specRows: Math.max(5, Math.round(size * 250 / 605)), statusTotals, laneTotals: actualLaneTotals,
        specStatusTotals, agentCount: listAgents(board).length };
    });
    writeFileSync(join(workspace, 'stress-board.json'), `${JSON.stringify(manifest, null, 2)}\n`, { mode: 0o600 });
    stage('write-out');
    keepWorkspace = true;
    return { ...manifest, workspace, env, stages };
  } finally {
    if (board) closeBoard(board);
    if (!keepWorkspace) rmSync(workspace, { recursive: true, force: true });
  }
}

/** Remove only the temporary directory created by generateStressBoard. */
export function removeStressBoard(board) {
  const workspace = typeof board?.workspace === 'string' ? resolve(board.workspace) : '';
  const parent = typeof board?.parent === 'string' ? resolve(board.parent) : resolve(tmpdir());
  if (!workspace || dirname(workspace) !== parent || !basename(workspace).startsWith('pullboard-stress-')) {
    throw new Error('refusing to remove a path that was not created as a stress fixture');
  }
  rmSync(board.workspace, { recursive: true, force: true });
}
