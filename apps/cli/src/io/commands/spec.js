/** The pullboard spec command, in its own module so an item adding another command never edits these lines. */
import { answerQuestion } from '../../../../../packages/spec/index.js';
import { rowDrafts } from '../../../../../packages/store/index.js';
import { trunkRef } from '../../../../../packages/sandbox/index.js';
import { loadDoctrine } from '../../../../../packages/doctrine/index.js';
import { verifiedPasskeyRowDecision } from '../../../../../packages/person/index.js';
import {
  planRowVerificationApply,
  rowVerificationFindings,
  needsReviewFindings,
} from '../../../../../packages/spec/index.js';
import { planAutomaticRigorApply } from '../../../../../packages/rigor/index.js';
import {
  planSpecRevision,
  prepareSpecRevisionDecisions,
} from '../../../../../packages/spec/index.js';
import {
  fitCommand,
} from '../../../../../packages/blueprints/index.js';
import {
  fitSummary,
  readFitBatch,
} from '../../../../../packages/blueprints/index.js';
import * as store from '../../../../../packages/store/index.js';
import {
  hookRead,
} from '../support.js';
import {
  COORDINATOR,
  cascadeRejectEnabled,
  requireFactQuoteEnabled,
  DOCTRINE_FILE,
  LEGACY_DOCTRINE_FILE,
} from '../../../../../packages/config/index.js';
import {
  proposeDoctrine,
} from '../../../../../packages/doctrine/index.js';
import {
  doctrineHistory,
} from '../../../../../packages/doctrine/index.js';
import {
  citedTestFiles,
  rowEvidence,
  rowStage,
} from '../../../../../packages/verify/index.js';
import {
  headCommit,
} from '../../../../../packages/git/index.js';
import {
  committedIds,
} from '../../../../../packages/store/index.js';
import {
  personCommand,
  requirePersonChannel,
} from '../../../../../packages/person/index.js';
import {
  productProblems,
} from '../../../../../packages/spec/index.js';
import {
  personSigning,
} from '../../../../../packages/person/index.js';
import {
  refuseNamedSigners,
  requireShownRows,
  requireSignedPerson,
  signsPersonMoves,
} from '../../../../../packages/person/index.js';
import { Refused } from '../../../../../packages/kernel/index.js';
import * as applyRow from './spec/apply-row.js';
import { rowDecisionContext } from '../../../../../packages/spec/index.js';
import { commitAppliedRows } from '../../../../../packages/spec/index.js';
import {
  decisionAnswer,
  decisionProjection,
  handAnsweredQuestions,
  pendingAnswers,
  planRowApply,
  prepareRowDecisions,
  shownDecisionRows,
  restoreRowApply,
  rowDecisionView,
  writeRowApply,
} from '../../../../../packages/spec/index.js';
import {
  clashingRowDrafts,
  pendingRowDrafts,
  trunkRowIds,
  withRowDrafts,
} from '../../../../../packages/spec/index.js';
import {
  addSigner,
  assertRequiredSigners,
  defaultPrincipal,
  hasSignerFile,
} from '../../../../../packages/spec/index.js';
import {
  draftRow,
} from '../../../../../packages/spec/index.js';
import {
  legacyDoctrineRenameBase,
  lintSpec,
  loadSpec,
  missingGateFindings,
  parseSpec,
  permanenceProblems,
  readSignoffs,
  signOff,
  standings,
  unmetRows,
} from '../../../../../packages/spec/index.js';
import {
  renderSpecView,
} from '../../../../view/index.js';
import {
  mkdirSync,
  readFileSync,
  writeFileSync,
} from 'node:fs';
import {
  dirname,
  join,
  resolve,
} from 'node:path';
import {
  pathToFileURL,
} from 'node:url';
import {
  citationBoardFindings,
  citations,
  coordinatorFile,
  idList,
  main,
  ordered,
  primaryCheckoutRoot,
  reserveRow,
  specProof,
  textArg,
  freezer,
  whoAmI,
  withBoard,
} from '../entry.js';
import { personCommandContext } from '../context.js';
import {
  assertNoCitedSpecDecline,
  prepareSpecRowApplyPayload,
} from '../../../../../packages/spec/index.js';

/** Validate optional verdicts using only existing board state; a check never initializes a board. */
function verifierFindings(ctx, parsed) {
  const source = readFileSync(parsed.file, 'utf8');
  return hookRead(ctx, board => rowVerificationFindings(board, parsed, source, { rowDrafts }))
    ?? rowVerificationFindings(null, parsed, source, { rowDrafts });
}

/** Needs-review warnings for the spec file while spec.cascadeReject is on (#9343); a check never initializes a board. */
function reviewFindings(ctx, parsed) {
  const enabled = cascadeRejectEnabled();
  return enabled ? hookRead(ctx, board => needsReviewFindings(board, parsed, { enabled })) ?? [] : [];
}

/**
 * The spec commands: reads, sign-offs and person decisions applied by the coordinator.
 *
 * @param {any} io
 * @param {any} args
 * @returns {Promise<number>}
 */
export async function specCommand(io, { first, second, rest, values }) {
  const ctx = personCommandContext(io, { main, ordered });
  const commandFlags = {
    '--json': ['json'],
    check: ['json'],
    view: ['out'],
    show: [],
    verify: ['reason'],
    unmet: ['must'],
    signoff: ['by', 'note', 'note-file'],
    signers: ['key', 'by'],
    draft: ['aim', 'gate', 'section', 'doctrine', 'source', 'revises', 'reason', 'status'],
    approve: ['by', 'text'],
    decline: ['reason'],
    answer: [],
    apply: ['row', 'commit'],
    fit: ['text', 'reason'],
  }[first ?? '--json'];
  if (!commandFlags) throw new Refused('USAGE', 'use pullboard spec --json | check | view | show <id> | verify <id> accepted|rejected --reason "why" | unmet [--must] | draft "<text>" | signoff <ids> | approve <ids> | decline <ids> --reason "why" | answer <id> "<choice or text>" | apply');
  const allowedFlags = [...new Set([...commandFlags, 'json'])];
  for (const flag of Object.keys(values)) {
    if (!allowedFlags.includes(flag)) {
      const next = flag === 'must' ? 'use --must with spec unmet' : 'use a flag accepted by this spec command';
      throw new Refused('FLAG_NOT_ALLOWED', `spec ${first ?? '--json'} does not take --${flag}; ${next}`);
    }
  }
  if (first === 'fit') {
    return await withBoard(ctx, async (board) => await fitCommand(ctx, board, null, second ?? 'list', rest, values, { ordered, whoAmI }));
  }
  const spec = loadSpec(ctx.info.root, ctx.config);
  if (!spec.exists) throw new Refused('NO_SPEC', `no ${ctx.config.spec}; run: pullboard init`);
  const practice = ctx.doctrine;
  const signoffs = readSignoffs(ctx.info.root);
  if (first === 'verify') {
    if (!second || rest.length !== 1 || !['accepted', 'rejected'].includes(rest[0])) throw new Refused('USAGE', 'use pullboard spec verify <id> accepted|rejected --reason "why"');
    const rows = spec.rows.filter(row => row.id === second);
    if (rows.length !== 1) throw new Refused('NO_ROW', `no unique row ${second}; read pullboard spec --json`);
    const source = readFileSync(spec.file, 'utf8').split(/\r?\n/u)[rows[0].line - 1];
    return withBoard(ctx, async board => {
      const me = whoAmI(ctx, board);
      const receipt = await ordered(ctx, board, 'recordRowVerification', [{ agentId: me.id, source, decision: rest[0], reason: values.reason,
        ...(cascadeRejectEnabled() ? { cascade: spec.rows.map(row => ({ id: row.id, serves: row.serves })) } : {}) }]);
      io.result?.({ verification: receipt });
      io.say(`${receipt.id}: ${receipt.decision} by ${receipt.by}; ask the coordinator to run pullboard spec apply`);
      return 0;
    });
  }
  if (first === 'draft') {
    if (second && /\|\s*gate\s*:/iu.test(second)) {
      throw new Refused('INLINE_GATE', 'move the gate after the requirement as --gate "<check>"');
    }
    if (rest.length || (second !== undefined && (!second.trim() || /[\r\n|]/u.test(second)))) {
      throw new Refused('USAGE', 'give one nonempty, single-line requirement: pullboard spec draft "<text>"');
    }
    if (values.gate !== undefined && (!values.gate.trim() || /[\r\n|]/u.test(values.gate))) {
      throw new Refused('USAGE', 'give one nonempty, single-line gate without a field separator, or omit --gate to use review');
    }
    if (values.revises !== undefined) {
      if (values.doctrine || values.aim || values.section || values.source) throw new Refused('FLAG_NOT_ALLOWED', 'a revision keeps the approved row\'s section and tier; use --revises with text, --gate, --status and --reason');
      const drafts = hookRead(ctx, board => store.rowDrafts(board)) ?? [];
      const row = planSpecRevision(ctx.info.root, ctx.config, { revises: values.revises, text: second?.trim(),
        gate: values.gate?.trim(), status: values.status, reason: values.reason,
        taken: [...drafts.map(draft => draft.id), ...trunkRowIds(ctx.info.root, primaryCheckoutRoot(ctx.info), ctx.config, { loadDoctrine, trunkRef })] }, { loadDoctrine });
      const entry = await reserveRow(ctx, row, false);
      io.result?.({ id: entry.id, row: entry });
      io.say(entry.id);
      return 0;
    }
    if (!second?.trim()) throw new Refused('USAGE', 'give one nonempty requirement: pullboard spec draft "<text>"');
    if (values.status !== undefined || values.reason !== undefined) throw new Refused('FLAG_NOT_ALLOWED', '--status and --reason belong to spec draft --revises <id>');
    if (values.doctrine) {
      if (typeof values.source !== 'string' || !values.source.trim() || /[\r\n|]/u.test(values.source)) {
        throw new Refused('USAGE', 'a doctrine ruling needs its source; give --source "shout 42" or --source "chat, 2026-10-16"');
      }
      withBoard(ctx, (board) => {
        if (!ctx.info.isMain || whoAmI(ctx, board).id !== COORDINATOR) throw new Refused('COORDINATOR_ONLY', 'only the coordinator proposes standing rulings; ask your coordinator to run spec draft --doctrine --source');
      });
      const planned = proposeDoctrine(ctx, values, second, { reserved: (hookRead(ctx, (board) => store.rowDrafts(board)) ?? []).map((draft) => draft.id), write: false });
      const result = proposeDoctrine(ctx, values, second, { id: (await reserveRow(ctx, { ...planned.row, target: 'doctrine' }, true)).id });
      io.result?.(result);
      io.say(result.id);
      return 0;
    }
    if (values.source !== undefined) throw new Refused('FLAG_NOT_ALLOWED', 'spec draft --source belongs to --doctrine; use both when proposing a ruling');
    const tier = values.aim ? 'aim' : 'must';
    const plan = draftRow(ctx.info.root, ctx.config, { target: 'spec', text: second.trim(), gate: values.gate?.trim() ?? 'review', tier, section: values.section, write: false,
      taken: [...(hookRead(ctx, (board) => store.rowDrafts(board)) ?? []).map((draft) => draft.id), ...(ctx.info.isMain ? [] : trunkRowIds(ctx.info.root, primaryCheckoutRoot(ctx.info), ctx.config, { loadDoctrine, trunkRef }))] }, { loadDoctrine });
    // A lane cannot write SPEC.md, so its reservation is the draft, cited at once and written by spec apply; the main checkout writes its row now (#878).
    const entry = await reserveRow(ctx, plan.row, ctx.info.isMain);
    const { id, row } = ctx.info.isMain ? draftRow(ctx.info.root, ctx.config, { target: 'spec', text: plan.row.text, gate: plan.row.gate, tier, section: values.section, id: entry.id }, { loadDoctrine }) : { id: entry.id, row: entry };
    io.result?.({ id, row });
    io.say(id);
    return 0;
  }
  if (first === 'approve' || first === 'decline') {
    return withBoard(ctx, async (board) => {
      const me = whoAmI(ctx, board);
      const ids = [second, ...rest].filter(Boolean).flatMap((text) => text.split(/[\s,]+/u)).filter(Boolean);
      const drafts = store.rowDrafts(board);
      const revisionIds = ids.filter(id => drafts.some(draft => draft.id === id && draft.revises));
      // A passkey request cannot yet show a revision proposal's exact rows, so a signed board refuses rather than guess [E22].
      if (revisionIds.length && personSigning(board).signed) {
        throw new Refused('PERSON_SIGNED', 'a proposed revision to an approved row cannot be confirmed with a passkey yet', 'turn signed person moves off with your passkey to decide revision proposals, then turn them on again');
      }
      // With signed person moves on, the decision goes to the person's passkey; a named SSH signer has no passkey yet [E22].
      const shown = [...spec.rows, ...(practice.rows ?? []).map(row => ({ ...row, id: `doctrine:${row.id}` }))].filter(row => ids.includes(row.id));
      if (personSigning(board).signed) {
        refuseNamedSigners(shown, ids);
        if (values.by !== undefined && values.by !== 'person') throw new Refused('PERSON_SIGNER_REQUIRED', `the requested SSH signer ${values.by} has no passkey identity`, 'confirm as the person without --by, or wait until signing is off');
      }
      // The rows are read only when a passkey request is built, so an unpaired board refuses before reading them.
      const confirmed = await requireSignedPerson(ctx, board, me, { verb: `spec-${first}`, args: { ids: ids.join(','),
        ...(values.text === undefined ? {} : { text: values.text }), ...(values.reason === undefined ? {} : { reason: values.reason }) } },
      () => shownDecisionRows(ctx.info.root, ctx.config, ids, { loadDoctrine }));
    if (confirmed !== null) return confirmed;
      const sources = personSigning(board).signed ? shownDecisionRows(ctx.info.root, ctx.config, ids, { loadDoctrine }) : [];
      requirePersonChannel(io.personChannel);
      if (!ctx.info.isMain || me.id !== COORDINATOR) throw new Refused('B26_PERSON_APPROVAL', 'only the person from the main checkout approves or declines rows; use pullboard view for the person to decide');
      if (personSigning(board).signed) {
        const decidable = [...spec.rows, ...(practice.rows ?? []).map((row) => ({ ...row, id: `doctrine:${row.id}` }))];
        refuseNamedSigners(decidable, ids);
        requireShownRows(board, io.personRequest, decidable, ids, sources);
      }
      if (revisionIds.length) {
        if (revisionIds.length !== ids.length || values.text !== undefined) throw new Refused('SPEC_REVISION', 'decide exact revision proposals separately; draft a new proposal to change its text');
        const records = prepareSpecRevisionDecisions(ctx.info.root, ctx.config, drafts, { ids, decision: first,
          reason: values.reason, by: values.by, on: new Date().toISOString(), commit: headCommit(ctx.info.root) ?? '' });
        const decisions = await ordered(ctx, board, 'decideSpecRevisions', [{ agentId: store.PERSON, channel: io.personChannel ?? 'terminal', decisions: records }]);
        io.result?.({ decisions });
        revisionIds.forEach(id => io.say(`${id}: ${first === 'approve' ? 'approved, pending apply' : 'declined; approved row unchanged'}`));
        return 0;
      }
      // A gate file that was committed and then removed is a lost test: approving its row would turn spec check red for every agent [S4].
      if (first === 'approve') {
        const asked = { rows: spec.rows.filter((row) => ids.includes(row.id)).map((row) => ({ ...row, status: 'approved', tier: 'must' })) };
        const lost = missingGateFindings(asked, ctx.info.root).find((finding) => finding.level === 'error');
        if (lost) throw new Refused('GATE_FILE_MISSING', `${lost.id}: ${lost.message}`, 'restore the gate file or revise the row to name its new home, then approve again');
      }
      // An approve keeps a pending answer: plain, it approves the answered text; --text says what it replaces.
      const signedDecision = personSigning(board).signed;
      const kept = first === 'approve' ? pendingAnswers(ctx.info.root, ctx.config, ids, store.rowDecisions(board)) : new Map();
      if (signedDecision && values.text === undefined && kept.size) throw new Refused('STALE_ROW_DECISION', 'this row has a pending answer different from the original shown source', 'approve one row with --text containing the exact pending answer you want your passkey to confirm');
      const decide = { decision: first, reason: values.reason, by: signedDecision ? 'person' : values.by, sshSign: !signedDecision, passkeyRequest: signedDecision ? io.personRequest?.id : undefined, on: new Date().toISOString(), commit: headCommit(ctx.info.root) ?? '' };
      const records = values.text === undefined && kept.size ? ids.flatMap((id) => prepareRowDecisions(ctx.info.root, ctx.config, { ...decide, ids: [id], text: kept.get(id)?.text }, { loadDoctrine }))
        : prepareRowDecisions(ctx.info.root, ctx.config, { ...decide, ids, text: values.text }, { loadDoctrine });
      const decisions = await ordered(ctx, board, 'recordRowDecisions', [{ agentId: store.PERSON, channel: io.personChannel ?? 'terminal', decisions: records }]);
      io.result?.({ decisions });
      decisions.forEach((record) => {
        const old = record.kind === 'spec' ? kept.get(record.id) : undefined;
        const now = decisionAnswer(record);
        if (old && old.text !== record.text) io.say(`${record.id}: this text replaces the pending answer ${old.answer} with ${now === null ? `"${record.text}"` : `the answer ${now}`}`);
        io.say(`${record.kind === 'doctrine' ? 'doctrine:' : ''}${record.id}: ${first === 'approve' ? (old && old.text === record.text ? `approved with the answer ${old.answer}` : 'approved') : 'declined'}, pending apply`);
      });
      return 0;
    });
  }
  // Read without creating a board: a repo that has none signs nothing [E22].
  if (first === 'signoff' && signsPersonMoves(ctx.info.root)) {
    return withBoard(ctx, async board => {
      const ids = [second, ...rest].filter(Boolean).flatMap(text => idList(text));
      if (!ids.length) throw new Refused('USAGE', 'pullboard spec signoff <ids>');
      const rows = ids.map(id => spec.rows.find(row => row.id === id));
      if (rows.some(row => !row || row.status !== 'approved')) throw new Refused('CANNOT_SIGN', 'only approved rows in this spec are signed');
      refuseNamedSigners(rows, ids);
      if (values.by) throw new Refused('PERSON_SIGNER_REQUIRED', `the requested SSH signer ${values.by} has no passkey identity`, 'omit --by for a person approval, or wait until signing is off to use that named SSH principal');
      if (values.note !== undefined || values['note-file'] !== undefined) throw new Refused('USAGE', 'signed optional sign-off records the exact row approval, without an SSH sign-off note', 'use spec approve <ids> to confirm those rows with your passkey');
      const proof = specProof(ctx);
      const testFiles = citedTestFiles(ctx.info.root);
      const evidence = ids.map(id => ({ id, ...rowEvidence(ctx.info.root, id, { ...proof, testFiles }) }));
      const missing = evidence.filter(row => !row.files.length && !row.verified.length).map(row => row.id);
      if (missing.length) throw new Refused('NO_EVIDENCE', `${missing.join(', ')} has no evidence; build it or cite its id in a test first`);
      const completed = await requireSignedPerson(ctx, board, whoAmI(ctx, board), { verb: 'spec-approve', args: { ids: ids.join(',') } }, shownDecisionRows(ctx.info.root, ctx.config, ids, { loadDoctrine }));
      if (completed === null) throw new Refused('PERSON_SIGNED', 'confirm optional sign-off as a row approval through its original terminal request', 'run spec approve <ids> with your passkey');
      io.result?.({ count: ids.length, by: 'person', ids, evidence, ...io.personConfirmation });
      return completed;
    });
  }
  if (first === 'answer') {
    const completed = signsPersonMoves(ctx.info.root) ? await withBoard(ctx, async board => {
      const row = spec.rows.find(entry => entry.id === second);
      if (!row) throw new Refused('NO_ROW', `${second} is not a row in ${ctx.config.spec}`);
      if (personSigning(board).signed) refuseNamedSigners([row], [second]);
      return requireSignedPerson(ctx, board, whoAmI(ctx, board), { verb: 'spec-answer', args: { row: second, answer: rest.join(' ').trim() } }, shownDecisionRows(ctx.info.root, ctx.config, [row.id], { loadDoctrine }));
    }) : null;
    if (completed !== null) return completed;
    requirePersonChannel(io.personChannel, process.env, { command: personCommand(primaryCheckoutRoot(ctx.info) ?? ctx.info.root, ['spec', 'answer', second, rest.join(' ')]) });
    return withBoard(ctx, async (board) => {
      const me = whoAmI(ctx, board);
      if (!ctx.info.isMain || me.id !== COORDINATOR) throw new Refused('B26_PERSON_APPROVAL', 'only the person answers a pending question, from the main checkout or the view', 'ask the person to answer it in pullboard view, or in their own terminal at the main checkout');
      const given = rest.join(' ').trim();
      if (!second || !given || /[\r\n|]/u.test(given)) throw new Refused('USAGE', 'give one row and a one-line answer without a field separator: pullboard spec answer <id> "<choice or text>"');
      const row = spec.rows.find((entry) => entry.id === second);
      if (!row) throw new Refused('NO_ROW', `${second} is not a row in ${ctx.config.spec}`, 'list the pending questions with pullboard spec --json, then answer one of them');
      if (row.status !== 'pending') throw new Refused('SPEC_ANSWER', `${second} is ${row.status}, not a pending question`, `read it with pullboard spec show ${second}; only a pending row takes an answer`);
      if (personSigning(board).signed) requireShownRows(board, io.personRequest, [row], [second], shownDecisionRows(ctx.info.root, ctx.config, [second], { loadDoctrine }));
      const { text } = answerQuestion(row.text, given, second);
      const records = prepareRowDecisions(ctx.info.root, ctx.config, { ids: [second], decision: 'approve', text, sshSign: !personSigning(board).signed, passkeyRequest: personSigning(board).signed ? io.personRequest?.id : undefined, by: personSigning(board).signed ? 'person' : undefined, on: new Date().toISOString(), commit: headCommit(ctx.info.root) ?? '' }, { loadDoctrine });
      const decisions = await ordered(ctx, board, 'recordRowDecisions', [{ agentId: store.PERSON, channel: io.personChannel ?? 'terminal', decisions: records }]);
      // The answer reported is read back from the signed text, never carried as a field of its own.
      const answered = decisions.map((record) => ({ ...record, answer: decisionAnswer(record) }));
      io.result?.({ decisions: answered });
      answered.forEach((record) => io.say(`${record.id}: answered ${record.answer}, pending apply`));
      return 0;
    });
  }
  if (first === 'apply') {
    if (second || rest.length) throw new Refused('USAGE', 'pullboard spec apply takes no ids; it applies current person decisions');
    return withBoard(ctx, async (board) => {
      const me = whoAmI(ctx, board);
      applyRow.requireApplier({ isMain: ctx.info.isMain, me: me.id, coordinator: COORDINATOR, channel: io.personChannel, values, decisions: store.rowDecisions(board), events: io.personChannel === undefined ? [] : store.events(board, { kinds: ['row_decision'] }) });
      applyRow.requireCleanForCommit(ctx.info.root, values); // --commit proves the checkout clean first; every automatic proposal is preflighted before any draft or decision changes a file.
      const passkeyDecision = record => verifiedPasskeyRowDecision(board, record);
      const first = planRowApply(ctx.info.root, ctx.config, applyRow.rowDecisionsFor(store.rowDecisions(board), values.row), { passkeyDecision, holdStale: true }, { loadDoctrine });
      // Stale decisions are held and named; the command fails only when nothing at all could apply [B2].
      if (first.held.length && !first.records.length) throw new Refused('STALE_ROW_DECISION', first.held.map(held => `${held.why}`).join('; '), first.held.map(held => held.next).join('; '));
      assertNoCitedSpecDecline(store.rowDecisions(board), store.listItems(board, { all: true }));
      const automatic = planAutomaticRigorApply(ctx.info.root, ctx.config, store.rowDrafts(board), store.rowDecisions(board));
      writeRowApply(ctx.info.root, automatic);
      automatic.collisions.forEach(clash => io.say(`${clash.target}: ${clash.id} holds different text, gate or tier than its Rigor draft, so the draft was not written; resolve ${clash.id} by hand`));
      automatic.files.forEach(file => io.say(`${file.file}: materialized unproved Rigor drafts for the person's review`));
      // A lane's board drafts (#878) reach SPEC.md as draft rows at their own ids; the person approves them there as before.
      const drafted = pendingRowDrafts(loadSpec(ctx.info.root, ctx.config), store.rowDrafts(board)).map((draft) => draftRow(ctx.info.root, ctx.config, { target: 'spec', text: draft.text, gate: draft.gate, tier: draft.tier, section: /^(.*?)\d+$/u.exec(draft.id)[1], id: draft.id }, { loadDoctrine }));
      drafted.forEach((row) => io.say(`${row.file}: ${row.id} drafted from a lane, for the person to approve`));
      clashingRowDrafts(loadSpec(ctx.info.root, ctx.config), store.rowDrafts(board)).forEach((draft) => io.say(`${ctx.config.spec}: ${draft.id} holds other text, so the draft by ${draft.by} was not written; shout ${draft.by} to run pullboard spec draft again and cite the new id`));
      const preflight = planRowApply(ctx.info.root, ctx.config, applyRow.rowDecisionsFor(store.rowDecisions(board), values.row), { passkeyDecision, holdStale: true }, { loadDoctrine });
      let preparedApply;
      const applied = await ordered(ctx, board, 'applyRowDecisions', [{ agentId: me.id, events: preflight.records.map(record => record.event) }], {
        prepareInWriter(currentBoard) {
          const plan = planRowApply(ctx.info.root, ctx.config, applyRow.rowDecisionsFor(store.rowDecisions(currentBoard), values.row), { passkeyDecision, holdStale: true }, { loadDoctrine });
          try {
            writeRowApply(ctx.info.root, plan);
            const args = { agentId: me.id, events: plan.records.map(record => record.event) };
            const payload = prepareSpecRowApplyPayload(currentBoard, plan.records.map(record => record.event),
              freezer(ctx, { captureVerifyPolicy: true, board: currentBoard, applyingDecisions: plan.records }));
            const { skippedDrafts, refreezes } = payload;
            if (refreezes !== undefined) args.refreezes = refreezes;
            if (skippedDrafts.length) args.skippedDrafts = skippedDrafts;
            preparedApply = { plan, skippedDrafts };
            return { args: [args], rollback: () => restoreRowApply(ctx.info.root, plan) };
          } catch (error) { restoreRowApply(ctx.info.root, plan); throw error; }
        },
      });
      const { plan, skippedDrafts } = preparedApply, committed = applyRow.commitApplyRow(ctx.info.root, values, plan, applied, commitAppliedRows);
      if (skippedDrafts.length) io.say(`Refreeze skipped never-frozen open items ${skippedDrafts.map(id => `#${id}`).join(', ')} citing explicitly declined drafts.`);
      const verifications = planRowVerificationApply(ctx.info.root, ctx.config, store.rowVerifications(board), store.rowDecisions(board));
      writeRowApply(ctx.info.root, verifications);
      verifications.applied.forEach(id => io.say(`${ctx.config.spec}: ${id} verifier verdict applied`));
      first.held.forEach(held => io.say(`${held.id} held: ${held.why}; next: ${held.next}`));
      io.result?.({ held: first.held.map(({ id, why, next }) => ({ id, why, next })), applied: committed ?? applied, verifications: verifications.applied, files: [...plan.files, ...verifications.files].map((file) => file.file) });
      applied.forEach((record) => io.say(`${record.file}: ${record.id} ${record.decision === 'approve' ? 'approved' : 'wont'}${record.reason ? `: ${record.reason}` : ''}`));
      if (!applied.length && !drafted.length && !verifications.applied.length) io.say('no pending row decisions');
      else if (!values.commit) io.say('stage and commit the changed row files and any .pullboard/signoffs.jsonl receipts');
      return 0;
    });
  }
  if (first === 'check' || first === undefined) {
    const files = [[ctx.config.spec, spec], ...(practice.exists ? [[practice.name, practice]] : [])];
    for (const [, parsed] of files) assertRequiredSigners(ctx.info.root, parsed.rows);
    const collisionFiles = [[ctx.config.spec, spec], ...(practice.repoExists ? [[practice.name, practice.repo]] : [])];
    const renameBase = collisionFiles.some(([name]) => name === DOCTRINE_FILE)
      ? legacyDoctrineRenameBase(ctx.info.root, DOCTRINE_FILE)
      : null;
    const baselineNotes = new Set();
    const previousSources = new Map();
    const previousCounts = new Map(collisionFiles.map(([name]) => {
      const baselineName = renameBase && name === DOCTRINE_FILE ? LEGACY_DOCTRINE_FILE : name;
      const previous = name === DOCTRINE_FILE && !renameBase
        ? { status: 1, stdout: '' }
        : coordinatorFile(ctx.info.root, baselineName, renameBase ?? undefined);
      if (previous.baseline) baselineNotes.add(previous.baseline);
      const rows = previous.status === 0 ? parseSpec(previous.stdout, { strictGrammarVersion: false }).rows : [];
      previousSources.set(name, rows);
      const counts = new Map();
      for (const row of rows) counts.set(row.id, (counts.get(row.id) ?? 0) + 1);
      return [name, counts];
    }));
    const locationsById = new Map();
    for (const [name, parsed] of collisionFiles) {
      for (const row of parsed.rows) {
        const locations = locationsById.get(row.id) ?? [];
        locations.push({ name, line: row.line });
        locationsById.set(row.id, locations);
      }
    }
    const collisionFindings = new Map(collisionFiles.map(([name]) => [name, []]));
    for (const [id, locations] of locationsById) {
      if (locations.length < 2) continue;
      const currentCounts = new Map();
      for (const location of locations) currentCounts.set(location.name, (currentCounts.get(location.name) ?? 0) + 1);
      const known = [...currentCounts].every(([name, count]) => count <= (previousCounts.get(name)?.get(id) ?? 0));
      for (let index = 0; index < locations.length; index++) {
        const location = locations[index];
        const other = locations[(index + 1) % locations.length];
        collisionFindings.get(location.name).push({
          level: known ? 'warning' : 'error', line: location.line, id,
          message: `${known ? 'known duplicate id' : 'duplicate id'}; also appears at ${other.name}:${other.line}`,
        });
      }
    }
    let errors = 0;
    const messages = [...baselineNotes];
    for (const [name, parsed] of files) {
      const findings = [
        ...lintSpec(parsed, { requireFactQuote: requireFactQuoteEnabled() }).filter((finding) => !finding.message.startsWith('duplicate id;')),
        ...(name === ctx.config.spec && parsed.rows.some(row => row.verify !== undefined)
          ? verifierFindings(ctx, parsed) : []),
        ...(name === ctx.config.spec ? reviewFindings(ctx, parsed) : []),
        ...(name !== ctx.config.spec ? parsed.rows.filter(row => row.verify !== undefined).map(row => ({ level: 'error', line: row.line, id: row.id,
          message: 'ROW_VERIFY_PROVENANCE: verifier annotations currently require an exact board-drafted SPEC row' })) : []),
        ...missingGateFindings(parsed, ctx.info.root),
        ...(collisionFindings.get(name) ?? []),
      ];
      findings.forEach((finding) => messages.push(`${name}:${finding.line} ${finding.id ?? ''} ${finding.level}: ${finding.message}`.replace('  ', ' ')));
      const history = parsed === practice ? doctrineHistory(ctx.info.root, name) : committedIds(ctx.info.root, name);
      const cited = name === ctx.config.spec ? citations(ctx, history) : new Map();
      // A bare doctrine id in a header (37a843ba86 cited CS4) names a DOCTRINE.md row, never a missing spec row [S1].
      for (const id of [...cited.keys()]) if (practice?.rows?.some(row => row.id === id)) cited.delete(id);
      const lost = permanenceProblems(parsed === practice ? practice.repo : name === ctx.config.spec ? withRowDrafts(parsed, hookRead(ctx, (board) => store.rowDrafts(board))) : parsed, { committed: history.ids, cited });
      if (name === ctx.config.spec) {
        const mainRows = new Set((previousSources.get(name) ?? []).map(row => row.id));
        for (const problem of lost) {
          if (mainRows.has(problem.id)) problem.message = 'is present on main but missing from this worktree; run git merge main, then pullboard spec check';
        }
        const answered = handAnsweredQuestions(previousSources.get(name) ?? [], parsed.rows, () => hookRead(ctx, (board) => store.rowDecisions(board)) ?? []);
        lost.push(...answered.map((id) => ({ id, message: io.guidance(`pending question answered by hand; ask the person to run pullboard spec answer ${id} "<choice or text>" and restore the pending row`) })));
      }
      lost.forEach((problem) => messages.push(`${name}: ${problem.id} error: ${problem.message}`));
      const fileErrors = findings.filter((finding) => finding.level === 'error').length + lost.length;
      errors += fileErrors;
      messages.push(`${name}: ${parsed.rows.length} rows, ${fileErrors} errors, ${findings.length + lost.length - fileErrors} warnings`);
    }
    errors += citationBoardFindings(ctx.info.root, spec).reduce((count, finding) => (io.say(finding.message), count + (finding.level === 'error' ? 1 : 0)), 0);
    const unnamed = productProblems(ctx.config, spec);
    unnamed.forEach((problem) => messages.push(`${ctx.config.spec}: error: ${problem}`));
    errors += unnamed.length;
    if (values.json && !errors) {
      const rows = files.flatMap(([file, parsed]) => parsed.rows.map(({ id, status, tier, text, gate, serves, signers = [], section, line, origin, version, reason, file: source, source: from, verify }) => (
        { id, status, tier, text, gate, serves, signers, section, line, file: source ?? file,
          ...(from === undefined ? {} : { source: from }), ...(verify === undefined ? {} : { verify }), ...(origin ? { origin, version, reason } : {}) }
      )));
      const fit = readFitBatch(ctx.info.commonDir, { isMain: ctx.info.isMain, channel: io.personChannel });
      io.result({ rows, ...(fit.proposals.length ? { fit: fit.proposals, fitBatch: fit.batch } : {}) });
    } else messages.forEach((message) => io.say(message));
    if (!values.json) fitSummary(readFitBatch(ctx.info.commonDir, { isMain: ctx.info.isMain, channel: io.personChannel })).forEach((message) => io.say(message));
    return errors ? 1 : 0;
  }
  if (first === 'signers' && second === 'add') {
    if (signsPersonMoves(ctx.info.root)) throw new Refused('PERSON_SIGNER_REQUIRED', `SSH signer ${values.by ?? defaultPrincipal(ctx.info.root)} cannot be enrolled by a passkey identity`, 'keep signing on and use passkey row approvals; named SSH signer changes wait until signing is off');
    requirePersonChannel(io.personChannel);
    const signer = addSigner(ctx.info.root, { by: values.by, key: values.key });
    io.result?.(signer);
    io.say(signer.added
      ? signer.initial
        ? `added SSH signer ${signer.by}; stage and commit ${signer.path}, .pullboard/first-commit, and .pullboard/signers.initial`
        : `added SSH signer ${signer.by} to ${signer.path}; commit ${signer.path} and .pullboard/signoffs.jsonl`
      : `${signer.by} is already listed in ${signer.path}`);
    return 0;
  }
  if (first === 'view') {
    const out = values.out ? resolve(ctx.io.cwd, values.out) : join(ctx.info.gitDir, 'pullboard', 'spec.html');
    const html = renderSpecView({
      title: spec.title,
      ...withBoard(ctx, board => rowDecisionView(ctx.info.root, ctx.config, store.rowDecisions(board), spec, practice)),
      signoffs,
      generatedAt: new Date().toISOString().slice(0, 16).replace('T', ' '),
      files: { spec: ctx.config.spec, practice: ctx.config.practice },
    });
    mkdirSync(dirname(out), { recursive: true });
    writeFileSync(out, html);
    io.result?.({ path: out });
    io.say(`wrote ${out}`);
    io.say(`open: ${pathToFileURL(out).href}`);
    return 0;
  }
  if (first === 'show') {
    const doctrineId = second?.startsWith('doctrine:');
    const parsed = doctrineId ? practice : spec;
    const id = doctrineId ? second.slice('doctrine:'.length) : second;
    const source = parsed.rows.find((entry) => entry.id === id);
    if (source?.verify) {
      const findings = doctrineId ? [{ message: 'verifier annotations currently require an exact board-drafted SPEC row' }]
        : verifierFindings(ctx, { ...parsed, rows: [source] });
      if (findings.length) throw new Refused('ROW_VERIFY_RECEIPT', findings[0].message);
    }
    const row = source && withBoard(ctx, (board) => decisionProjection(store.rowDecisions(board), source, doctrineId ? 'doctrine' : 'spec', rowDecisionContext(ctx.info.root, ctx.config)));
    if (!row) throw new Refused('NO_ROW', `no row ${second ?? ''} in ${ctx.config.spec}`);
    const standing = standings(parsed.rows, signoffs).get(row.id) ?? { met: [], stale: [] };
    io.result?.({ row, standing });
    io.say(`${row.id} [${row.status}${row.tier ? `, ${row.tier}` : ''}] ${store.readableRigorText(row.text)}`);
    if (row.stage) io.say(row.stage);
    if (row.reason) io.say(`reason: ${row.reason}`);
    if (row.gate) io.say(`gate: ${row.gate}`);
    if (row.serves.length) io.say(`serves: ${row.serves.join(', ')}`);
    if (row.source) io.say(`source: ${row.source}`);
    if (row.verify) io.say(`verify: ${row.verify.decision} by ${row.verify.by} | ${row.verify.reason}`);
    io.say(`signed: ${standing.met.map((entry) => `${entry.by} ${entry.on}`).join(', ') || 'no'}${standing.stale.length ? `; stale: ${standing.stale.length}` : ''}`);
    for (const entry of [...standing.met, ...standing.stale]) if (entry.note) io.say(`note (${entry.by}): ${entry.note}`);
    return 0;
  }
  if (first === 'unmet') {
    const rows = unmetRows(spec.rows, signoffs, { mustOnly: values.must });
    const proof = specProof(ctx);
    const testFiles = citedTestFiles(ctx.info.root);
    const by = standings(spec.rows, signoffs);
    io.result?.({ rows: rows.map((row) => ({ ...row, stage: rowStage(by.get(row.id), rowEvidence(ctx.info.root, row.id, { ...proof, testFiles })) })) });
    rows.forEach((row) => io.say(`${row.id} [${row.tier || 'no tier'}] ${store.readableRigorText(row.text)} — ${rowStage(by.get(row.id), rowEvidence(ctx.info.root, row.id, { ...proof, testFiles }))}`));
    io.say(`${rows.length} approved rows without a current sign-off`);
    return 0;
  }
  if (first === 'signoff') {
    requirePersonChannel(io.personChannel);
    const ids = [second, ...rest].filter(Boolean).flatMap((text) => idList(text));
    if (!ids.length) throw new Refused('USAGE', 'pullboard spec signoff <ids> [--by <principal>] [--note "what was checked"]');
    const invalid = ids.filter((id) => spec.rows.find((row) => row.id === id)?.status !== 'approved');
    if (invalid.length) throw new Refused('CANNOT_SIGN', `${invalid.join(', ')}: only approved rows in this spec are signed`);
    const proof = specProof(ctx);
    const testFiles = citedTestFiles(ctx.info.root);
    const evidence = ids.map((id) => ({ id, ...rowEvidence(ctx.info.root, id, { ...proof, testFiles }) }));
    const missing = evidence.filter((row) => !row.files.length && !row.verified.length).map((row) => row.id);
    if (missing.length) throw new Refused('NO_EVIDENCE', `${missing.join(', ')} has no evidence; build it or cite its id in a test first`);
    for (const row of evidence) {
      io.say(`evidence for ${row.id}:`);
      if (row.files.length) io.say('  cited by tests (none run by pullboard):');
      for (const file of row.files) io.say(`    ${file}`);
      for (const item of row.verified) io.say(`  verified #${item.id}: ${item.note || '(no accepting note)'}`);
    }
    const note = textArg(io, values, 'note') ?? '';
    const by = values.by ?? (hasSignerFile(ctx.info.root) ? defaultPrincipal(ctx.info.root) : '');
    const count = signOff(ctx.info.root, spec, { ids, by, on: new Date().toISOString(), note, commit: headCommit(ctx.info.root) ?? '' });
    io.result?.({ count, by, ids, evidence });
    io.say(`signed ${count} rows as ${by}; commit .pullboard/signoffs.jsonl`);
    return 0;
  }
  throw new Refused('USAGE', 'pullboard spec --json | check | view | show <id> | unmet [--must] | draft "<text>" | signoff <ids> | signers add | approve <ids> | decline <ids> --reason "why" | answer <id> "<choice or text>" | apply');
}

/** Run `pullboard spec` and return its exit code. */
export async function run(io, args) {
  return await specCommand(io, args);
}
