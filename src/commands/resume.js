import { foreignBlockers } from '../cross-repo-dependencies.js';
import { localDependencyIds } from '../item-dependencies.js';
/** The pullboard resume command, in its own module so an item adding another command never edits these lines. */
import {
  keepViewRunning,
} from '../background-view.js';
import {
  staleFrozenItems,
  staleItemFinding,
} from '../approved-rows.js';
import {
  backgroundViewLine,
} from '../background-view.js';
import * as store from '../board.js';
import { requireBoardWriteAccess } from '../board-access.js';
import {
  briefFiles,
} from '../brief.js';
import {
  COORDINATOR,
  loadConfig,
} from '../config.js';
import {
  resumeDoctrineNotes,
  staleDoctrineRows,
} from '../doctrine-rulings.js';
import {
  repoInfo,
} from '../git.js';
import {
  recordedHealthFindings,
} from '../health-sentinel.js';
import {
  unwiredHookProblems,
} from '../hooks.js';
import {
  takeDecisionNotices,
} from '../implies.js';
import {
  resumeNeeds,
} from '../resume-needs.js';
import {
  personNeeds,
} from '../needs.js';
import {
  Refused,
} from '../refused.js';
import {
  unlinkedRelayProjects,
} from '../relay-setup.js';
import {
  commitFirst,
  commitOwnerLines,
  commitOwners,
  coordinatorInbox,
  coordinatorInboxLines,
  inboxFirst,
} from '../resume.js';
import {
  resumeSentinels,
} from '../sentinel-command.js';
import {
  withStarterWork,
} from '../setup-rows.js';
import {
  loadSpec,
} from '../spec.js';
import { initialSpecApprovalBaseline } from '../spec-approval-bootstrap.js';
import { readResumeSources } from '../resume-sources.js';
import {
  flowAlertLine,
} from '../stats-flow.js';
import {
  proofStats,
} from '../stats.js';
import {
  mainMergeLines,
  mainMergesFor,
} from '../trunk-conflict.js';
import {
  staleVerdictRefusal,
  verdictProjector,
} from '../verdict-freshness.js';
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
  withBoardRead,
  worktreeLocation,
} from '../cli.js';

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
  const initialBaseline = withBoardRead(ctx, board => {
    whoAmI(ctx, board);
    requireBoardWriteAccess(ctx.file);
    return initialSpecApprovalBaseline(ctx, board, 'recordHealthFindings');
  });
  if (initialBaseline) {
    const baselineIo = ctx.io.personRequest || ctx.io.personRequestMoveId
      ? { ...ctx.io, personRequest: undefined, personRequestMoveId: undefined } : ctx.io;
    await withBoard(ctx, board => ordered({ ...ctx, io: baselineIo }, board, 'recordSpecApprovalBaseline', [{
      agentId: COORDINATOR, baseline: initialBaseline,
    }]));
  }
  resumeSentinels({ ctx, withBoard: withBoardRead });
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
    sources = await readResumeSources(ctx, board, { compareBranch: !json, includeHeadDoctrine: diagnostics });
    setupDecisions = diagnostics ? store.rowDecisions(board) : undefined;
    doctrine = sources.doctrine;
    if (diagnostics) {
      mainRoot = sources.primary;
      // v1 placement follows actual working configuration, independently of committed doctrine authority.
      worktreeConfig = mainRoot ? (isMain ? ctx.config : loadConfig(mainRoot)) : null;
    }
    const me = whoAmI(ctx, board);
    const projector = diagnostics ? verdictProjector(root, board) : null;
    const all = store.listItems(board, { all: true }).map(item => projector ? projector.project(item) : item);
    foreignBlocked = new Set(all.filter(item => foreignBlockers(board, item).length).map(item => item.item_id));
    const pendingMerges = all.filter((item) => item.item_status === 'verified' && !item.item_merged_commit)
      .map(item => ({ ...item, item_checked_commit: store.checkedLandingCommit(board, item) }));
    const toMerge = pendingMerges.filter(item => !item.item_verdict_state);
    const staleVerdicts = pendingMerges.filter(item => item.item_verdict_state);
    const decisionSections = isMain ? coordinatorDecisionSections(board, ctx) : null;
    const { shouts = [], ...decisions } = decisionSections ?? {};
    const needsState = resumeNeeds(root, { board, config: ctx.config, includeRigorUndrafted: me.id === COORDINATOR });
    let proofStatsFallback;
    const flow = decisionSections ? proofStats(board, { now: ctx.clock.now().getTime(),
      /** Keep the cold-path notice in text and JSON without changing the statistics object. */
      onFallback: () => {
        proofStatsFallback = 'Proof statistics: counters are unavailable; reading the complete event history for this resume. The next writable command will build the counters.';
      },
    }).flow : null;
    return {
      me,
      health: recordedHealthFindings(board),
      all,
      needsYou: personNeeds(needsState),
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
      ...(isMain ? { landingBatches: store.landingBatches(board) } : {}),
      open: all.filter((item) => item.item_status === 'open'),
      hold: store.laneHold(board, me.lane),
      holds: store.laneHolds(board),
      unread: store.unreadCount(board, me.id),
      newest: store.peekShouts(board, me.id, 1),
      ...(me.id === COORDINATOR ? { inbox: coordinatorInbox(board, me.id, decisions.openDecisions ?? store.openDecisions(board, COORDINATOR)) } : {}),
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
    card.setup = withBoardRead(ctx, board => withStarterWork(boardSetup(ctx, card, setupScope, { decisions: setupDecisions }), { board, me, main: isMain, config: ctx.config, root, seat: ctx.io.callerRole() === 'seat' }));
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
    const against = mainRef ? `${ahead} ahead of main, ${behind} behind${behind ? ' (merge main before you submit)' : ''}` : 'main is detached for a verification, so ahead and behind are unknown';
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
  for (const item of card.staleVerdicts ?? []) say(staleVerdictRefusal(item, item.item_verdict_state).message);
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
    }
    section(card.needsYou, (need) => need.kind === 'decision'
      ? `waiting on the person: #${need.id} from ${need.ref} (${span(ctx, need.at)}): ${firstLine(need.text)}`
      : `needs the person: ${need.ref}: ${firstLine(need.text)} (${need.what})`);
    if (card.rigor?.notice) say(card.rigor.notice);
    section(card.rigor?.undrafted ?? [], (cause) => `Rigor needs a proved draft: ${cause.key}, items ${cause.items.map(item => `#${item.id}`).join(', ')}; pullboard rigor draft "${cause.key.replaceAll('"', '\\"')}" "<rule>" --check "<command>" --red <commit> --green <commit>`);
    if (card.toVerify.length) say('review queue:');
    section(card.toVerify, (item) => `  to verify: #${item.item_id} ${item.item_lane} (${span(ctx, item.item_updated_at)})`);
    if (diagnostics && card.toMerge.length) say('merge verified work, run the gate, then record each with pullboard merged <id> <commit>');
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
  }
  else if (card.holding.length) next = buildNext(card);
  else if (card.sentBack.length) next = `pullboard next; ${reworkNext(card)}`;
  else if (card.hold) next = 'pullboard next --wait 9 (minutes); the lane hold must lift before its work is available';
  else if (ready) next = `pullboard next (${ready} ready in your lane)`;
  else if (inLane.length) next = `pullboard next --wait 9 (minutes); ${inLane.length} in your lane ${inLane.length === 1 ? 'waits' : 'wait'} on other work`;
  else if (card.awaiting.length) next = 'pullboard next --wait 9 (minutes); a rejected item comes back to your lane';
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

/** Run `pullboard resume` and return its exit code. */
export async function run(io, { values }) {
  repoInfo(io.cwd);
  // JSON v1 retains its real diagnostic fields; only the default text card defers them.
  return resumeHere(io, await keepViewRunning(), Boolean(values.diagnostics || values.json), { json: Boolean(values.json) });
}
