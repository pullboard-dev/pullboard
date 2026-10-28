import { landingWaiverFor as nativeLandingWaiverFor } from './landing-waivers.js';
/** Coordinator landing batch step; source-preserving partition of land.js [B3,R3,C7]. */
import { requirePublishGreen } from './publish-pause.js';
import { cadenceDeferral } from './landing-cadence.js';
import { requireOutsideOwner } from './outside-source.js';
import { mechanicalConflictFiles } from './mechanical-merge.js';
import { randomUUID } from 'node:crypto';
import { existsSync } from 'node:fs';
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import * as store from './board.js';
import { git } from './git.js';
import { isClean } from './git.js';
import { invalidateGitFacts } from './git.js';
import { mainCheckout } from './git.js';
import { repoInfo } from './git.js';
import { untracked } from './git.js';
import { takeLandingResource } from './landing-resource.js';
import { requireConfirmedLanding } from './board-landing-lease.js';
import { runLandingWorker } from './landing-worker.js';
import { inheritedGateSlot } from './resources.js';
import { Refused } from './refused.js';
import { checkLandingMessages } from './landing-message.js';
import { landingContext } from './landing-message.js';
import { requireLandingHost } from './landing-host.js';
import { policyAt } from './trusted-policy.js';
import { staleVerdictRefusal } from './verdict-freshness.js';
import { candidates } from './landing-step-selection.js';
import { idleLanding } from './landing-step-selection.js';
import { emptyLanding } from './landing-step-selection.js';
import { landingOperations } from './landing-step-merge.js';
import { testHash } from './landing-step-selection.js';
import { heldTestDefects } from './landing-step-selection.js';
import { landingEntry } from './landing-step-selection.js';
import { save } from './landing-step-merge.js';
import { mergeGroup } from './landing-step-merge.js';
import { gateGroup } from './landing-step-gate.js';
import { parallelLanding } from './landing-step-parallel.js';
import { diagnose } from './landing-step-diagnose.js';
import { waivedProof } from './landing-step-failures.js';
import { bisect } from './landing-step-diagnose.js';
import { returnCulprits } from './landing-step-diagnose.js';
import { returnMergeConflicts } from './landing-step-diagnose.js';
import { fileFlakes } from './landing-step-diagnose.js';
import { fileTestDefects } from './landing-step-diagnose.js';
import { requirePushTarget } from './landing-step-publish.js';
import { publish } from './landing-step-publish.js';
import { landsOnTrunk } from './landing-step-publish.js';
import { inlineDeferredGuards } from './landing-step-trunk.js';
import { landOnTrunk } from './landing-step-trunk.js';
import { finishTrunk } from './landing-step-publish.js';

/** Require a separate admitted slot for every speculative gate, without holding a parent gate open. */
function requireParallelGateAdmission(root, config) {
  if (config.landing?.parallel === true && inheritedGateSlot({ root, namedFiles: true })) {
    throw new Refused('LAND_PARALLEL_NESTED_GATE', 'parallel landing needs separately admitted gate slots; run pullboard land outside the current gate command');
  }
}

/** Build, gate, diagnose and durably land one coordinator batch; all external actions stay in its worktree. */
export async function land(options) {
  options = { ...options, landingPorts: landingOperations(options.landingPorts) };
  if (options.dryRun) return runLandingBatch(options);
  invalidateGitFacts();
  const trunk = mainCheckout(options.root);
  const branch = trunk?.branch;
  if (!branch) throw new Refused('LAND_TRUNK', 'landing needs the coordinator’s primary branch; return its checkout to the trunk');
  if (trunk.commit) {
    const policy = policyAt(options.root, trunk.commit).config;
    requireParallelGateAdmission(options.root, policy);
    requirePublishGreen(options.root, options.board, policy);
  }
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
    const selected = candidates(options.board, options.root, trunk.commit, options.maximum ?? Infinity, { firstReady: true, landingPorts: options.landingPorts });
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
      const values = ['recordTrainLanding', 'recordLandingBatch', 'finishLandingBatch'].includes(operation)
        ? [{ ...args[0], landingFence: lease.fence }, ...args.slice(1)] : args;
      return options.write(operation, values);
    };
    /** Relay catch-up can change proof or trunk facts while a renewal awaits its receipt. */
    const checkLease = async () => { await lease.assertHeld(); invalidateGitFacts(); };
    const batchOptions = { root: options.root, config: options.config, owner: options.owner, maximum: Number.isFinite(options.maximum) ? options.maximum : null,
      adopt: options.adopt, due: options.due, fence: lease.fence };
    if (batchOptions.maximum === null) delete batchOptions.maximum;
    return await runLandingWorker(batchOptions, { write, checkLease, checkLeaseNow: lease.assertCurrent,
      bindWorker: lease.bindWorker, watchDeadline: lease.watchDeadline, onWait: options.onWait, say: options.say, signal: controller.signal, workerFile: options.landingWorkerFile, parseProcessCensus: options.landingPorts.parseProcessCensus });
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
export async function runLandingBatch({ root, board, config, write, say, owner, maximum = Infinity, dryRun = false, adopt = false, due = false, onWait, checkLease, checkLeaseNow, fence, checkAtCommit, candidateWorkerFile, landingPorts }) {
  landingPorts = landingOperations(landingPorts);
  let trunk = mainCheckout(root);
  if (fence && trunk?.branch !== fence.branch) throw new Refused('LAND_LEASE_LOST', 'the trunk branch changed while landing waited; start a new land command for its current branch');
  if (!dryRun && trunk?.commit) requirePublishGreen(root, board, policyAt(root, trunk.commit).config);
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
  const testDefects = heldTestDefects(root, board, trunk, landingPorts);
  if (!dryRun && testDefects.length) throw new Refused('LAND_TEST_DEFECT', `this trunk is held by ${testDefects.map(defect => `#${defect.item} (${defect.test})`).join(', ')}; correct the committed test or ask an approver for an expiring waiver`);
  if ((!dryRun || due) && !adopt && !unfinished) {
    const deferred = cadenceDeferral(board, config, trunk.branch, say, due);
    if (deferred) return deferred;
  }
  const selected = candidates(board, root, trunk.commit, maximum, { landingPorts });
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
      return !corrected && (!failures.length || !failures.every((failure) => nativeLandingWaiverFor(board, failure, landingPorts)));
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
  const state = { root, board, config, write, say, onWait, checkLease, checkLeaseNow, fence, batch, checkAtCommit, candidateWorkerFile, landingPorts, culprits: batch.culprits ?? [], flaky: false, gates: new Map((batch.gateResults ?? []).map((result) => [result.tree, result])), diagnosed: new Map((batch.diagnostics ?? []).map((result) => [result.test, result.isGreen])) };
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
