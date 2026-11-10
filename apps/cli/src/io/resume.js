/** Helpers for `pullboard resume`: next steps, merge groups, decisions and release notes. Split from src/cli.js, which re-exports it [C7]. */
import { mkdirSync } from 'node:fs';
import { readFileSync } from 'node:fs';
import { writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { join } from 'node:path';
import * as store from '../../../../packages/store/index.js';
import { span } from './context.js';
import { COORDINATOR } from '../../../../packages/config/index.js';
import { contains } from '../../../../packages/git/index.js';
import { VERSION } from '../logic/help.js';
import { requireTrunkMerge } from '../../../../packages/sandbox/index.js';
import { staleVerdictRefusal } from '../../../../packages/verify/index.js';
import { releaseHeadlinesBetween } from '../../../../packages/config/index.js';

/** The next step for an agent holding a claim: build it and submit. */
export const buildNext = (card) => `build #${card.holding[0].item_id}, commit, then pullboard submit ${card.holding[0].item_id}`;

/** The next step for an agent whose work came back: rework it. */
export const reworkNext = (card) => `pullboard claim ${card.sentBack[0].item.item_id}, fix what the verifier found, and submit again`;

/**
 * The coordinator's next step, from the board and the spec (N32): the spec with the person first,
 * then its own work in hand, then verdicts, merges, builders and the plan, so an agent that runs the
 * team by the run guide knows where it is. A working board with no spec rows can keep building.
 *
 * @param {any} card
 * @param {{ id: string, status: string }[]} rows
 * @returns {string}
 */
export function coordinatorNext(card, rows) {
  if (card.requests.length) return `answer request #${card.requests[0].shout_id}: pullboard answer ${card.requests[0].shout_id} done, or declined <reason>`;
  const live = rows.filter((row) => !['wont', 'retired'].includes(row.status));
  if (!live.length && (rows.length || !card.all.length)) return "turn what the person wants into spec rows with them: the pullboard-decompose skill (pullboard prompt decompose)";
  const approved = live.filter((row) => row.status === 'approved');
  if (live.length && !approved.length) return 'the person approves rows in SPEC.md; then plan them: the pullboard-plan skill';
  if (card.holding.length) return buildNext(card);
  if (card.sentBack.length) return reworkNext(card);
  if (card.toVerify.length) return 'pullboard next --verify --as coordinator, or a verifier that built nothing: pullboard worktree review --model "<model name>"';
  if (card.toMerge.length) {
    const [first] = card.toMerge;
    return `merge #${first.item_id}: git merge --no-edit ${(first.item_checked_commit ?? first.item_commit).slice(0, 12)}, run the gate, then pullboard merged ${first.item_id} <merge commit>`;
  }
  if (card.staleVerdicts?.length) {
    const item = card.staleVerdicts[0];
    return staleVerdictRefusal(item, item.item_verdict_state).message.replace(/^\[STALE_VERDICT\] /u, '');
  }
  if (card.open.length) {
    const lanes = [...new Set(card.open.map((item) => item.item_lane))];
    return `start a builder for each lane with open items (${lanes.join(', ')}): pullboard worktree <lane> --model "<model name>", then the pullboard-run skill`;
  }
  const cited = new Set(card.all.flatMap((item) => (item.item_spec_ids ?? '').split(',').filter(Boolean)));
  const unplanned = approved.filter((row) => !cited.has(row.id));
  if (unplanned.length) {
    return `plan the approved rows no item cites (${unplanned.slice(0, 4).map((row) => row.id).join(', ')}${unplanned.length > 4 ? ', ...' : ''}): the pullboard-plan skill`;
  }
  return 'nothing open: report what was built to the person, or curate the queue: pullboard add, edit, hold';
}

/** Read each actor's newest structured integration attempt unless their later receipt closes it. */
function integrationClaims(root, item, shouts, now) {
  const actors = new Map();
  for (const shout of shouts) {
    if (shout.shout_evidence_item !== item.item_id) continue;
    if (shout.shout_evidence_kind === 'receipt') actors.delete(shout.shout_from);
    else if (shout.shout_evidence_kind === 'attempt' && shout.shout_evidence_outcome === 'integrating'
      && contains(root, item.item_checked_commit ?? item.item_commit, shout.shout_evidence_commit)) {
      actors.set(shout.shout_from, shout);
    }
  }
  const claims = [...actors.values()].map((shout) => ({ type: 'shout', by: shout.shout_from, at: shout.shout_at,
      text: shout.shout_text, commit: shout.shout_evidence_commit, id: shout.shout_id,
      expired: now - Date.parse(shout.shout_at) > 24 * 60 * 60 * 1000 }))
    .sort((a, b) => b.id - a.id);
  return { live: claims.find((claim) => !claim.expired) ?? null,
    expired: claims.find((claim) => claim.expired) ?? null };
}

/** Check verified, unmerged heads against the trunk without changing a worktree or trusting prose. */
export function verifiedMergeGroups(root, items, shouts, now) {
  const groups = { clean: [], conflicts: [], integrating: [] };
  const staleIntegrations = [];
  for (const item of [...items].sort((a, b) => a.item_id - b.item_id)) {
    const claimed = integrationClaims(root, item, shouts, now);
    if (claimed.live) {
      const { expired, ...claim } = claimed.live;
      groups.integrating.push({ item, ...claim });
      continue;
    }
    if (claimed.expired) staleIntegrations.push({ item, ...claimed.expired });
    try {
      requireTrunkMerge(root, item.item_checked_commit ?? item.item_commit);
      groups.clean.push(item);
    } catch (error) {
      if (error.code !== 'MERGE_CONFLICT') throw error;
      const detail = / in ([\s\S]*); merge the trunk into/u.exec(error.message)?.[1] ?? '';
      let files = [];
      try { files = JSON.parse(`[${detail}]`); } catch { files = []; }
      groups.conflicts.push({ item, files });
    }
  }
  return { verifiedNotMerged: groups, staleIntegrations };
}

/** Capture coordinator-only decision sections with stable ages and answers from the board. */
export function coordinatorDecisionSections(board, ctx) {
  const shouts = store.decisionAndEvidenceShouts(board);
  const openDecisions = store.openDecisions(board, COORDINATOR).map((ask) => ({
    id: ask.shout_id, asker: ask.shout_from, question: ask.shout_text, ...(ask.options ? { options: ask.options, item: ask.item } : {}), at: ask.shout_at, age: span(ctx, ask.shout_at),
  }));
  const answers = new Map(store.decisionAnswers(board).map(answer => [answer.shout_answers, answer]));
  const recentAnswers = shouts.filter((ask) => ask.shout_decision).flatMap((ask) => {
    const answer = answers.get(ask.shout_id);
    if (!answer) return [];
    const ageMs = ctx.clock.now().getTime() - Date.parse(answer.shout_at);
    if (ageMs < 0 || ageMs > 24 * 60 * 60 * 1000) return [];
    return [{ id: ask.shout_id, asker: ask.shout_from, question: ask.shout_text,
      answeredBy: answer.shout_from, answer: answer.shout_text, at: answer.shout_at, age: span(ctx, answer.shout_at) }];
  }).sort((a, b) => b.at.localeCompare(a.at));
  const personQuestions = store.openDecisions(board, 'person').map((ask) => ({
    id: ask.shout_id, asker: ask.shout_from, question: ask.shout_text, at: ask.shout_at, age: span(ctx, ask.shout_at),
  }));
  return { openDecisions, recentAnswers, personQuestions, shouts };
}

/** Read and update this checkout's last-run version, returning only newly released headlines. */
export function resumeReleaseNotes(info) {
  const record = join(info.gitDir, 'pullboard-checkout', 'resume-version');
  let previous = '';
  try { previous = readFileSync(record, 'utf8').trim(); } catch { /* First resume in this checkout. */ }
  if (!/^\d+\.\d+\.\d+$/u.test(previous)) {
    mkdirSync(dirname(record), { recursive: true });
    writeFileSync(record, `${VERSION}\n`);
    return null;
  }
  if (previous === VERSION) return null;
  const releases = releaseHeadlinesBetween(previous, VERSION);
  mkdirSync(dirname(record), { recursive: true });
  writeFileSync(record, `${VERSION}\n`);
  return releases.length ? { releases: releases.slice(0, 3), omitted: Math.max(0, releases.length - 3), notes: 'CHANGELOG.md' } : null;
}

