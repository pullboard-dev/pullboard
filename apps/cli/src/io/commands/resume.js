import { trunkRef } from '../../../../../packages/sandbox/index.js';
import { agentDoctrine } from '../../../../../packages/doctrine/index.js';
import { appliedDoctrine } from '../../../../../packages/doctrine/index.js';
import { doctrineFromSource } from '../../../../../packages/doctrine/index.js';
import { loadDoctrine } from '../../../../../packages/doctrine/index.js';
import { primaryCheckoutRoot } from '../entry.js';
import { relayRecovered } from '../../../../../packages/link/index.js';
import { proposeLanes } from '../init.js';
import { counterProofStats } from '../../../../../packages/verify/index.js';
import { localDependencyIds } from '../../../../../packages/items/index.js';
import { automaticLandingEnabled } from '../../../../../packages/merge/index.js';
import { mainPolicy } from '../../../../../packages/sandbox/index.js';
import { adoptOrphanedClaim } from '../resume/adopt.js';
import { landingWaits } from '../landing/waiting.js';
import { landingWaitLine } from '../landing/waiting.js';
/** The pullboard resume command, in its own module so an item adding another command never edits these lines. */
import {
  keepViewRunning,
} from '../../../../view/index.js';
import { withBoardRead } from '../board/read.js';
import {
  staleFrozenItems,
  staleItemFinding,
} from '../../../../../packages/spec/index.js';
import {
  backgroundViewLine,
} from '../../../../view/index.js';
import * as store from '../../../../../packages/store/index.js';
import { requireBoardWriteAccess } from '../../../../../packages/store/index.js';
import {
  briefFiles,
} from '../../../../../packages/items/index.js';
import {
  COORDINATOR,
  hunkFreshnessEnabled,
  loadConfig,
  submitComposeAsObject,
} from '../../../../../packages/config/index.js';
import {
  resumeDoctrineNotes,
  staleDoctrineRows,
} from '../../../../../packages/doctrine/index.js';
import {
  repoInfo,
} from '../../../../../packages/git/index.js';
import {
  recordedHealthFindings,
} from '../../../../../packages/sentinels/index.js';
import {
  unwiredHookProblems,
} from '../../../../../packages/commits/index.js';
import {
  takeDecisionNotices,
} from '../../../../../packages/state/index.js';
import {
  resumeNeeds,
} from '../../../../view/index.js';
import { personNeeds } from '../../../../../packages/spec/index.js';
import {
  Refused,
} from '../../../../../packages/kernel/index.js';
import {
  unlinkedRelayProjects,
} from '../../../../../packages/link/index.js';
import {
  commitFirst,
  commitOwnerLines,
  commitOwners,
  coordinatorInbox,
  coordinatorInboxLines,
  inboxFirst,
} from '../../../../../packages/items/index.js';
import {
  resumeSentinels,
} from '../../../../../packages/sentinels/index.js';
import {
  withStarterWork,
} from '../../../../../packages/spec/index.js';
import {
  loadSpec,
} from '../../../../../packages/spec/index.js';
import { initialSpecApprovalBaseline } from '../../../../../packages/spec/index.js';
import { readResumeSources } from '../../../../../packages/items/index.js';
import {
  flowAlertLine,
} from '../../../../../packages/stats/index.js';
import {
  proofStats,
} from '../../../../../packages/stats/index.js';
import {
  mainMergeLines,
  mainMergesFor,
} from '../../../../../packages/merge/index.js';
import {
  staleVerdictRefusal,
  verdictProjector,
} from '../../../../../packages/verify/index.js';
import {
  agentDisplayName,
  boardSetup,
  buildNext,
  context,
  coordinatorDecisionSections,
  coordinatorNext,
  dirtyFiles,
  firstLine,
  ordered as sendOrdered,
  resumeReleaseNotes,
  reworkNext,
  setupIdentity,
  span,
  unavailableWorktreeLocation,
  uncommittedSetup,
  verifiedMergeGroups,
  viewSetupComplete,
  whoAmI,
  withBoard,
  worktreeLocation,
} from '../entry.js';

/**
 * Resume's one compatibility move (the approval baseline) is bookkeeping: a session that cannot
 * reach the board key (SSH, a scheduled job, a locked keychain) still reads the whole card, and the moves wait for a
 * session that can. Every read works without the key [E9].
 *
 * @param {typeof sendOrdered} send
 * @returns {typeof sendOrdered}
 */
function keylessBookkeeping(send) {
  let noted = false;
  return async (ctx, board, operation, args) => {
    try { return await send(ctx, board, operation, args); }
    catch (error) {
      if (!(error instanceof Refused) || error.code !== 'RELAY_KEY_MISSING') throw error;
      if (!noted) ctx.io.err?.('pullboard: the board key is not reachable in this session, so resume reads the local board and leaves its bookkeeping moves to a session that holds the key');
      noted = true;
      return null;
    }
  };
}

/**
 * Whether main's committed policy lands accepted work automatically; a project with no commit on main yet has none.
 *
 * A fresh `pullboard init` is uncommitted, and resume --diagnostics must still print the setup card that leads to the first commit [I1,C7].
 *
 * @param {string} root The primary checkout.
 * @returns {boolean} true only when committed policy enables automatic landing.
 */
function landingIsAutomatic(root) {
  try { return automaticLandingEnabled(mainPolicy(root).config); }
  catch (error) { if (error?.code === 'NO_POLICY') return false; throw error; }
}

/**
 * `pullboard resume` (N19): one short card that puts an agent back to work after a fresh start,
 * a restart or a compaction, from the board rather than from a summary.
 *
 * @param {any} io
 * @param {Awaited<ReturnType<typeof keepViewRunning>>} view what keeping the background view running did
 * @param {boolean} diagnostics include explicit setup, hook and stale-work inspection
 * @param {{ json?: boolean }} options omit text-only calculations when the versioned result owns the output
 * @returns {number}
 */
export async function resumeHere(io, view, diagnostics = false, { json = false } = {}) {
  const ctx = context(io);
  const ordered = keylessBookkeeping(sendOrdered);
  const initialBaseline = await withBoardRead(ctx, board => {
    whoAmI(ctx, board);
    requireBoardWriteAccess(ctx.file);
    return initialSpecApprovalBaseline(ctx, board, 'recordHealthFindings', { relayRecovered: (root, options) => relayRecovered(root, options, ctx.io), specApprovalBaselineExists: store.specApprovalBaselineExists });
  });
  if (initialBaseline) {
    const baselineIo = ctx.io.personRequest || ctx.io.personRequestMoveId
      ? { ...ctx.io, personRequest: undefined, personRequestMoveId: undefined } : ctx.io;
    await withBoard(ctx, board => ordered({ ...ctx, io: baselineIo }, board, 'recordSpecApprovalBaseline', [{
      agentId: COORDINATOR, baseline: initialBaseline,
    }]));
  }
  resumeSentinels({ ctx, withBoard: withBoardRead });
  await adoptOrphanedClaim(io, ctx);
  const { root, isMain } = ctx.info;
  let mainRoot = null;
  let worktreeConfig = null;
  let setupScope;
  let setupDecisions;
  let doctrine;
  let sources;
  let foreignBlocked;
  const card = await withBoardRead(ctx, async (board) => {
    setupScope = diagnostics ? setupIdentity(board) : null;
    sources = await readResumeSources(ctx, board, { agentDoctrine, appliedDoctrine, doctrineFromSource, loadDoctrine, primaryCheckoutRoot, rowDecisions: store.rowDecisions }, { compareBranch: !json, includeHeadDoctrine: diagnostics });
    setupDecisions = diagnostics ? store.rowDecisions(board) : undefined;
    doctrine = sources.doctrine;
    if (diagnostics) {
      mainRoot = sources.primary;
      // v1 placement follows actual working configuration, independently of committed doctrine authority.
      worktreeConfig = mainRoot ? (isMain ? ctx.config : loadConfig(mainRoot)) : null;
    }
    const me = whoAmI(ctx, board);
    const projector = diagnostics ? verdictProjector(root, board, {}, { events: store.events, acceptedVerdict: store.acceptedVerdict, verdictReviewProblem: store.verdictReviewProblem, trunkRef, hunkKeyed: hunkFreshnessEnabled() }) : null;
    const all = store.listItems(board, { all: true }).map(item => projector ? projector.project(item) : item);
    foreignBlocked = new Set(all.filter(item => store.foreignBlockers(board, item).length).map(item => item.item_id));
    const pendingMerges = all.filter((item) => item.item_status === 'verified' && !item.item_merged_commit)
      .map(item => ({ ...item, item_checked_commit: store.checkedLandingCommit(board, item) }));
    const toMerge = pendingMerges.filter(item => !item.item_verdict_state);
    const staleVerdicts = pendingMerges.filter(item => item.item_verdict_state);
    const decisionSections = isMain ? coordinatorDecisionSections(board, ctx) : null;
    const { shouts = [], ...decisions } = decisionSections ?? {};
    // Only the main checkout's text card and the JSON result carry the person's needs; a seat's text card skips the
    // spec blame and board reads they cost, which is what lets SessionStart finish inside its 2 s timeout [I6].
    const needsState = isMain || json || me.id === COORDINATOR ? resumeNeeds(root, { board, config: ctx.config, includeRigorUndrafted: me.id === COORDINATOR }) : null;
    let proofStatsFallback;
    const flow = decisionSections ? proofStats(board, { now: ctx.clock.now().getTime(),
      /** Keep the cold-path notice in text and JSON without changing the statistics object. */
      onFallback: () => {
        proofStatsFallback = 'Proof statistics: counters are unavailable; reading the complete event history for this resume. The next writable command will build the counters.';
      },
    }, { events: store.events, counterProofStats }).flow : null;
    return {
      me,
      health: recordedHealthFindings(board),
      all,
      needsYou: needsState ? personNeeds(needsState) : [],
      ...(me.id === COORDINATOR ? { rigor: { undrafted: needsState.rigorUndrafted, ...(needsState.rigorNotice ? { notice: needsState.rigorNotice } : {}) } } : {}),
      ...(decisionSections ? { ...decisions, ...(diagnostics ? verifiedMergeGroups(root, pendingMerges, shouts, ctx.clock.now().getTime()) : {}),
        flow, ...(proofStatsFallback ? { proofStatsFallback } : {}) } : {}),
      requests: me.id === COORDINATOR ? store.openRequests(board) : [],
      holding: all.filter((item) => item.item_status === 'claimed' && item.item_owner === me.id),
      held: all.filter((item) => item.item_status === 'claimed' && item.item_owner === me.id)
        .map((item) => ({ item: item.item_id, facts: store.itemThread(board, item.item_id) })),
      sentBack: all
        .filter((item) => item.item_status === 'open' && item.item_verdict === 'REJECT' && item.item_built_by === me.id)
        .map((item) => ({ item, verdict: store.verdictsFor(board, item.item_id).at(-1) })),
      mainMerges: mainMergesFor(board, all.filter((item) => item.item_status === 'open' && item.item_built_by === me.id)),
      awaiting: all.filter((item) => item.item_status === 'submitted' && item.item_built_by === me.id),
      toVerify: all.filter((item) => item.item_status === 'submitted' && item.item_built_by !== me.id),
      ...(diagnostics ? { toMerge, staleVerdicts } : { acceptedAwaitingLanding: pendingMerges }),
      // While the board lands accepted work, diagnostics name where each accepted item waits: its land job, a hold, or none (#7948).
      ...(isMain && diagnostics && landingIsAutomatic(root) ? { landingWaits: landingWaits(board.db, pendingMerges, ctx.clock.now().getTime()) } : {}),
      ...(isMain ? { landingBatches: store.landingBatches(board) } : {}),
      open: all.filter((item) => item.item_status === 'open'),
      hold: store.laneHold(board, me.lane),
      holds: store.laneHolds(board),
      unread: store.unreadCount(board, me.id),
      newest: store.peekShouts(board, me.id, 1),
      ...(me.id === COORDINATOR ? { inbox: coordinatorInbox(board, me.id, decisions.openDecisions ?? store.openDecisions(board, COORDINATOR), { unreadCount: store.unreadCount, peekShouts: store.peekShouts }) } : {}),
      agents: store.listAgents(board),
      ...(diagnostics ? { viewOpened: viewSetupComplete(ctx, board) } : {}),
    };
  });
  card.relayProblems = unlinkedRelayProjects();
  if (diagnostics) {
    card.hookProblems = unwiredHookProblems(root);
    card.newWorktreeLocation = mainRoot
      ? worktreeLocation(mainRoot, worktreeConfig)
      : unavailableWorktreeLocation();
  }
  const { me } = card;
  // The coordinator's allowance line: a Codex session's rate limits, or unknown without one; stats loads only on this branch [C7,#1058].
  if (me.id === COORDINATOR) {
    const { allowanceWarning, seatAllowance, sessionSource } = await import('../../../../../packages/stats/index.js');
    const source = sessionSource();
    const line = allowanceWarning(source?.provider === 'codex' ? seatAllowance(source.file) : { known: false }, me.id);
    if (line) card.allowance = line;
  }
  const name = (id) => agentDisplayName(card.agents, ctx.config, id);
  if (diagnostics) card.stale = staleFrozenItems(card.all, loadSpec(root, ctx.config).rows, staleDoctrineRows(ctx, doctrine, { headDoctrine: sources.headDoctrine })).map((item) => ({ ...item, ...staleItemFinding(item) }));
  if (isMain && diagnostics) {
    card.staleFollowUps = { count: card.stale.length + card.staleIntegrations.length,
      list: 'pullboard resume --diagnostics --json', items: card.stale, integrations: card.staleIntegrations };
    delete card.staleIntegrations;
    card.reviewQueue = { items: card.toVerify, awaiting: card.awaiting };
  }
  const say = (line) => io.say(line);
  card.doctrineNotes = resumeDoctrineNotes(ctx.info, doctrine);
  for (const row of card.doctrineNotes) say(`new doctrine ${row.id} — ${row.text}`);
  const releaseNotes = card.whatsNew = resumeReleaseNotes(ctx.info);
  for (const note of (releaseNotes?.releases ?? [])) {
    say(`new in ${note.version} — ${note.headline}: ${note.paragraph}`);
  }
  if (releaseNotes?.omitted) say(`${releaseNotes.omitted} earlier release${releaseNotes.omitted === 1 ? '' : 's'} omitted; see the full notes in CHANGELOG.md`);
  else if (releaseNotes?.releases.length) say('Full release notes: CHANGELOG.md');
  for (const problem of card.relayProblems) say(problem.message);
  for (const problem of card.hookProblems ?? []) say(`${problem.message}; ${problem.next}`);
  const plural = (n, word) => `${n} ${word}${n === 1 ? '' : 's'}`;
  say(`resume: ${me.displayName}${me.family ? ` [family ${me.family}]` : ''}, ${me.lane} lane${isMain ? ', the main checkout' : ''}, at ${root}`);
  if (card.inbox) for (const line of coordinatorInboxLines(card.inbox, name, (at) => span(ctx, at), firstLine)) say(line);
  if (card.proofStatsFallback) say(card.proofStatsFallback);
  if (card.health.recordedAt) {
    say(`Health recorded ${card.health.recordedAt}: ${card.health.findings.length} finding${card.health.findings.length === 1 ? '' : 's'}; refresh with pullboard sentinel run.`);
    for (const finding of card.health.findings) say(`  ${finding.subject}: ${finding.why}; next: ${finding.next}`);
  } else say('No health findings have been recorded; schedule pullboard sentinel run to refresh them.');
  card.view = view;
  // A view left running needs no line at every session start; a start, a busy port or a failure does.
  if (view.state !== 'running' && backgroundViewLine(view)) say(backgroundViewLine(view));
  if (diagnostics) {
    say(`New agent worktrees: ${card.newWorktreeLocation}`);
    card.setup = await withBoardRead(ctx, board => withStarterWork(boardSetup(ctx, card, setupScope, { decisions: setupDecisions }), { board, me, main: isMain, config: ctx.config, root, seat: ctx.io.callerRole() === 'seat', nextFor: store.nextFor, proposeLanes }));
  } else say('Setup, hook and stale-work diagnostics: pullboard resume --diagnostics.');
  if (!loadSpec(root, ctx.config).rows.length && card.all.length) say('Spec rows are optional; add a requirement later: pullboard spec draft "<text>".');
  if (card.setup) {
    say(`Setting up: step ${card.setup.step} of 5`);
    say(card.setup.question);
    say(card.setup.personCommand ? `For the person: ${card.setup.personCommand}` : card.setup.waitingOn === 'coordinator-apply' ? `Next: ${card.setup.agentNext}` : `Record the answer: ${card.setup.command}`);
    if (card.setup.afterAnswer) say(card.setup.afterAnswer);
    if (card.setup.meanwhile) say(card.setup.meanwhile);
  }
  const dirty = diagnostics || !json ? dirtyFiles(root).length : undefined;
  if (!isMain && !json) {
    const { branch, mainRef, behind = 0, ahead = 0 } = sources;
    // Fresh command facts compare the actual primary branch, not an unrelated detached review HEAD.
    const against = mainRef ? `${ahead} ahead of main, ${behind} behind` : 'main is detached for a verification, so ahead and behind are unknown';
    say(`branch ${branch}: ${against}${dirty ? `; ${plural(dirty, 'file')} uncommitted` : ''}`);
  } else if (dirty) {
    say(`${plural(dirty, 'file')} uncommitted in the main checkout`);
  }
  if (isMain && diagnostics) {
    card.commits = commitOwners(uncommittedSetup(root, ctx.config)?.differ ?? [], [ctx.config.spec, ctx.config.practice], root);
    for (const line of commitOwnerLines(card.commits)) say(line);
  }
  for (const request of card.requests) say(`request #${request.shout_id}: ${request.shout_text}; answer with pullboard answer ${request.shout_id} done, or declined <reason>`);
  card.decisions = takeDecisionNotices(ctx.info.gitDir, card.held);
  delete card.held;
  for (const notice of card.decisions) say(`decision for #${notice.item} ${notice.text}`);
  for (const item of card.holding) {
    say(`holding #${item.item_id} ${item.item_title}, lease ${span(ctx, item.item_lease_until)} left${item.item_check ? `; check: ${item.item_check}` : ''}`);
    const files = briefFiles(item.item_brief);
    if (files.length) say(`  files: ${files.join(', ')}`);
  }
  for (const { item, verdict } of card.sentBack) {
    say(`sent back: #${item.item_id} ${verdict ? `${verdict.verdict_reason} by ${name(verdict.verdict_by)}: ${firstLine(verdict.verdict_note)}` : 'rejected'}`);
  }
  for (const { item, merge } of card.mainMerges) say(mainMergeLines(item, merge, name).join('; '));
  if (isMain && diagnostics && card.staleFollowUps.count) say(`${plural(card.staleFollowUps.count, 'stale follow-up')}; list them with ${card.staleFollowUps.list}`);
  else if (!isMain && diagnostics) for (const item of card.stale) say(`stale: ${item.message}; next: ${item.next}`);
  for (const item of card.staleVerdicts ?? []) say(staleVerdictRefusal(item, item.item_verdict_state, { composeAsObject: submitComposeAsObject() }).message);
  if (card.awaiting.length) say(`awaiting a verdict: ${card.awaiting.map((item) => `#${item.item_id} (${span(ctx, item.item_updated_at)})`).join(', ')}`);
  if (isMain) {
    for (const batch of card.landingBatches.filter((entry) => !['landed', 'blocked'].includes(entry.state))) say(`landing ${batch.id}: ${batch.state}, owner ${batch.owner}, tip ${batch.tip}; log ${batch.logPath}; next: pullboard land --adopt`);
    /** Limit each text section; JSON keeps every record for a complete handoff. */
    const section = (entries, line) => {
      for (const entry of entries.slice(0, 3)) say(line(entry));
      if (entries.length > 3) say(`  ${entries.length - 3} more; list them with pullboard resume --json`);
    };
    section(card.openDecisions, (ask) => `open decision #${ask.id} from ${name(ask.asker)} (${ask.age}): ${firstLine(ask.question)}`);
    section(card.recentAnswers, (answer) => `recent decision #${answer.id}: ${name(answer.answeredBy)} answered ${name(answer.asker)} (${answer.age} ago): ${firstLine(answer.answer)}`);
    if (diagnostics && (card.toMerge.length || card.staleVerdicts.length)) {
      const groups = card.verifiedNotMerged;
      // Conflicts remain useful diagnostics even when the acceptance must be re-reviewed.
      const freshness = item => item.item_verdict_state ? ' [STALE_VERDICT]' : '';
      /** Keep merge groups on one line while retaining all entries in JSON. */
      const listed = (entries, line) => entries.slice(0, 3).map(line).join(', ')
        + (entries.length > 3 ? `, +${entries.length - 3} more (pullboard resume --diagnostics --json)` : '') || 'none';
      say(`verified, not merged — merges cleanly: ${listed(groups.clean, (item) => `#${item.item_id} ${firstLine(item.item_title)}${freshness(item)}`)}`);
      say(`verified, not merged — conflicts: ${listed(groups.conflicts, ({ item, files }) => `#${item.item_id} ${firstLine(item.item_title)} (${files.join(', ') || 'files unavailable'})${freshness(item)}`)}`);
      say(`verified, not merged — claimed for integration: ${listed(groups.integrating, ({ item, by, at, commit }) => `#${item.item_id} by ${name(by)} at ${at} (${commit.slice(0, 12)})${freshness(item)}`)}`);
      for (const wait of card.landingWaits ?? []) say(`landing: ${landingWaitLine(wait)}`);
    }
    section(card.needsYou, (need) => need.kind === 'decision'
      ? `waiting on the person: #${need.id} from ${need.ref} (${span(ctx, need.at)}): ${firstLine(need.text)}`
      : `needs the person: ${need.ref}: ${firstLine(need.text)} (${need.what})`);
    if (card.rigor?.notice) say(card.rigor.notice);
    if (card.allowance) say(card.allowance);
    section(card.rigor?.undrafted ?? [], (cause) => `Rigor needs a proved draft: ${cause.key}, items ${cause.items.map(item => `#${item.id}`).join(', ')}; pullboard rigor draft "${cause.key.replaceAll('"', '\\"')}" "<rule>" --check "<command>" --red <commit> --green <commit>`);
    if (card.toVerify.length) say('review queue:');
    section(card.toVerify, (item) => `  to verify: #${item.item_id} ${item.item_lane} (${span(ctx, item.item_updated_at)})`);
    if (diagnostics && card.toMerge.length && !card.landingWaits) say('merge verified work, run the gate, then record each with pullboard merged <id> <commit>');
    if (!diagnostics && card.acceptedAwaitingLanding.length) say(`Last accepted receipts awaiting landing checks: ${card.acceptedAwaitingLanding.map(item => `#${item.item_id}`).join(', ')}; pullboard land checks their current verdicts.`);
    for (const hold of card.holds) say(`held: the ${hold.hold_lane} lane, ${hold.hold_reason}`);
    const byLane = Object.entries(Map.groupBy(card.open, (item) => item.item_lane)).map(([lane, items]) => `${lane} ${items.length}`);
    say(`open: ${card.open.length}${byLane.length ? ` (${byLane.join(', ')})` : ''}`);
  } else if (card.hold) {
    say(`the ${me.lane} lane is held by ${name(card.hold.hold_by)}: ${card.hold.hold_reason}`);
  }
  if (card.unread && !card.inbox) say(`${plural(card.unread, 'unread shout')}; newest from ${name(card.newest[0].shout_from)}: ${firstLine(card.newest[0].shout_text)} (pullboard inbox reads them)`);
  const inLane = card.open.filter((item) => item.item_lane === me.lane);
  const isVerified = (id) => card.all.find((other) => other.item_id === Number(id))?.item_status === 'verified';
  const ready = inLane.filter((item) => !foreignBlocked.has(item.item_id) && localDependencyIds(item).every(isVerified)).length;
  let next;
  if (isMain) {
    next = coordinatorNext(diagnostics ? card : { ...card, toMerge: card.acceptedAwaitingLanding, staleVerdicts: [] }, loadSpec(root, ctx.config).rows);
    if (!diagnostics && next.startsWith('merge #')) next = 'pullboard land (checks current verdicts before merging)';
    // The board lands accepted work: the next step is the land job an accepted item lacks, never a hand merge (#7948).
    if (card.landingWaits?.length && next.startsWith('merge #')) next = landingNext(card.landingWaits);
  }
  else if (card.holding.length) next = buildNext(card);
  else if (card.sentBack.length) next = `pullboard next; ${reworkNext(card)}`;
  else if (card.hold) next = 'pullboard next; take work in another lane, or end your turn if none is offered';
  else if (ready) next = `pullboard next (${ready} ready in your lane)`;
  else if (inLane.length) next = 'pullboard next; take another eligible review or other offered work, or end your turn if none is offered';
  else if (card.awaiting.length) next = 'pullboard next --verify; take another eligible review, or end your turn if none is offered';
  else next = 'pullboard next; take its ranked work, including eligible reviews or work in another lane';
  if (card.setup) next = card.setup.agentNext ?? card.setup.command;
  if (card.commits) next = commitFirst(card.commits, next);
  if (card.inbox) next = inboxFirst(card.inbox, next);
  io.result?.({ ...card, root, ...(diagnostics ? { dirty } : {}), next });
  say(`next: ${next}`);
  const flowAlert = isMain ? flowAlertLine(card.flow) : null;
  if (flowAlert) say(flowAlert);
  return 0;
}

/** The coordinator's next step while the board lands accepted work: offer a missing land job, lift a hold, or take other work. */
function landingNext(waits) {
  const none = waits.filter(wait => wait.state === 'none');
  if (none.length) return `pullboard land (offers the land job ${none.map(wait => `#${wait.id}`).join(' ')} never got)`;
  const held = waits.find(wait => wait.state === 'held');
  if (held) return `pullboard hold ${held.id} --off once #${held.id} merges cleanly (${held.reason})`;
  return `nothing by hand: a runner lands ${waits.map(wait => `#${wait.id}`).join(' ')} from land job ${waits[0].job}; pullboard next`;
}

/** Run `pullboard resume` and return its exit code. */
export async function run(io, { values }) {
  repoInfo(io.cwd);
  // JSON v1 retains its real diagnostic fields; only the default text card defers them.
  // MCP is a local stdio control channel; it never starts or probes a browser listener.
  const view = io.personChannel === 'mcp' ? { state: 'off' } : await keepViewRunning();
  return resumeHere(io, view, Boolean(values.diagnostics || values.json), { json: Boolean(values.json) });
}
