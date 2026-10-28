import { runDeferredGuards } from './landing-deferred-run.js';
import { refreshLandedCodeMap } from './landing-main-notices.js';
import { cadenceDeferral } from './landing-cadence.js';
import {
  requireLocalGuardClassification,
  runLocalLandingGuard,
} from './land-local-guard.js';
import { mergeOnlyLandingProblem } from './merge-only-verdict.js';
import { localDependencyIds } from './item-dependencies.js';
import { requireOutsideOwner } from './outside-source.js';
import {
  landingChangedFiles,
  deferredLandingPriorities,
} from './land-collisions.js';
/** Coordinator landing batches retain exact Git and gate receipts across interruptions [B3,R3]. */
import { assignEngineNumbers } from './engine-numbers.js';
import {
  resolveMechanicalIndex,
  mechanicalConflictFiles,
} from './mechanical-merge.js';
import { writeFormatTable } from './format-registry.js';
import {
  createHash,
  randomUUID,
} from 'node:crypto';
import {
  closeSync,
  copyFileSync,
  existsSync,
  mkdirSync,
  openSync,
  readFileSync,
  readSync,
  realpathSync,
} from 'node:fs';
import {
  dirname,
  isAbsolute,
  join,
  relative,
} from 'node:path';
import * as store from './board.js';
import {
  badgeCounts,
  writeBadges,
} from './badge.js';
import {
  git,
  headCommit,
  headTree,
  isClean,
  invalidateGitFacts,
  mainCheckout,
  repoInfo,
  tryGit,
  untracked,
} from './git.js';
import {
  runGate,
  runProfiledShell,
  runStaticChecks,
  withGateSlot,
  isStampedGreen,
  withLandingGateSlot,
} from './gate.js';
import {
  readGateReceipt,
  receiptStore,
} from './gate-run-receipt.js';
import { testsNeedBrowser } from './browser-admission.js';
import { testsNeedGui } from './gui-admission.js';
import { selectAffectedTests } from './affected-tests.js';
import { selectRegistryGuards } from './registry-guards.js';
import { placementLandingPlan } from './test-placement.js';
import { laneOf } from './lanes.js';
import { takeLandingResource } from './landing-resource.js';
import {
  landingLeaseState,
  requireConfirmedLanding,
} from './landing-lease.js';
import { runLandingWorker } from './landing-worker.js';
import { runLandingCandidateWorker } from './landing-candidates.js';
import { inheritedGateSlot } from './resources.js';
import { Refused } from './refused.js';
import {
  checkLandingMessages,
  landingContext,
} from './landing-message.js';
import { requireLandingHost } from './landing-host.js';
import {
  environmentLabel,
  sameEnvironment,
} from './execution-environment.js';
import { browserFreeChecksEnabled } from './settings.js';
import { tightenLandingDoctrine } from './landing-doctrine.js';
import { policyAt } from './trusted-policy.js';
import {
  landingFileTimes,
  validateLandingBatch,
  validateLandingRevision,
} from './submit-invariants.js';
import {
  flakeSource,
  observeNativeFailure,
} from './native-flakes.js';
import {
  staleVerdictRefusal,
  verdictProjector,
} from './verdict-freshness.js';

/** Quote a command argument without allowing shell interpolation. */
function quote(value) { return `'${String(value).replaceAll("'", "'\\''")}'`; }

/** Hash a test's current bytes, so a real correction can unblock its held batch. */
function testHash(root, file) {
  try { return createHash('sha256').update(readFileSync(join(root, file))).digest('hex'); }
  catch { return null; }
}

/** Read a committed test identity; an uncommitted edit cannot release a trunk hold. */
function testBlob(root, commit, file) {
  const result = tryGit(root, ['rev-parse', '--verify', `${commit}:${file}`]);
  return result.status === 0 ? result.stdout : null;
}

/** A test defect holds every batch on its trunk until the committed test changes or every failure is waived. */
function heldTestDefects(root, board, trunk) {
  return store.landingTestDefects(board).filter(defect => {
    if (defect.branch !== trunk.branch) return false;
    const blob = testBlob(root, trunk.commit, defect.test);
    return !(blob && blob !== defect.blob && blob !== defect.trunkBlob) && !defect.names.every(name => store.landingWaiverFor(board, { file: defect.test, name }));
  });
}

/** Keep each verdict's recorded executor distinct from the actual landing host. */
function environmentWarnings(board, items, environment) {
  return items.flatMap(entry => {
    const verdict = store.acceptedVerdict(board, store.getItem(board, entry.id));
    const recorded = verdict?.environment ?? null;
    return sameEnvironment(recorded, environment) ? [] : [{ item: entry.id, recorded, landing: environment }];
  });
}

/** Derive failing test identities from TAP or spec reporter names and source locations, refusing unknown paths. */
export function landingFailures(output, root, { excludeCancelled = false } = {}) {
  const failures = [];
  let active = null;
  /** A reported path relative to the root, or null when it lies outside it. */
  const inRoot = (path) => {
    const file = isAbsolute(path) ? relative(root, path) : path.replace(/^\.\//u, '');
    return file && !file.startsWith('../') && !file.includes('\\') ? file : null;
  };
  // The spec reporter (Node 24's default for node --test) names each failure as "test at <file>:<line>" then "✖ <name>".
  let specFile;
  for (const line of output.split('\n')) {
    const at = /^\s*test at (.+?):\d+(?::\d+)?\s*$/u.exec(line);
    if (at) { specFile = inRoot(at[1]); active = null; continue; }
    const spec = specFile !== undefined ? /^\s*\u2716 (.+?)(?: \([\d.]+m?s\))?\s*$/u.exec(line) : null;
    if (spec) { failures.push({ name: spec[1], file: specFile }); specFile = undefined; continue; }
    const failed = /^\s*not ok\s+\d+\s+-\s+(.*)$/u.exec(line);
    if (failed) {
      active = { name: failed[1].replace(/\s+#.*$/u, ''), file: null };
      failures.push(active);
      if (/^(?:\.\/)?(?:test|tests)\/[^\r\n]+\.(?:[cm]?js|ts|py)$/u.test(active.name)) active.file = active.name.replace(/^\.\//u, '');
    }
    const location = /^\s*location:\s*['"]?(.+?):\d+(?::\d+)?['"]?\s*$/u.exec(line);
    if (active && location) {
      const file = inRoot(location[1]);
      if (file) active.file = file;
    }
    if (excludeCancelled && active && /^\s*failureType:\s*['"]?(?:cancelledByParent|subtestsFailed)['"]?\s*$/u.test(line)) active.omit = true;
  }
  const unique = new Map(failures.filter(entry => !entry.omit).map(({ file, name }) => [`${file}\0${name}`, { name, file }]));
  return [...unique.values()];
}

export {
  checkLandingMessages,
  itemCommitType,
  landingContext,
  landingMessage,
  landingRows,
  landingSubject,
} from './landing-message.js';

/** Keep the submitted identity and, when different, its sealed checked composition. */
function landingEntry(item) {
  return { id: item.item_id, commit: item.item_commit,
    ...(item.item_landing_commit !== item.item_commit ? { reviewedCommit: item.item_landing_commit } : {}) };
}

/** Select in verdict order; a read-only preflight may stop at its first eligible item [B3,R3]. */
function candidates(board, root, base, maximum, { firstReady = false } = {}) {
  const all = store.listItems(board, { all: true });
  const projector = verdictProjector(root, board, { main: base });
  const pending = all.filter((item) => item.item_status === 'verified' && !item.item_merged_commit);
  const order = new Map();
  for (const event of store.events(board)) if (event.event_kind === 'accept') order.set(event.item_id, event.event_id);
  const collisionFree = store.lineSettings(board).collisionFreeBatch === true;
  const batches = store.landingBatches(board);
  const priorities = collisionFree ? deferredLandingPriorities(batches, pending) : new Map();
  pending.sort((left, right) => {
    const leftPriority = priorities.get(left.item_id);
    const rightPriority = priorities.get(right.item_id);
    if (leftPriority !== undefined || rightPriority !== undefined) {
      if (leftPriority === undefined) return 1;
      if (rightPriority === undefined) return -1;
      if (leftPriority !== rightPriority) return leftPriority - rightPriority;
    }
    return (order.get(left.item_id) ?? Infinity) - (order.get(right.item_id) ?? Infinity) || left.item_id - right.item_id;
  });
  const ready = [];
  const blocked = [];
  const touched = new Map();
  const knownReds = batches.flatMap((batch) => batch.culprits ?? []);
  for (const original of pending) {
    const item = { ...original, item_landing_commit: store.checkedLandingCommit(board, original) };
    const stale = projector.state(item);
    if (stale) { blocked.push({ id: item.item_id, ...stale }); continue; }
    const known = knownReds.find((entry) => entry.id === item.item_id && entry.commit === item.item_commit
      && (entry.reviewedCommit ?? entry.commit) === item.item_landing_commit);
    if (known && !known.tests.every((failure) => store.landingWaiverFor(board, failure))) {
      blocked.push({ id: item.item_id, code: 'LAND_KNOWN_RED', tests: known.tests });
      continue;
    }
    const dependencies = localDependencyIds(item);
    if (dependencies.some((id) => !all.find((other) => other.item_id === id)?.item_merged_commit && !ready.some((other) => other.item_id === id))) continue;
    const stacked = store.unverifiedSubmissions(board).find((other) => other.item_id !== item.item_id
      && tryGit(root, ['merge-base', '--is-ancestor', other.item_commit, item.item_landing_commit]).status === 0
      && tryGit(root, ['merge-base', '--is-ancestor', other.item_commit, base]).status !== 0);
    if (stacked) {
      blocked.push({ id: item.item_id, code: 'STACKED_UNVERIFIED', stacked: stacked.item_id });
      continue;
    }
    if (ready.length < maximum) {
      const files = collisionFree ? landingChangedFiles(root, base, item.item_landing_commit) : [];
      const shared = files.filter(file => touched.has(file));
      if (shared.length) {
        blocked.push({ id: item.item_id, code: 'LAND_FILE_OVERLAP', files: shared,
          commit: item.item_commit, frozenDigest: item.item_frozen_digest,
          with: [...new Set(shared.map(file => touched.get(file)))] });
        continue; // Verdict order is unchanged; this item leads the next eligible batch.
      }
      for (const file of files) touched.set(file, item.item_id);
      ready.push(item);
      if (firstReady) break;
    }
  }
  return { ready, blocked };
}

/** Append a durable snapshot before or after each external side effect. */
async function save(state, patch) {
  const conflicts = [...new Map([...(state.batch.conflicts ?? []), ...(patch.conflicts ?? [])].map((entry) => [entry.id, entry])).values()];
  const resolutions = [...new Map([...(state.batch.resolutions ?? []), ...(patch.resolutions ?? [])]
    .map(entry => [JSON.stringify(entry), entry])).values()];
  state.batch = await state.write('recordLandingBatch', [{ agentId: 'coordinator', batch: { ...state.batch, ...patch, conflicts, resolutions }, revision: state.batch.revision ?? 0 }]);
  return state.batch;
}

/** Merge one ordered group from the immutable batch base, preserving each first-containing commit. */
async function mergeGroup(state, items) {
  await state.checkLease();
  const { batch } = state;
  if (!isClean(batch.root) || untracked(batch.root).length) throw new Refused('LAND_DIRTY', 'the landing worktree has unfinished edits; inspect its recorded path before adopting');
  git(batch.root, ['checkout', '--detach', batch.base]);
  // Every message is built and checked before the first merge, so a bad one cannot land half a batch.
  const messages = checkLandingMessages(items.map((entry) => store.getItem(state.board, entry.id ?? entry.item_id)),
    landingContext(batch.root, batch.base, state.config, (item) => store.checkedLandingCommit(state.board, item)));
  const merged = [];
  const conflicts = [];
  const resolutions = [];
  for (const entry of items) {
    await state.checkLease();
    const item = store.getItem(state.board, entry.id ?? entry.item_id);
    if (item.item_status !== 'verified' || item.item_commit !== (entry.commit ?? item.item_commit)) throw new Refused('LAND_ITEM_MOVED', `item #${item.item_id} changed; rebuild the batch from current verified work`);
    const checked = store.checkedLandingCommit(state.board, item);
    if (checked !== (entry.reviewedCommit ?? entry.commit ?? item.item_commit)) throw new Refused('LAND_ITEM_MOVED', `item #${item.item_id} was re-reviewed; rebuild its landing from the checked commit`);
    const stale = verdictProjector(state.root, state.board, { main: batch.base }).state(item);
    if (stale) throw staleVerdictRefusal(item, stale);
    // The body is the trailer paragraph alone: the header carries the title, and no lane branch is named [B3,R3].
    // merge.log is switched off on this call, so a local Git config cannot append a shortlog to the body.
    const trunk = headCommit(batch.root);
    const message = messages.get(item.item_id);
    const result = tryGit(batch.root, ['-c', 'merge.log=false', 'merge', '--no-ff', '--no-log', checked, '-m', message.header, '-m', message.trailers]);
    if (result.status !== 0) {
      const files = tryGit(batch.root, ['diff', '--name-only', '--diff-filter=U']).stdout.split('\n').filter(Boolean);
      if (!files.length) throw new Refused('LAND_MERGE', `merge of #${item.item_id} failed outside a conflict: ${result.stderr || result.stdout}; inspect ${batch.root} and its hooks before adopting`);
      const resolution = resolveMechanicalIndex(batch.root, files);
      if (resolution.failed) {
        git(batch.root, ['merge', '--abort']);
        throw new Refused('LAND_MERGE', `item #${item.item_id}: generator ${resolution.failed.generator} failed for ${resolution.failed.path} (exit ${resolution.failed.status ?? 'unavailable'}); repair the generator before adopting this landing`);
      }
      if (!resolution.files.length) {
        git(batch.root, ['add', '--', ...files]);
        // The message is written again, so Git's conflict notes can never follow the trailers.
        git(batch.root, ['commit', '-m', message.header, '-m', message.trailers]);
        resolutions.push({ id: item.item_id, files, entries: resolution.entries });
        state.say(`mechanical merge #${item.item_id}: ${files.join(', ')}`);
      } else {
        git(batch.root, ['merge', '--abort']);
        conflicts.push({ id: item.item_id, files: resolution.files, trunk, commit: item.item_commit, reviewedCommit: checked });
        state.say(`conflict #${item.item_id}: ${resolution.files.join(', ')}`);
        continue;
      }
    }
    // An engine the item added without a number gets the next one now, in landing order, inside its own merge (#1101).
    const engines = assignEngineNumbers(batch.root);
    if (existsSync(join(batch.root, 'src', 'formats')) && existsSync(join(batch.root, 'docs', 'formats.md'))
      && writeFormatTable(batch.root) && !engines.files.includes('docs/formats.md')) engines.files.push('docs/formats.md');
    if (engines.files.length) {
      git(batch.root, ['add', '--', ...engines.files]);
      git(batch.root, ['commit', '--amend', '--no-edit']);
      for (const engine of engines.assigned) state.say(`engine ${engine.name}: ${engine.number} for #${item.item_id}`);
    }
    const first = git(batch.root, ['rev-list', '--first-parent', '--reverse', 'HEAD']).split('\n')
      .find((commit) => tryGit(batch.root, ['merge-base', '--is-ancestor', checked, commit]).status === 0);
    merged.push({ id: item.item_id, commit: item.item_commit, ...(checked !== item.item_commit ? { reviewedCommit: checked } : {}), merge: first });
  }
  if (merged.length) {
    const changed = writeBadges(batch.root, badgeCounts(state.board));
    if (changed.length) {
      git(batch.root, ['add', '--', ...changed]);
      const tip = headCommit(batch.root);
      const parents = git(batch.root, ['rev-list', '--parents', '-n', '1', tip]).split(' ');
      if (tip !== batch.base && parents.length === 3 && merged.some(entry => entry.merge === tip)) {
        // Badges belong to the final item merge, preserving its parents/trailer and first-containing receipt.
        git(batch.root, ['commit', '--amend', '--no-edit']);
        const refreshed = headCommit(batch.root);
        for (const entry of merged) if (entry.merge === tip) entry.merge = refreshed;
      } else {
        // An already-contained item may create no merge: never amend the existing trunk's history.
        git(batch.root, ['commit', '-m', 'chore: refresh board badge counts']);
      }
    }
  }
  let doctrineCounts = [];
  try {
    if (merged.length) doctrineCounts = await tightenLandingDoctrine(batch.root, state.config, { onWait: state.onWait });
  } catch (error) {
    await save(state, { state: 'blocked', items: merged, conflicts, tip: headCommit(batch.root), doctrineCounts: [] });
    throw error;
  }
  for (const change of doctrineCounts) state.say(`doctrine ${change.id}: ${change.before} -> ${change.count}`);
  return { items: merged, conflicts, resolutions, tip: headCommit(batch.root), doctrineCounts };
}

/** Read positive TAP completion counts while rejecting the canonical runner's incomplete accounts. */
function completionAccount() {
  let early = false;
  let plan = null;
  let topLevel = 0;
  let counts = {};
  let prior = true;
  /** Require every completed TAP stream, not just the last appended phase, to account for its tests. */
  const finished = () => !early && Number.isSafeInteger(plan) && plan > 0 && plan === topLevel && Number.isSafeInteger(counts.tests)
    && Number.isSafeInteger(counts.pass) && Number.isSafeInteger(counts.fail) && (counts.cancelled ?? 0) === 0
    && counts.pass + counts.fail + (counts.skipped ?? 0) + (counts.todo ?? 0) === counts.tests;
  /** Recognize canonical incomplete accounts even when only a bounded line prefix is retained. */
  const markerPrefix = (text) => {
    if (/^(?:Landing gate stopped early after |Files not run: |Interrupted test files: )/u.test(text)) early = true;
  };
  return {
    markerPrefix,
    /** Consume one complete output line without retaining test output or diagnostic blocks. */
    line(text) {
      markerPrefix(text);
      if (/^TAP version \d+\s*$/u.test(text) && (plan !== null || topLevel || Object.keys(counts).length)) {
        prior = prior && finished(); plan = null; topLevel = 0; counts = {};
      }
      if (/^(?:not )?ok \d+\b/u.test(text)) topLevel++;
      const planned = /^1\.\.(\d+)\s*$/u.exec(text);
      if (planned) plan = Number(planned[1]);
      const count = /^# (tests|pass|fail|cancelled|skipped|todo) (\d+)\s*$/u.exec(text);
      if (count) counts[count[1]] = Number(count[2]);
    },
    /** A complete plan accounts for every test and contains no interrupted or cancelled work. */
    complete() {
      return prior && finished();
    },
  };
}

/** Require positive completion evidence from this run, or stream the retained legacy raw account. */
function completeGate(gate) {
  if (typeof gate.complete === 'boolean') return gate.complete;
  const account = completionAccount();
  if (typeof gate.output === 'string') {
    for (const line of gate.output.split('\n')) account.line(line);
    return account.complete();
  }
  if (!gate.logPath || !existsSync(gate.logPath)) return false;
  const input = openSync(gate.logPath, 'r');
  const chunk = Buffer.alloc(64 * 1024);
  let pending = '';
  let oversized = false;
  try {
    let count;
    while ((count = readSync(input, chunk, 0, chunk.length, null)) > 0) {
      const parts = chunk.toString('latin1', 0, count).split('\n');
      for (const [index, part] of parts.entries()) {
        if (index) {
          if (oversized) account.markerPrefix(pending);
          else account.line(pending);
          pending = ''; oversized = false;
        }
        if (pending.length + part.length > 256) oversized = true;
        pending += part.slice(0, 256 - pending.length);
      }
    }
    if (oversized) account.markerPrefix(pending);
    else account.line(pending);
    return account.complete();
  } finally { closeSync(input); }
}

/** Whether current person waivers cover every named failure of this exact recorded run. */
function coveredFailures(state, gate) {
  return gate.failures.length > 0 && gate.failures.every((failure) => failure.file && store.landingWaiverFor(state.board, failure));
}

/** Record the receipt the landing gate wrote for its run, in the lane that owns its first failing test [C7,D1]. */
async function recordLandingRun(state, receiptId) {
  const receipt = readGateReceipt(receiptStore(state.batch.root), receiptId);
  if (!receipt) return;
  const owner = receipt.failures.map(failure => laneOf(state.config, failure.file)).find(lane => lane !== 'coordinator');
  await state.write('recordGateRun', [{ agentId: 'coordinator', receipt, lane: owner ?? store.getItem(state.board, state.batch.items[0].id).item_lane }]);
}

/** Select one deduplicated merged-tree test plan for both inline and local-first landing paths. */
function batchAffectedTests(state) {
  const root = state.batch.root;
  const commit = headCommit(root);
  const selection = state.config.affectedTests
    ? selectAffectedTests(root, { base: state.batch.base, commit })
    : { full: true, reason: 'affected-test selection is not enabled for this project', files: [] };
  const registry = selectRegistryGuards(root, state.config.registryGuards, { base: state.batch.base });
  const mandatory = [...new Set([...(state.config.submitInvariants ?? []), ...registry])].sort();
  return { ...selection, mandatory, files: [...new Set([...mandatory, ...(!selection.full ? selection.files : [])])].sort() };
}

/** Bind each cached result to its exact full-gate or local-trunk guard plan. */
function batchGatePlan(state, { localTrunk = false } = {}) {
  const selection = batchAffectedTests(state);
  const changed = git(state.batch.root, ['diff', '--no-renames', '--name-only', '-z', state.batch.base, 'HEAD']).split('\0').filter(Boolean);
  const deferred = localTrunk ? deferredSelections(state).flatMap(row => row.files) : [];
  const valued = placementLandingPlan(state.batch.root, state.config, selection, [...selection.mandatory, ...deferred], changed);
  if (valued) return valued;
  if (localTrunk) {
    const files = [...new Set([...selection.files, ...deferred])].sort();
    const affected = files.length ? `${state.config.affectedTests} ${files.map(quote).join(' ')}` : '';
    const command = selection.full ? affected ? `(\n${state.config.gate}\n) && ${affected}` : state.config.gate : affected || 'true';
    const config = { ...state.config, gate: command };
    return { config, files, subset: !selection.full, affectedGate: createHash('sha256').update(command).digest('hex') };
  }
  const appended = selection.files.length ? `${state.config.affectedTests} ${selection.files.map(quote).join(' ')}` : '';
  const config = appended ? { ...state.config, gate: `(\n${state.config.gate}\n) && ${appended}` } : state.config;
  return { config, affectedGate: createHash('sha256').update(config.gate).digest('hex') };
}

/** Run one source-pinned gate or selective floor, retaining its complete immutable phase log. */
async function gateGroup(state, label, options) {
  const tree = headTree(state.batch.root);
  const commit = headCommit(state.batch.root);
  const { config, affectedGate, files, subset } = batchGatePlan(state, options);
  const recorded = state.gates.get(tree);
  if (recorded?.timedOut) throw new Refused('LAND_GATE_TIMEOUT', 'this exact tree has a recorded landing timeout; inspect its log before starting a new batch');
  const cached = recorded?.affectedGate === affectedGate ? recorded : null;
  if (cached && (completeGate(cached) || !coveredFailures(state, cached))) return cached;
  const directory = join(dirname(state.batch.root), 'logs');
  mkdirSync(directory, { recursive: true });
  const logPath = join(directory, `${label}-${state.batch.revision}.log`);
  await save(state, { state: 'gating', tip: headCommit(state.batch.root), logPath });
  const pin = flakeSource(state.batch.root, { commit, main: state.batch.base });
  const onFailure = Object.assign((run, { root, command, lease }) => observeNativeFailure({ root, config, pin, run, command, lease, kind: 'land',
    record: observation => {
      const owner = observation.file ? laneOf(state.config, observation.file) : 'coordinator';
      const lane = owner === 'coordinator' ? store.getItem(state.board, state.batch.items[0].id).item_lane : owner;
      return state.write('recordFlakeObservation', [{ agentId: 'coordinator', observation, lane }]);
    } }), { main: pin.main, recordRun: receiptId => recordLandingRun(state, receiptId) });
  const gate = subset
    ? await runLocalLandingGuard(state.batch.root, config, { files, directory, label, onWait: state.onWait,
      waivers: liveWaiverProjection(state.board), onFailure })
    : await runGate(state.batch.root, config, { trustStamp: false, landing: true, agent: 'coordinator', onWait: state.onWait,
      stages: true, waivers: liveWaiverProjection(state.board), onFailure });
  copyFileSync(gate.log, logPath);
  if (gate.profilePath) copyFileSync(gate.profilePath, `${logPath}.profile.json`);
  if (headCommit(state.batch.root) !== commit || headTree(state.batch.root) !== tree || !isClean(state.batch.root)) {
    throw new Refused('LAND_SOURCE_CHANGED', `the landing source changed while the gate ran; inspect ${logPath} and restore the recorded batch before adopting`);
  }
  const result = { ...gate, failures: landingFailures(gate.output, state.batch.root), accounted: accountedFailures(gate, state.batch.root), complete: completeGate(gate),
    requiresGreen: Boolean(cached && !completeGate(cached)), tree, logPath, affectedGate };
  state.gates.set(tree, result);
  const evidence = state.batch.invariantEvidence ?? { version: 1, gates: [], diagnostics: [] };
  const tested = { commit, isGreen: gate.isGreen && completeGate(gate),
    submissions: state.batch.items.map(({ id, commit }) => ({ id, commit })),
    failures: [...new Set(landingFailures(gate.output, state.batch.root, { excludeCancelled: true }).map(failure => failure.file).filter(Boolean))],
    fileTimes: landingFileTimes(state.batch.root, gate.profile) };
  const warnings = gate.environment ? environmentWarnings(state.board, state.batch.items, gate.environment) : [];
  for (const warning of warnings) state.say(`#${warning.item} was checked on ${environmentLabel(warning.recorded)}; this landing ran on ${environmentLabel(warning.landing)}`);
  await save(state, { environmentWarnings: warnings, gateResults: [...state.gates.values()].map(({ tree: testedTree, isGreen, failures, accounted, complete, requiresGreen, logPath: log, flakeDiagnostics, environment: executor, timedOut, affectedGate: plan }) =>
    ({ tree: testedTree, isGreen, ...(timedOut ? { timedOut: true } : {}), failures, accounted: accounted ?? null, complete: complete ?? null, requiresGreen: Boolean(requiresGreen), logPath: log, ...(plan ? { affectedGate: plan } : {}),
      environment: executor ?? null, ...(flakeDiagnostics ? { flakeDiagnostics } : {}) })),
    invariantEvidence: { ...evidence, gates: [...evidence.gates, tested] } });
  if (gate.timedOut) {
    await save(state, { state: 'blocked', timedOut: true });
    throw new Refused('LAND_GATE_TIMEOUT', 'the landing gate timed out; its process tree is stopped and no candidate is a culprit');
  }
  return result;
}

/** Merge and test one speculative prefix without giving its worker publication authority. */
export async function runLandingCandidate({ root, board, config, batch, entries, write, say, onWait, checkLease, checkLeaseNow, claimGate, finishGate }) {
  await checkLease();
  if (!existsSync(batch.root)) {
    mkdirSync(dirname(batch.root), { recursive: true });
    checkLeaseNow();
    git(root, ['worktree', 'add', '--detach', batch.root, batch.base]);
  }
  board.quarantineEnabled = () => config.flakes?.quarantine === true;
  const state = { root, board, config, batch, write, say, onWait, checkLease, checkLeaseNow,
    culprits: [], flaky: false, gates: new Map(), diagnosed: new Map() };
  const build = await mergeGroup(state, entries);
  await save(state, { ...build });
  // A conflicting prefix is not its requested composition. Never test the smaller accidental tree.
  if (build.conflicts.length || !build.items.length) return { batch: state.batch, gate: null };
  const tree = headTree(batch.root);
  const claimed = await claimGate(tree, batchGatePlan(state).affectedGate);
  if (claimed.previous) state.gates.set(tree, claimed.previous);
  const gate = claimed.cached ?? { ...await gateGroup(state, 'candidate'), proofRoot: state.batch.root, proofCommit: headCommit(state.batch.root) };
  if (!claimed.cached) await finishGate(tree, gate);
  await save(state, { state: gate.isGreen ? 'ready' : 'blocked' });
  return { batch: state.batch, gate };
}

/** Read a completed speculative result from its immutable raw log, without another execution. */
function savedCandidateResult(candidate) {
  if (!candidate.complete) return null;
  if (candidate.error) throw new Refused(candidate.error.code, candidate.error.message);
  const gate = candidate.gate;
  return { batch: candidate.snapshot, gate: gate ? { ...gate, output: readFileSync(gate.logPath, 'utf8') } : null };
}

/** Keep only small replayable gate metadata; the complete output remains in its immutable log. */
function candidateGateRecord(gate) {
  if (!gate) return null;
  const { tree, isGreen, failures, accounted, complete, requiresGreen, logPath, flakeDiagnostics, timedOut, proofRoot, proofCommit, affectedGate } = gate;
  return { tree, isGreen, failures, accounted, complete, requiresGreen, logPath, affectedGate,
    ...(proofRoot ? { proofRoot, proofCommit } : {}),
    ...(flakeDiagnostics ? { flakeDiagnostics } : {}), ...(timedOut ? { timedOut } : {}) };
}

/** Run all prefixes through normal admission, serializing their delta receipts under one batch. */
async function parallelPrefixes(state, entries) {
  let serial = Promise.resolve();
  const claims = new Map();
  /** A failed delta must not prevent other already-running children from sealing their receipts. */
  const ordered = action => {
    const pending = serial.then(action);
    serial = pending.catch(() => {});
    return pending;
  };
  const counts = badgeCounts(state.board);
  const groups = entries.map((_, index) => entries.slice(0, index + 1));
  const descriptors = groups.map(group => {
    const key = createHash('sha256').update(JSON.stringify(['affected-gate-v1', state.batch.base, group, counts, liveWaiverProjection(state.board)])).digest('hex');
    const previous = state.batch.parallelCandidates?.find(candidate => candidate.key === key);
    if (previous) {
      if (previous.gate) state.gates.set(previous.gate.tree, previous.gate);
      return previous;
    }
    const directory = join(dirname(state.batch.root), 'candidates', key);
    return { key, snapshot: { version: 1, id: randomUUID(), base: state.batch.base, tip: state.batch.base,
      branch: state.batch.branch, root: join(directory, 'worktree'), items: group, candidates: group,
      conflicts: [], blocked: [], state: 'merging', owner: state.batch.owner,
      logPath: join(directory, 'logs', 'candidate.log'), revision: 0 } };
  });
  await save(state, { state: 'gating', parallelCandidates: [...(state.batch.parallelCandidates ?? []),
    ...descriptors.filter(candidate => !state.batch.parallelCandidates?.some(previous => previous.key === candidate.key))] });
  /** Replace only this child's descriptor; every sibling and the parent's evidence stay current. */
  const update = (key, patch) => ordered(async () => {
    const latest = state.batch.parallelCandidates.find(candidate => candidate.key === key);
    const updated = { ...latest, ...patch };
    await save(state, { parallelCandidates: state.batch.parallelCandidates.map(candidate => candidate.key === key ? updated : candidate) });
    return updated;
  });
  const settled = await Promise.allSettled(descriptors.map(async descriptor => {
    const previous = savedCandidateResult(descriptor);
    if (previous) return previous;
    const key = descriptor.key;
    /** Virtual child batches append deltas to their one canonical parent, never overwrite it. */
    const write = async (operation, args) => {
      if (operation === 'claimGate') {
        const [tree, affectedGate] = args;
        const recorded = state.gates.get(tree);
        if (recorded?.timedOut) throw new Refused('LAND_GATE_TIMEOUT', 'this exact tree has a recorded landing timeout; inspect its log before starting a new batch');
        const cached = recorded?.affectedGate === affectedGate ? recorded : null;
        if (cached && (completeGate(cached) || !coveredFailures(state, cached))) return { cached };
        const prior = claims.get(tree);
        if (prior) return { cached: await prior.promise };
        let resolveGate;
        let rejectGate;
        const promise = new Promise((resolveResult, rejectResult) => { resolveGate = resolveResult; rejectGate = rejectResult; });
        void promise.catch(() => {});
        claims.set(tree, { key, promise, resolveGate, rejectGate });
        return { owner: true, ...(cached ? { previous: cached } : {}) };
      }
      if (operation === 'finishGate') {
        const [tree, gate] = args;
        const claim = claims.get(tree);
        if (!claim || claim.key !== key || gate.tree !== tree) throw new Refused('LAND_CANDIDATE', 'a candidate returned another tree’s gate; inspect its checkpoint');
        state.gates.set(tree, gate);
        claim.resolveGate(gate);
        return null;
      }
      if (operation !== 'recordLandingBatch') return await state.write(operation, args);
      return await ordered(async () => {
        const { batch, revision } = args[0];
        const latest = state.batch.parallelCandidates.find(candidate => candidate.key === key);
        const before = latest.snapshot;
        validateLandingBatch(batch, revision);
        validateLandingRevision(before, batch, revision);
        const snapshot = { ...batch, revision: revision + 1 };
        const evidence = state.batch.invariantEvidence ?? { version: 1, gates: [], diagnostics: [] };
        const childEvidence = snapshot.invariantEvidence ?? { gates: [], diagnostics: [] };
        const oldEvidence = before.invariantEvidence ?? { gates: [], diagnostics: [] };
        for (const kind of ['gates', 'diagnostics']) {
          if (JSON.stringify(childEvidence[kind].slice(0, oldEvidence[kind].length)) !== JSON.stringify(oldEvidence[kind])) {
            throw new Refused('LAND_EVIDENCE', 'candidate evidence is append-only; inspect the saved prefix before adopting');
          }
        }
        await save(state, { parallelCandidates: state.batch.parallelCandidates.map(candidate => candidate.key === key ? { ...candidate, snapshot } : candidate),
          invariantEvidence: { ...evidence,
            gates: [...evidence.gates, ...childEvidence.gates.slice(oldEvidence.gates.length)],
            diagnostics: [...evidence.diagnostics, ...childEvidence.diagnostics.slice(oldEvidence.diagnostics.length)] } });
        return snapshot;
      });
    };
    try {
      const result = await runLandingCandidateWorker({ root: state.root, config: state.config, batch: descriptor.snapshot,
        entries: descriptor.snapshot.candidates, fence: state.fence }, {
        write, checkLease: state.checkLease, say: state.say, onWait: state.onWait,
        onStart: pid => update(key, { workerPid: pid }),
      });
      await update(key, { complete: true, gate: candidateGateRecord(result.gate) });
      return result;
    } catch (error) {
      for (const claim of claims.values()) if (claim.key === key) claim.rejectGate(error);
      await update(key, { complete: true, error: { code: error.code ?? 'LAND_CANDIDATE', message: error.message } });
      throw error;
    }
  }));
  await serial;
  // All siblings have ended before authority returns to a physical merge or publication.
  const failure = settled.find(result => result.status === 'rejected');
  if (failure) throw failure.reason;
  return settled.map(result => result.value);
}

/** Move the parent's fixed worktree to an already tested composition without rebuilding its tree. */
async function promoteCandidate(state, candidate) {
  await state.checkLease();
  state.checkLeaseNow();
  if (!isClean(state.batch.root) || untracked(state.batch.root).length) throw new Refused('LAND_DIRTY', 'the landing worktree changed; inspect it before adopting');
  git(state.batch.root, ['checkout', '--detach', candidate.batch.tip]);
  await save(state, { tip: candidate.batch.tip, items: candidate.batch.items,
    conflicts: candidate.batch.conflicts ?? [], resolutions: candidate.batch.resolutions ?? [], doctrineCounts: candidate.batch.doctrineCounts ?? [] });
}

/** Exclude a returned candidate and explicit or Git-stacked dependents from later speculation. */
function withoutParallelBlocker(state, entries, removed) {
  const blocked = new Set([removed.id]);
  return entries.filter(entry => {
    if (blocked.has(entry.id)) return false;
    const item = store.getItem(state.board, entry.id);
    requireOutsideOwner(state.board, item);
    const dependency = localDependencyIds(item).find(id => blocked.has(id));
    const stacked = tryGit(state.root, ['merge-base', '--is-ancestor', removed.reviewedCommit ?? removed.commit, entry.reviewedCommit ?? entry.commit]).status === 0;
    if (dependency || stacked) {
      blocked.add(entry.id);
      state.batch.blocked = [...state.batch.blocked, { id: entry.id, code: 'STACKED_UNVERIFIED', stacked: dependency ?? removed.id }];
      return false;
    }
    return true;
  });
}

/** Trust a recorded positive main comparison only for every exact failing target of this gate. */
function parallelGreenBase(state, gate) {
  const ids = new Set((gate.flakeDiagnostics?.observations ?? []).filter(row => row.recorded).map(row => row.id));
  const observations = store.flakeLedger(state.board).flatMap(row => row.observations).filter(row => ids.has(row.id));
  return gate.failures.length > 0 && gate.failures.every(failure => observations.some(observation => observation.file === failure.file
    && observation.name === failure.name && observation.main === state.batch.base
    && observation.classification === 'possible-regression' && observation.mainReceipt?.green === true));
}

/** Test prefixes together, remove only diagnosed blockers, and publish one exact green composition. */
async function parallelLanding(state, initialItems) {
  let remaining = initialItems;
  // A death between returning B and saving survivors must never resurrect a C stacked on B.
  const originals = state.batch.candidates ?? initialItems;
  for (const id of new Set([...state.culprits.map(entry => entry.id), ...(state.batch.conflicts ?? []).map(entry => entry.id)])) {
    const removed = originals.find(entry => entry.id === id);
    if (removed) remaining = withoutParallelBlocker(state, remaining, removed);
  }
  const excluded = new Set((state.batch.blocked ?? []).map(entry => entry.id));
  remaining = remaining.filter(entry => !excluded.has(entry.id));
  // Restore every sealed tree, even when changed badge counts produce a new descriptor key.
  for (const candidate of state.batch.parallelCandidates ?? []) {
    for (const gate of candidate.snapshot.gateResults ?? []) {
      if (!state.gates.has(gate.tree)) state.gates.set(gate.tree, { ...gate, proofRoot: candidate.snapshot.root,
        proofCommit: candidate.snapshot.invariantEvidence?.gates.findLast(entry => entry.isGreen)?.commit });
    }
    if (candidate.gate) state.gates.set(candidate.gate.tree, candidate.gate);
  }
  await save(state, { parallelRemaining: remaining });
  while (remaining.length) {
    const results = await parallelPrefixes(state, remaining);
    const conflicts = results.flatMap(result => result.batch.conflicts ?? []);
    if (conflicts.length) {
      const blocker = remaining.find(entry => conflicts.some(conflict => conflict.id === entry.id));
      await save(state, { conflicts });
      remaining = withoutParallelBlocker(state, remaining, blocker);
      await save(state, { parallelRemaining: remaining });
      continue;
    }
    const green = results.findLastIndex(result => result.gate?.isGreen || result.gate && waivedProof(state, result.gate));
    if (green === results.length - 1) {
      const candidate = results[green];
      await promoteCandidate(state, candidate);
      if (landsOnTrunk(state.config)) { await landOnTrunk(state); return; }
      if (!await inlineDeferredGuards(state)) { await save(state, { state: 'blocked' }); return; }
      const proof = candidate.gate.isGreen ? { tree: candidate.gate.tree, failures: [], logPath: candidate.gate.logPath } : waivedProof(state, candidate.gate);
      if (!proof) throw new Refused('LAND_WAIVER', 'the candidate’s waiver expired; inspect the gate before adopting');
      await save(state, { state: 'ready', proof, parallelProofRoot: candidate.gate.proofRoot ?? candidate.batch.root, culprits: state.culprits });
      await publish(state);
      return;
    }
    const boundary = results[green + 1];
    await promoteCandidate(state, boundary);
    const gate = boundary.gate;
    const flakyFiles = await diagnose(state, gate.failures, gate);
    if (flakyFiles.length) { await fileFlakes(state, gate, flakyFiles); state.flaky = true; return; }
    const culprit = remaining[green + 1];
    const greenBase = green >= 0 && results[green].gate.isGreen && completeGate(results[green].gate)
      || parallelGreenBase(state, gate);
    if (!greenBase) { await fileTestDefects(state, gate); state.flaky = true; return; }
    // A red A+B with green A can still be an interaction: B alone must reproduce those failures.
    // This is a distinct composition, not a retry of A+B or any other already tested tree.
    const [alone] = await parallelPrefixes(state, [culprit]);
    const signatures = new Set((alone.gate?.failures ?? []).map(failure => JSON.stringify([failure.file, failure.name])));
    if (!alone.gate || alone.gate.isGreen || !gate.failures.every(failure => signatures.has(JSON.stringify([failure.file, failure.name])))) {
      await promoteCandidate(state, boundary);
      await fileTestDefects(state, gate);
      state.flaky = true;
      return;
    }
    await promoteCandidate(state, alone);
    const aloneFlakes = await diagnose(state, alone.gate.failures, alone.gate);
    if (aloneFlakes.length) { await fileFlakes(state, alone.gate, aloneFlakes); state.flaky = true; return; }
    await bisect(state, [culprit], gate.failures);
    remaining = withoutParallelBlocker(state, remaining, culprit);
    await save(state, { parallelRemaining: remaining });
  }
  await save(state, { state: 'blocked', culprits: state.culprits });
}

/** Run each failing file once alone, with the same queued machine capacity as other checks. */
async function diagnose(state, failures, gate) {
  // The enabled observer already made the only allowed exact-target pair under the original lease.
  // A saved gate retains that association, so adopting it cannot repeat a confidence measurement.
  if (state.config.flakes?.rerun === true) {
    const observations = gate?.flakeDiagnostics?.observations ?? [];
    if (gate?.flakeDiagnostics?.error || !observations.length || observations.some(row => !row.recorded || row.classification === 'unclassified')) {
      await save(state, { state: 'blocked', failures, flakeDiagnostics: gate?.flakeDiagnostics });
      throw new Refused('LAND_DIAGNOSTIC', `the original red has no complete classified diagnostic; no additional run or landing is allowed; inspect ${gate.logPath} and pullboard flakes`);
    }
    return [...new Set(observations.filter(row => row.classification === 'flake' && row.file).map(row => row.file))];
  }
  if (!failures.length || failures.some((entry) => !entry.file)) throw new Refused('LAND_DIAGNOSTIC', `the gate did not name a failing test file; inspect ${state.batch.logPath} and make its reporter name source files`);
  const files = [...new Set(failures.map((entry) => entry.file))];
  const flakes = [];
  for (const file of files) {
    if (state.diagnosed.has(file)) { if (state.diagnosed.get(file)) flakes.push(file); continue; }
    const runner = state.config.affectedTests || (/\.[cm]?js$/u.test(file) ? 'node --test' : null);
    if (!runner) throw new Refused('LAND_DIAGNOSTIC', `no runner can isolate ${file}; configure affectedTests for the project’s test runner`);
    const commit = headCommit(state.batch.root);
    const tree = headTree(state.batch.root);
    const result = await withLandingGateSlot(state.batch.root, (lease) => runProfiledShell(state.batch.root, `${runner} ${quote(file)}`, {
      waitMs: lease.waitMs, artifactDirectory: dirname(state.batch.logPath), artifactPrefix: 'diagnostic', persistLog: true, pipefail: true, gateLease: lease,
    }), { landing: true, browser: true, agent: 'coordinator', kind: 'land-diagnostic', onWait: state.onWait });
    if (headCommit(state.batch.root) !== commit || headTree(state.batch.root) !== tree || !isClean(state.batch.root)) {
      throw new Refused('LAND_SOURCE_CHANGED', `the landing source changed during its whole-file diagnostic; inspect ${result.logPath} before adopting`);
    }
    state.diagnosed.set(file, result.isGreen);
    const evidence = state.batch.invariantEvidence ?? { version: 1, gates: [], diagnostics: [] };
    await save(state, { diagnostics: [...state.diagnosed].map(([test, isGreen]) => ({ test, isGreen })),
      invariantEvidence: { ...evidence, diagnostics: [...evidence.diagnostics,
        { test: file, isGreen: result.isGreen, commit, wallMs: result.profile?.wallMs ?? null }] } });
    if (result.isGreen) flakes.push(file);
  }
  return flakes;
}

/**
 * Read one stage's TAP strictly: test lines outside YAML blocks, each failure's file from its own
 * block, and a final `# fail N` that equals the failures read. Anything after that summary other
 * than summary counts or the package manager's own failure report means something else failed,
 * so the stage is unaccounted and null is returned [B3,R3].
 */
export function tapFailures(output, root) {
  const lines = output.split('\n');
  const failures = [];
  let yaml = null;
  let active = null;
  let version = false;
  let summary = null;
  let summaryAt = -1;
  let cancelled = 0;
  for (const [index, line] of lines.entries()) {
    if (yaml !== null) {
      if (line === `${yaml}...`) { yaml = null; continue; }
      const location = /^\s*location:\s*['"]?(.+?):\d+(?::\d+)?['"]?\s*$/u.exec(line);
      if (active && location) {
        const path = location[1];
        const file = isAbsolute(path) ? relative(root, path) : path.replace(/^\.\//u, '');
        if (file && !file.startsWith('../') && !file.includes('\\')) active.file = file;
      }
      continue;
    }
    const block = /^(\s*)---\s*$/u.exec(line);
    if (block) { yaml = block[1]; continue; }
    if (/^TAP version \d+\s*$/u.test(line)) version = true;
    const failed = /^\s*not ok\s+\d+\s+-\s+(.*)$/u.exec(line);
    if (failed) {
      active = { name: failed[1].replace(/\s+#.*$/u, ''), file: null };
      if (/^(?:\.\/)?(?:test|tests)\/[^\r\n]+\.(?:[cm]?js|ts|py)$/u.test(active.name)) active.file = active.name.replace(/^\.\//u, '');
      failures.push(active);
      continue;
    }
    if (/^\s*ok\s+\d+/u.test(line)) { active = null; continue; }
    const count = /^# fail (\d+)\s*$/u.exec(line);
    if (count) { summary = Number(count[1]); summaryAt = index; }
    const stopped = /^# cancelled (\d+)\s*$/u.exec(line);
    if (stopped) cancelled = Number(stopped[1]);
  }
  if (yaml !== null || !version || summary === null || summary < 1 || summary !== failures.length || cancelled !== 0) return null;
  const trailer = lines.slice(summaryAt + 1).every((line) => !line.trim() || /^# [a-z_]+ \d+(?:\.\d+)?\s*$/u.test(line) || /^npm (?:ERR!|error|warn|notice)\b/u.test(line));
  return trailer ? failures : null;
}

/**
 * The failures that explain a red run, or null when anything else may have failed: the command
 * could not be split into stages, a stage did not finish, a stage exited other than 0 without
 * exactly 1 and a complete TAP account of its failures, or a pipeline in a stage had a component
 * that left no status or failed without its own complete TAP account. Waivers only ever subtract
 * these [B3,R3].
 */
export function accountedFailures(gate, root) {
  if (gate.isGreen || !Array.isArray(gate.stages) || !gate.stages.length) return null;
  // Only the authenticated worker checkout may relocate remote failure locations.
  const executionRoot = gate.executionRoot ?? root;
  const failures = [];
  for (const stage of gate.stages) {
    if (!Number.isInteger(stage.status)) return null;
    if (stage.pipeline !== undefined) {
      // In a pipeline each failing component must explain itself; a forwarded account credits no one else [B3,R3].
      const own = pipelineFailures(stage.pipeline, executionRoot);
      if (!own || (stage.status === 0) !== (own.length === 0)) return null;
      failures.push(...own);
      continue;
    }
    if (stage.status === 0) continue;
    const own = stage.status === 1 ? tapFailures(stage.output ?? '', executionRoot) : null;
    if (!own) return null;
    failures.push(...own);
  }
  return failures.length ? failures : null;
}

/**
 * The failures a pipeline's components account for themselves, or null. Every component must have
 * recorded its status, and every failing one must exit exactly 1 with a complete TAP account in its
 * own output. A setup step that fails beside a consumer printing a waived test's TAP has no account
 * of its own, so it is an independent red no waiver names, and it voids the run.
 */
function pipelineFailures(components, root) {
  if (!Array.isArray(components) || components.some((entry) => !Number.isInteger(entry?.status))) return null;
  const failures = [];
  for (const { status, output } of components.filter((entry) => entry.status !== 0)) {
    const own = status === 1 ? tapFailures(output ?? '', root) : null;
    if (!own) return null;
    failures.push(...own);
  }
  return failures;
}

/**
 * Pair every named failure of a red run with the live person waiver covering it, or return null.
 * One unnamed, unfiled or unwaived failure voids the whole run, so a waiver never hides another red [B3,R3].
 */
export function waivedFailures(board, failures) {
  if (!Array.isArray(failures) || !failures.length || failures.some((entry) => !entry.file)) return null;
  const covered = failures.map((failure) => ({ ...failure, waiver: store.landingWaiverFor(board, failure) }));
  return covered.every((entry) => entry.waiver) ? covered : null;
}

/** Project the live person waivers a landing run may read, so it does not stop early on one [B3]. */
export function liveWaiverProjection(board) {
  const now = board.clock.now().getTime();
  return store.landingWaivers(board).filter((waiver) => Date.parse(waiver.until) > now)
    .map((waiver) => ({ kind: waiver.kind ?? store.landingWaiverKind(waiver.test), test: waiver.test }));
}

/** Name one waived failure with the person's waiver, its reason and its expiry [B3]. */
export function waiverLine(failure) {
  const { waiver } = failure;
  if (waiver.quarantine) return `quarantined: ${failure.name} (${failure.file}) is a proven flake, reported but not blocking until repair #${waiver.quarantine.item} is verified`;
  return `waived: ${failure.name} (${failure.file}) by person waiver ${waiver.id} for ${waiver.kind ?? store.landingWaiverKind(waiver.test)} ${waiver.test}: ${waiver.reason}; expires ${waiver.until}`;
}

/** Record every failure's exact live waiver rather than changing which tests the gate runs. */
function waivedProof(state, gate) {
  if (!completeGate(gate) || gate.requiresGreen) return null;
  const failures = waivedFailures(state.board, gate.accounted);
  return failures ? { tree: gate.tree, failures: failures.map((entry) => ({ ...entry, waiver: entry.waiver.id })), logPath: gate.logPath } : null;
}

/** Bisect a reproducible red without retrying any previously tested group. */
async function bisect(state, items, failures, label = 'split', evaluate = gateGroup) {
  if (items.length === 1) {
    const item = items[0];
    const text = `Landing batch ${state.batch.id} reproduces failures: ${failures.map((failure) => `${failure.file}: ${failure.name}`).join('; ')}`;
    if (!store.itemThread(state.board, item.id).some((entry) => entry.type === 'fact' && entry.text === text)) {
      await state.write('appendFact', [item.id, { agentId: 'coordinator', kind: 'measurement', text }]);
    }
    const mergeCommit = state.batch.tip;
    if (!state.culprits.some((entry) => entry.id === item.id)) state.culprits.push({ id: item.id, commit: item.commit, ...(item.reviewedCommit ? { reviewedCommit: item.reviewedCommit } : {}), mergeCommit, tests: failures });
    await save(state, { culprits: state.culprits });
    await returnCulprits(state);
    state.say(`culprit #${item.id}: ${failures.map((failure) => failure.name).join(', ')}`);
    return [];
  }
  const middle = Math.ceil(items.length / 2);
  const green = [];
  for (const [index, part] of [items.slice(0, middle), items.slice(middle)].entries()) {
    const build = await mergeGroup(state, part);
    await save(state, { ...build, state: 'bisecting' });
    const gate = await evaluate(state, `${label}-${index}`);
    if (gate.isGreen || waivedProof(state, gate)) green.push(...build.items);
    else {
      const flakyFiles = await diagnose(state, gate.failures, gate);
      if (flakyFiles.length) {
        await fileFlakes(state, gate, flakyFiles);
        state.flaky = true;
        return [];
      }
      green.push(...await bisect(state, build.items, gate.failures, `${label}-${index}`, evaluate));
    }
  }
  return green;
}

/** Return recorded red candidates once, including a saved failure interrupted before its move. */
async function returnCulprits(state) {
  for (const culprit of state.culprits) {
    const item = store.getItem(state.board, culprit.id);
    if (item.item_status !== 'verified' || item.item_merged_commit || item.item_commit !== culprit.commit
      || (culprit.reviewedCommit ?? culprit.commit) !== store.checkedLandingCommit(state.board, item)
      || !/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/u.test(culprit.mergeCommit ?? '')) continue;
    const note = `Landing batch ${state.batch.id} failed ${culprit.tests.map((failure) => `${failure.file}: ${failure.name}`).join('; ')}; merge commit ${culprit.mergeCommit}`;
    await state.write('reopen', [culprit.id, { agentId: 'coordinator', note }]);
  }
}

/** Reopen only exact saved conflicting submissions after candidate composition has completed. */
async function returnMergeConflicts(state) {
  for (const conflict of state.batch.conflicts ?? []) {
    const item = store.getItem(state.board, conflict.id);
    if (item.item_status !== 'verified' || item.item_merged_commit || item.item_commit !== conflict.commit
      || store.checkedLandingCommit(state.board, item) !== conflict.reviewedCommit) continue;
    await state.write('reopen', [item.item_id, { agentId: 'coordinator',
      note: `landing conflict: ${conflict.files.join(', ')}; merge current main and resubmit`, conflict: { files: conflict.files, trunk: conflict.trunk } }]);
  }
}

/** File a flake once against its named test and leave the batch stopped. */
async function fileFlakes(state, gate, files) {
  if (state.config.flakes?.rerun === true) {
    await save(state, { state: 'blocked', failures: gate.failures, flakeDiagnostics: gate.flakeDiagnostics });
    state.say(`flake observed: ${files.join(', ')}; the original gate stays red and nothing lands; inspect pullboard flakes`);
    return;
  }
  const flakes = [];
  for (const file of files) {
    const owner = laneOf(state.config, file);
    const lane = owner === 'coordinator' ? store.getItem(state.board, state.batch.items[0].id).item_lane : owner;
    flakes.push(await state.write('recordLandingFlake', [{ agentId: 'coordinator', test: file, hash: testHash(state.batch.root, file),
      names: gate.failures.filter((entry) => entry.file === file).map((entry) => entry.name), lane, batchId: state.batch.id }]));
  }
  await save(state, { state: 'flaky', failures: gate.failures, flakes });
  state.say(`flake: ${files.join(', ')}; nothing landed; fix the test or ask the person for an expiring waiver`);
}

/** File a neutral test defect for the exact no-culprit red and leave its proof available for a waiver. */
async function fileTestDefects(state, gate) {
  const defects = [];
  const files = [...new Set(gate.failures.map(failure => failure.file).filter(Boolean))];
  if (!files.length) throw new Refused('LAND_DIAGNOSTIC', 'the no-culprit gate did not identify a failing test file');
  for (const file of files) {
    const owner = laneOf(state.config, file);
    const lane = owner === 'coordinator' ? store.getItem(state.board, state.batch.items[0].id).item_lane : owner;
    defects.push(await state.write('recordLandingTestDefect', [{ agentId: 'coordinator', test: file,
      hash: testHash(state.batch.root, file), blob: testBlob(state.batch.root, state.batch.tip, file),
      trunkBlob: testBlob(state.root, state.batch.base, file),
      names: gate.failures.filter(failure => failure.file === file).map(failure => failure.name),
      lane, batchId: state.batch.id, branch: state.batch.branch }]));
  }
  await save(state, { state: 'test-defect', failures: gate.failures, testDefects: defects });
  state.say(`the trunk is held by a test defect: ${files.join(', ')}; correct the test or ask an approver for an expiring waiver`);
}

/** Name the remote a landing pushes the trunk to: the trunk branch's own remote, else origin [B3]. */
function landingRemoteName(root, branch) {
  return tryGit(root, ['config', '--get', `branch.${branch.replace(/^refs\/heads\//u, '')}.remote`]).stdout || 'origin';
}

/**
 * Name the configured remote a landing would push the trunk to, or null when this repo has none [B3].
 * An accept uses it to say which landing command fits this repo; the landing itself refuses on null.
 */
export function landingRemote(root, branch) {
  const remote = landingRemoteName(root, branch);
  return tryGit(root, ['remote', 'get-url', remote]).status === 0 ? remote : null;
}

/** Build the one LAND_PUSH refusal every landing push failure reports, real or previewed [B3]. */
function pushRefused(reason, next = 'inspect the remote and hooks, then run pullboard land --adopt') {
  return new Refused('LAND_PUSH', `the landing push failed: ${reason}; ${next}`);
}

/**
 * Return the remote a landing pushes to, refusing LAND_PUSH when it does not exist [B3].
 * The dry run and the real landing both call this, so a preview cannot say "would land" for a push that must fail.
 */
function requirePushTarget(root, branch) {
  const remote = landingRemote(root, branch);
  if (remote) return remote;
  const missing = landingRemoteName(root, branch);
  throw pushRefused(`this repo has no ${missing} remote to push ${branch.replace(/^refs\/heads\//u, '')} to`,
    `add one with git remote add ${missing} <url> and run pullboard land again, or merge each verified commit on the trunk with git merge --no-ff and record it with pullboard merged <id> <commit>`);
}

/** Recheck immutable publication inputs after the last awaited canonical operation. */
function publicationInputs(state, batch) {
  requireLandingCarries(state, batch);
  for (const entry of batch.items) {
    const item = store.getItem(state.board, entry.id);
    requireOutsideOwner(state.board, item);
    if (item.item_status !== 'verified' || item.item_commit !== entry.commit
      || store.checkedLandingCommit(state.board, item) !== (entry.reviewedCommit ?? entry.commit)) {
      throw new Refused('LAND_ITEM_MOVED', `item #${entry.id} changed its checked composition; rebuild the landing before publishing`);
    }
  }
  if (batch.proof?.failures?.some(failure => !store.landingWaiverFor(state.board, failure))) throw new Refused('LAND_WAIVER', 'the landing proof has an expired or missing person waiver; ask the person for a new expiring waiver, then adopt the batch');
  if (headCommit(batch.root) !== batch.tip || !isClean(batch.root) || untracked(batch.root).length) throw new Refused('LAND_MOVED', 'the gated landing tree changed; inspect the batch and adopt it again');
  if (mainCheckout(state.root)?.commit !== batch.base) throw new Refused('LAND_TRUNK_MOVED', 'main moved during the landing; rebuild the batch from its new tip');
}

/** Push from the actual gate-owning worktree, preserving its native stamp and canonical batch root. */
function parallelPublicationRoot(state, batch) {
  const root = batch.parallelProofRoot ?? batch.root;
  if (root === batch.root) return root;
  const owner = (batch.parallelCandidates ?? []).some(candidate => candidate.snapshot.root === root
    && (candidate.gate?.tree === batch.proof?.tree || candidate.snapshot.gateResults?.some(gate => gate.tree === batch.proof?.tree)));
  if (!owner || !existsSync(root) || realpathSync(repoInfo(root).commonDir) !== realpathSync(repoInfo(batch.root).commonDir)) {
    throw new Refused('LAND_MOVED', 'the recorded gate-owning worktree is missing or belongs to another repository; restore it before adopting');
  }
  const tree = git(state.root, ['rev-parse', `${batch.tip}^{tree}`]);
  if (batch.proof?.tree !== tree || headTree(root) !== tree || headTree(batch.root) !== tree || !isClean(root) || untracked(root).length) {
    throw new Refused('LAND_MOVED', 'the speculative proof no longer matches both clean landing trees; restore the exact recorded composition before adopting');
  }
  // Existing native stamps prove trees. A duplicate composition may have different merge metadata;
  // checking out its identical tree preserves that contract without creating or copying any stamp.
  state.checkLeaseNow();
  if (headCommit(root) !== batch.tip) git(root, ['checkout', '--detach', batch.tip]);
  if (!(batch.proof.failures ?? []).length && !isStampedGreen(root)) {
    throw new Refused('LAND_MOVED', 'the gate-owning worktree lost its native green stamp; inspect the recorded gate before adopting');
  }
  return root;
}

/** Push the exact gated tip before recording receipts, then fast-forward only a clean unchanged main. */
async function publish(state) {
  let batch = state.batch;
  requireLandingCarries(state, batch);
  const remote = requirePushTarget(state.root, batch.branch);
  if (batch.proof?.failures?.length && batch.state !== 'pushed') {
    const failures = batch.proof.failures.map((failure) => ({ ...failure, waiver: store.landingWaiverFor(state.board, failure)?.id }));
    if (!failures.every((failure) => failure.waiver)) throw new Refused('LAND_WAIVER', 'the landing proof has an expired or missing person waiver; ask the person for a new expiring waiver, then adopt the batch');
    batch = await save(state, { proof: { ...batch.proof, failures } });
  }
  if (batch.state !== 'pushed') {
    await state.checkLease();
    publicationInputs(state, batch);
    const pushRoot = parallelPublicationRoot(state, batch);
    const alreadyPushed = tryGit(batch.root, ['ls-remote', remote, batch.branch]).stdout.split(/\s+/u)[0] === batch.tip;
    if (!alreadyPushed) {
      state.checkLeaseNow();
      const pushed = tryGit(pushRoot, ['push', remote, `HEAD:${batch.branch}`]);
      if (pushed.status !== 0) throw pushRefused(pushed.stderr || pushed.stdout);
    }
    await save(state, { state: 'pushed' });
  }
  if (tryGit(batch.root, ['ls-remote', remote, batch.branch]).stdout.split(/\s+/u)[0] !== batch.tip) {
    throw new Refused('LAND_REMOTE_MOVED', 'the remote no longer names the pushed batch tip; inspect it before adopting, without rewriting the remote');
  }
  state.batch = await state.write('finishLandingBatch', [{ agentId: 'coordinator', id: state.batch.id, tip: state.batch.tip }]);
  await state.checkLease();
  const main = mainCheckout(state.root);
  if (main?.commit === state.batch.base && isClean(state.root) && !untracked(state.root).length) git(state.root, ['merge', '--ff-only', state.batch.tip]);
  await refreshLandedCodeMap(state);
  state.say(`landed ${state.batch.items.map((entry) => `#${entry.id}`).join(', ')} at ${state.batch.tip}`);
  return state.batch;
}

/** Whether this project lands in two tiers: on the local trunk at once, and on the remote only through publish (#801). */
export function landsOnTrunk(config) {
  return config?.landing?.publish === 'separate';
}

/**
 * Prove a tier-1 batch's actual merged diff with submit's affected map (#1277). Fixed invariants and registry
 * guards remain a floor; an uncertain import graph requires the configured full gate before adoption.
 */
async function quickGuards(state, label = 'local-trunk') {
  await runStaticChecks(state.batch.root, state.config, { agent: 'coordinator', onWait: state.onWait });
  const gate = await gateGroup(state, label, { localTrunk: true });
  if (!gate.isGreen && (!completeGate(gate) || !gate.accounted)) {
    throw new Refused('LAND_DIAGNOSTIC', 'the local-trunk guards have no complete accounted failure; inspect the recorded gate before adopting');
  }
  if (!gate.isGreen && !waivedProof(state, gate)) requireLocalGuardClassification(state, gate);
  return gate;
}

/** The affected test files each batch item's submission moved to the landing gate, read from its exact submit. */
function deferredSelections(state) {
  return state.batch.items.flatMap((entry) => {
    const event = store.events(state.board, { itemId: entry.id }).findLast((row) => row.event_kind === 'submit');
    const detail = event ? JSON.parse(event.event_detail) : null;
    const files = detail?.commit === entry.commit ? detail.submissionProof?.deferredFiles ?? [] : [];
    return files.length ? [{ entry, files }] : [];
  });
}

/**
 * Run every affected test file a submit deferred over submitDeferAbove on the merged tree, before anything lands.
 * A red sends back each item whose own deferred selection holds a failing file, the way a red submit would.
 */
async function deferredGuards(state) {
  return runDeferredGuards(state, { deferredSelections, landingFailures, save, returnCulprits });
}

/** Run the deferred affected tests before an inline landing's gate; false when they are red and nothing may land. */
async function inlineDeferredGuards(state) {
  try { await deferredGuards(state); return true; } catch (error) {
    if (!(error instanceof Refused) || error.code !== 'GATE_RED') throw error;
    state.say(`nothing landed: ${error.message}`);
    return false;
  }
}

/**
 * Tier 1 (#801): after a clean merge and its quick guards, the batch lands on the local trunk in seconds, with each
 * item's merged receipt; nothing is pushed. pullboard publish runs the whole suite on the trunk head and pushes it.
 */
async function landOnTrunk(state) {
  await save(state, { state: 'gating', tip: headCommit(state.batch.root) });
  let gate;
  try {
    gate = await quickGuards(state);
    if (!gate.isGreen && !waivedProof(state, gate)) {
      const flakyFiles = await diagnose(state, gate.failures, gate);
      if (flakyFiles.length) { await fileFlakes(state, gate, flakyFiles); state.flaky = true; return; }
      const green = await bisect(state, state.batch.items, gate.failures, 'local-split', quickGuards);
      if (state.flaky || !green.length) {
        if (!state.flaky) await save(state, { state: 'blocked', culprits: state.culprits });
        return;
      }
      const rebuilt = await mergeGroup(state, green);
      await save(state, { ...rebuilt, culprits: state.culprits });
      gate = await quickGuards(state, 'local-green-items');
      if (!gate.isGreen && !waivedProof(state, gate)) {
        if (!state.culprits.length) { await fileTestDefects(state, gate); state.flaky = true; return; }
        await save(state, { state: 'blocked', failures: gate.failures, culprits: state.culprits });
        throw new Refused('LAND_INTERACTION', 'the individually green items fail together; nothing retries or lands; inspect the batch’s failing tests');
      }
    }
  } catch (error) {
    if (!(error instanceof Refused)) throw error;
    if (!['flaky', 'test-defect'].includes(state.batch.state)) await save(state, { state: 'blocked' });
    state.say(`nothing landed: ${error.message}`);
    return;
  }
  for (const entry of state.batch.items) {
    const item = store.getItem(state.board, entry.id);
    requireOutsideOwner(state.board, item);
    if (item.item_status !== 'verified' || item.item_commit !== entry.commit) throw new Refused('LAND_ITEM_MOVED', `item #${entry.id} changed after the batch merged; rebuild its landing`);
  }
  if (mainCheckout(state.root)?.commit !== state.batch.base) throw new Refused('LAND_TRUNK_MOVED', 'main moved during the landing; rebuild the batch from its new tip');
  const proof = gate.isGreen ? { tree: gate.tree, failures: [], logPath: gate.logPath } : waivedProof(state, gate);
  if (!proof) throw new Refused('LAND_WAIVER', 'the local-trunk red lost its live person waiver; ask the person for a new expiring waiver, then adopt the batch');
  await save(state, { state: 'trunk', proof });
  await finishTrunk(state);
}

/** Reject forged or stale canonical carries even when resuming an already-gated batch. */
function requireLandingCarries(state, batch) {
  for (const entry of batch.items) {
    const problem = mergeOnlyLandingProblem(state.root, state.board, store.getItem(state.board, entry.id));
    if (problem) throw problem;
  }
}

/** Record a tier-1 batch's merged receipts and move the local trunk to it; an adopted 'trunk' batch resumes here (#801). */
async function finishTrunk(state) {
  await state.checkLease();
  publicationInputs(state, state.batch);
  state.batch = await state.write('finishLandingBatch', [{ agentId: 'coordinator', id: state.batch.id, tip: state.batch.tip }]);
  await state.checkLease();
  const main = mainCheckout(state.root);
  if (main?.commit === state.batch.base && isClean(state.root) && !untracked(state.root).length) git(state.root, ['merge', '--ff-only', state.batch.tip]);
  await refreshLandedCodeMap(state);
  state.say(`landed ${state.batch.items.map((entry) => `#${entry.id}`).join(', ')} at ${state.batch.tip} on the local trunk; pullboard publish pushes it once the whole suite passes`);
}

/** Skip admission only when no queued owner, interrupted batch or recorded Git repair needs it. */
function idleLanding(board, trunk) {
  const lease = landingLeaseState(board);
  if (lease.holder || lease.line.length) return false;
  return !store.landingBatches(board).some(batch =>
    (batch.state !== 'landed' && batch.state !== 'blocked')
      || (batch.state === 'landed' && batch.base === trunk));
}

/** Preserve the existing empty selection's refusal, blocked reports and result shape. */
function emptyLanding(selected, say) {
  const stale = selected.blocked.find(item => item.code === 'STALE_VERDICT');
  if (stale) throw staleVerdictRefusal({ item_id: stale.id }, stale);
  for (const entry of selected.blocked) say(`${entry.code} #${entry.id}${entry.stacked ? ` carries #${entry.stacked}` : ''}`);
  return { batch: null, landed: [], conflicts: [], blocked: selected.blocked, culprits: [], flakes: [] };
}

/** Require a separate admitted slot for every speculative gate, without holding a parent gate open. */
function requireParallelGateAdmission(root, config) {
  if (config.landing?.parallel === true && inheritedGateSlot({ root, namedFiles: true })) {
    throw new Refused('LAND_PARALLEL_NESTED_GATE', 'parallel landing needs separately admitted gate slots; run pullboard land outside the current gate command');
  }
}

/** Build, gate, diagnose and durably land one coordinator batch; all external actions stay in its worktree. */
export async function land(options) {
  if (options.dryRun) return runLandingBatch(options);
  invalidateGitFacts();
  const trunk = mainCheckout(options.root);
  const branch = trunk?.branch;
  if (!branch) throw new Refused('LAND_TRUNK', 'landing needs the coordinator’s primary branch; return its checkout to the trunk');
  if (trunk.commit) requireParallelGateAdmission(options.root, policyAt(options.root, trunk.commit).config);
  if (trunk.commit && !options.adopt) {
    requireConfirmedLanding(options.board);
    if (!options.due || idleLanding(options.board, trunk.commit)) {
      const deferred = cadenceDeferral(options.board, policyAt(options.root, trunk.commit).config, branch, options.say, options.due);
      if (deferred) return deferred;
    }
  }
  if (trunk.commit && !options.adopt && idleLanding(options.board, trunk.commit)) {
    requireConfirmedLanding(options.board);
    // Only accepted trunk policy may inform this read-only preflight.
    const config = policyAt(options.root, trunk.commit).config;
    options.board.quarantineEnabled = () => config.flakes?.quarantine === true;
    const selected = candidates(options.board, options.root, trunk.commit, options.maximum ?? Infinity, { firstReady: true });
    invalidateGitFacts();
    const current = mainCheckout(options.root);
    if (!selected.ready.length && current?.commit === trunk.commit && current.branch === branch
      && idleLanding(options.board, trunk.commit)) {
      requireConfirmedLanding(options.board);
      return emptyLanding(selected, options.say);
    }
  }
  let lastWait = '';
  const controller = new AbortController();
  const lease = await takeLandingResource({ board: options.board, write: options.write, refresh: options.refresh, branch,
    onLost: error => controller.abort(error),
    /** Report a real ordered holder, without allocating machine test capacity to this waiter. */
    onWait({ holders, position }) {
      const holder = holders[0];
      const elapsed = holder ? Math.max(0, Math.floor((options.board.clock.now().getTime() - Date.parse(holder.since)) / 1000)) : 0;
      const message = `landing waiting: ${branch} held by ${holder?.label ?? 'the previous landing'} on ${holder?.machine ?? (holder?.lineage ? 'the recorded coordinator machine (legacy identity)' : 'this machine')} for ${elapsed}s; queued at place ${position}; foreign holders require explicit release or pullboard takeover`;
      if (message !== lastWait) options.say(message);
      lastWait = message;
    } });
  let failed = false;
  try {
    await lease.assertHeld();
    invalidateGitFacts(); // The holder may have moved main while this command waited.
    /** Bind each batch transition to this acknowledged grant, never to an optimistic local result. */
    const write = async (operation, args) => {
      await lease.assertHeld();
      const values = ['recordLandingBatch', 'finishLandingBatch'].includes(operation)
        ? [{ ...args[0], landingFence: lease.fence }, ...args.slice(1)] : args;
      return options.write(operation, values);
    };
    /** Relay catch-up can change proof or trunk facts while a renewal awaits its receipt. */
    const checkLease = async () => { await lease.assertHeld(); invalidateGitFacts(); };
    const batchOptions = { root: options.root, config: options.config, owner: options.owner, maximum: Number.isFinite(options.maximum) ? options.maximum : null,
      adopt: options.adopt, due: options.due, fence: lease.fence };
    if (batchOptions.maximum === null) delete batchOptions.maximum;
    return await runLandingWorker(batchOptions, { write, checkLease, checkLeaseNow: lease.assertCurrent,
      bindWorker: lease.bindWorker, watchDeadline: lease.watchDeadline, onWait: options.onWait, say: options.say, signal: controller.signal });
  } catch (error) { failed = true; throw error; }
  finally {
    try { await lease.release(); }
    catch (error) {
      if (!failed) throw error;
      options.say(`landing lease release was not acknowledged: ${error.code ?? 'ERROR'}; inspect pullboard resume before adopting`);
    }
  }
}

/** Select only after admission, retaining the existing batch, proof and adoption rules. */
export async function runLandingBatch({ root, board, config, write, say, owner, maximum = Infinity, dryRun = false, adopt = false, due = false, onWait, checkLease, checkLeaseNow, fence }) {
  let trunk = mainCheckout(root);
  if (fence && trunk?.branch !== fence.branch) throw new Refused('LAND_LEASE_LOST', 'the trunk branch changed while landing waited; start a new land command for its current branch');
  const unfinished = store.landingBatches(board).findLast((batch) => batch.state !== 'landed' && batch.state !== 'blocked');
  if (fence && unfinished && unfinished.branch !== fence.branch) throw new Refused('LAND_LEASE_LOST', 'the interrupted batch belongs to another trunk branch; restore that branch and start a fresh land --adopt');
  if (!dryRun && unfinished) for (const entry of unfinished.items ?? []) requireOutsideOwner(board, store.getItem(board, entry.id));
  const recorded = store.landingBatches(board).findLast((batch) => batch.state === 'landed' && batch.base === trunk?.commit);
  if (fence && recorded && recorded.branch !== fence.branch) throw new Refused('LAND_LEASE_LOST', 'the recorded Git repair belongs to another trunk branch; restore that branch before landing');
  if (!dryRun && recorded && isClean(root) && !untracked(root).length) {
    await checkLease();
    git(root, ['merge', '--ff-only', recorded.tip]);
    trunk = mainCheckout(root);
  }
  if (!trunk?.commit) throw new Refused('LAND_TRUNK', 'landing needs the coordinator’s primary branch; return its checkout to the trunk');
  // Pin accepted policy after any recorded-landed repair, never before admission or from candidate files.
  config ??= policyAt(root, trunk.commit).config;
  if (!dryRun) requireParallelGateAdmission(root, config);
  board.quarantineEnabled = () => config.flakes?.quarantine === true;
  const environment = dryRun ? null : requireLandingHost(store.boardId(board), config);
  const testDefects = heldTestDefects(root, board, trunk);
  if (!dryRun && testDefects.length) throw new Refused('LAND_TEST_DEFECT', `this trunk is held by ${testDefects.map(defect => `#${defect.item} (${defect.test})`).join(', ')}; correct the committed test or ask an approver for an expiring waiver`);
  if ((!dryRun || due) && !adopt && !unfinished) {
    const deferred = cadenceDeferral(board, config, trunk.branch, say, due);
    if (deferred) return deferred;
  }
  const selected = candidates(board, root, trunk.commit, maximum);
  if (!dryRun) for (const item of selected.ready) requireOutsideOwner(board, item);
  checkLandingMessages(selected.ready, landingContext(root, trunk.commit, config, (item) => item.item_landing_commit));
  const stale = selected.blocked.find(item => item.code === 'STALE_VERDICT');
  if (!selected.ready.length && stale) throw staleVerdictRefusal({ item_id: stale.id }, stale);
  if (dryRun) {
    if (selected.ready.length && !landsOnTrunk(config)) requirePushTarget(root, trunk.branch);
    const conflicts = [];
    for (const item of selected.ready) {
      const files = mechanicalConflictFiles(root, trunk.commit, item.item_landing_commit);
      if (files === null) throw new Refused('LAND_MERGE', 'Git could not preview the landing; restore its objects and retry the dry run');
      if (files.length) conflicts.push({ id: item.item_id, files });
    }
    return { batch: null, landed: [], conflicts, blocked: selected.blocked, culprits: [], flakes: [], items: selected.ready.map((item) => item.item_id) };
  }
  if (unfinished && !adopt && !['flaky', 'test-defect'].includes(unfinished.state)) throw new Refused('LAND_ADOPT', `batch ${unfinished.id} is ${unfinished.state}; inspect pullboard resume, then run pullboard land --adopt`);
  if (adopt && !unfinished) throw new Refused('LAND_ADOPT', 'there is no interrupted landing batch; run pullboard land');
  let batch = unfinished;
  if (batch?.state === 'flaky') {
    const held = (batch.flakes ?? []).filter((flake) => {
      const corrected = batch.base !== trunk.commit && testHash(root, flake.test) !== null && testHash(root, flake.test) !== flake.hash;
      const failures = (batch.failures ?? []).filter((failure) => failure.file === flake.test);
      return !corrected && (!failures.length || !failures.every((failure) => store.landingWaiverFor(board, failure)));
    });
    if (held.length) throw new Refused('LAND_FLAKE', `batch ${batch.id} is held by ${held.map((entry) => entry.test).join(', ')}; fix the test or ask the person for an expiring waiver; nothing retries`);
  }
  if (batch && batch.base !== trunk.commit && batch.state !== 'pushed') {
    await write('recordLandingBatch', [{ agentId: 'coordinator', batch: { ...batch, state: 'blocked', supersededByMain: trunk.commit }, revision: batch.revision }]);
    batch = null;
  }
  if (!batch && !selected.ready.length) return emptyLanding(selected, say);
  if (!batch) {
    if (!landsOnTrunk(config)) requirePushTarget(root, trunk.branch);
    const id = randomUUID();
    const directory = join(repoInfo(root).commonDir, 'pullboard', 'landings', id);
    batch = { version: 1, id, startedAt: new Date().toISOString(), base: trunk.commit, tip: trunk.commit, branch: trunk.branch, root: join(directory, 'worktree'),
      ...(environment ? { environment } : {}),
      candidates: selected.ready.map(landingEntry),
      items: selected.ready.map(landingEntry), conflicts: [], blocked: selected.blocked,
      state: 'merging', owner, logPath: join(directory, 'logs', 'batch.log'), revision: 0 };
    batch = await write('recordLandingBatch', [{ agentId: 'coordinator', batch }]);
    mkdirSync(directory, { recursive: true });
    git(root, ['worktree', 'add', '--detach', batch.root, batch.base]);
  }
  const state = { root, board, config, write, say, onWait, checkLease, checkLeaseNow, fence, batch, culprits: batch.culprits ?? [], flaky: false, gates: new Map((batch.gateResults ?? []).map((result) => [result.tree, result])), diagnosed: new Map((batch.diagnostics ?? []).map((result) => [result.test, result.isGreen])) };
  try {
    await save(state, { owner });
    await returnCulprits(state);
    if (state.batch.state === 'trunk') await finishTrunk(state);
    else if (state.batch.state === 'pushed' || state.batch.state === 'ready') await publish(state);
    else {
      const initialItems = (state.batch.candidates ?? state.batch.items)
        .filter((entry) => !state.culprits.some((culprit) => culprit.id === entry.id && culprit.commit === entry.commit));
      if (!existsSync(state.batch.root)) throw new Refused('LAND_WORKTREE', `the recorded landing worktree is missing at ${state.batch.root}; restore it before adopting`);
      if (state.config.landing?.parallel === true) {
        await parallelLanding(state, initialItems);
        await returnMergeConflicts(state);
        return { batch: state.batch, landed: state.batch.state === 'landed' ? state.batch.items.map(entry => entry.id) : [],
          conflicts: state.batch.conflicts ?? [], blocked: state.batch.blocked ?? [], culprits: state.culprits, flakes: state.batch.flakes ?? [] };
      }
      const build = await mergeGroup(state, initialItems);
      await save(state, { ...build, conflicts: [...state.batch.conflicts, ...build.conflicts] });
      for (const entry of state.batch.blocked ?? []) say(entry.code === 'LAND_FILE_OVERLAP'
        ? `#${entry.id} waits on overlapping files ${entry.files.join(', ')}; once this batch lands, its reviewer must merge current main and re-accept it without reopening`
        : `${entry.code} #${entry.id}${entry.stacked ? ` carries #${entry.stacked}` : ''}`);
      if (!build.items.length) await save(state, { state: 'blocked' });
      else if (landsOnTrunk(state.config)) await landOnTrunk(state);
      else if (!await inlineDeferredGuards(state)) await save(state, { state: 'blocked' });
      else {
        let gate = await gateGroup(state, 'batch');
        let proof = gate.isGreen ? null : waivedProof(state, gate);
        if (!gate.isGreen && !proof) {
          const flakyFiles = await diagnose(state, gate.failures, gate);
          if (flakyFiles.length) { await fileFlakes(state, gate, flakyFiles); state.flaky = true; }
          else {
            const green = await bisect(state, build.items, gate.failures);
            if (!state.flaky && green.length) {
              const rebuilt = await mergeGroup(state, green);
              await save(state, { ...rebuilt, culprits: state.culprits });
              // The smaller final tree lost the removed items' changes, so the kept items' deferred files run again on it.
              if (!await inlineDeferredGuards(state)) {
                await save(state, { state: 'blocked', culprits: state.culprits });
                gate = null;
              } else {
                gate = await gateGroup(state, 'green-items');
                proof = gate.isGreen ? null : waivedProof(state, gate);
                if (!gate.isGreen && !proof) {
                  if (!state.culprits.length) { await fileTestDefects(state, gate); state.flaky = true; }
                  else {
                    await save(state, { state: 'blocked', failures: gate.failures, culprits: state.culprits });
                    throw new Refused('LAND_INTERACTION', 'the individually green items fail together; nothing retries or lands; inspect the batch’s failing tests');
                  }
                }
              }
            } else if (!state.flaky) await save(state, { state: 'blocked', culprits: state.culprits });
          }
        }
        if (!state.flaky && gate && (gate.isGreen || proof)) {
          await save(state, { state: 'ready', proof: proof ?? { tree: gate.tree, failures: [], logPath: gate.logPath }, culprits: state.culprits });
          await publish(state);
        }
      }
    }
  } catch (error) {
    if (!(error instanceof Refused) || error.code !== 'LAND_GATE_TIMEOUT') throw error;
    say(error.message);
  }
  await returnMergeConflicts(state);
  return { batch: state.batch, landed: state.batch.state === 'landed' ? state.batch.items.map((entry) => entry.id) : [],
    conflicts: state.batch.conflicts ?? [], blocked: state.batch.blocked ?? [], culprits: state.culprits, flakes: state.batch.flakes ?? [] };
}
