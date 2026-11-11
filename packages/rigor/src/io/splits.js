/** Ordinary architectural suggestions retain coordinator and person authority, without red/green proof [D1]. */
import { loadDoctrine } from '../../../doctrine/index.js';
import { proposeDoctrine } from '../../../doctrine/index.js';
import { Refused } from '../../../kernel/index.js';
import {
  automaticSourceFromText,
  readAutomaticRigorSource,
} from '../../../store/index.js';
import { planAutomaticRigorApply } from './auto/apply.js';
import { writeRowApply } from '../../../spec/index.js';
import {
  splitAlreadyProposed,
  splitProposal,
} from './conflicts.js';

/** Finish the exact original pending file write after its durable reservation, never reviving a decided row. */
function resumeSplit(ctx, doctrine, entry, decisions) {
  if (decisions.some(decision => decision.kind === 'doctrine' && decision.id === entry.id)) {
    throw new Refused('STALE_ROW_DECISION', `${entry.id} has a person decision but its doctrine row is missing; a split retry cannot recreate it`, 'ask the coordinator to restore the decided doctrine row and run pullboard spec apply before retrying');
  }
  const suffix = / Source: (conflict-split:[A-Za-z0-9_-]+)$/u.exec(entry.text);
  if (!suffix) throw new Refused('ROW_DRAFT', `${entry.id} has an incomplete split source; ask the coordinator to inspect its row reservation before retrying`);
  return proposeDoctrine({ ...ctx, doctrine }, { source: suffix[1], gate: entry.gate }, entry.text.slice(0, suffix.index), { id: entry.id });
}

/** Reserve and write pending review-gated rulings through the existing ordinary doctrine path. */
export async function draftConflictSplits(ctx, report, { read, reserve }) {
  const state = read();
  if (!ctx.info.isMain || !state.coordinator) throw new Refused('COORDINATOR_ONLY', 'only the coordinator proposes standing split rulings; ask your coordinator to run pullboard rigor --draft-splits from the main checkout');
  const splitDrafts = [];
  for (const file of report.hotFiles) {
    const doctrine = loadDoctrine(ctx.info.root, ctx.config);
    const automatic = state.rows.findLast(row => row.target === 'doctrine'
      && readAutomaticRigorSource(automaticSourceFromText(row.text))?.key === `conflict:${encodeURI(file.file)}`);
    if (automatic) {
      // The old explicit command prepares the already recorded advice, rather than asking twice.
      const plan = planAutomaticRigorApply(ctx.info.root, ctx.config, [automatic], state.decisions ?? []);
      if (plan.files.length) {
        writeRowApply(ctx.info.root, plan);
        const row = loadDoctrine(ctx.info.root, ctx.config).repo.rows.find(row => row.id === automatic.id);
        splitDrafts.push({ id: `doctrine:${row.id}`, row });
      }
      continue;
    }
    if (splitAlreadyProposed(doctrine.repo.rows, file)) continue;
    // A reservation is not a materialized draft: a crash between these two writes must be recoverable.
    const interrupted = state.rows.find(row => row.written && row.target === 'doctrine'
      && !doctrine.repo.rows.some(existing => existing.id === row.id)
      && splitAlreadyProposed([{ ...row, status: 'draft' }], file));
    if (interrupted) {
      splitDrafts.push(resumeSplit(ctx, doctrine, interrupted, state.decisions ?? []));
      continue;
    }
    if (splitAlreadyProposed(state.rows, file)) continue;
    const suggestion = splitProposal(file);
    const values = { source: suggestion.source, gate: 'review' };
    const planned = proposeDoctrine({ ...ctx, doctrine }, values, suggestion.text, { reserved: state.rows.map(row => row.id), write: false });
    const entry = await reserve({ ...planned.row, target: 'doctrine' });
    const written = proposeDoctrine({ ...ctx, doctrine }, values, suggestion.text, { id: entry.id });
    state.rows.push({ ...written.row, target: 'doctrine' });
    splitDrafts.push(written);
  }
  return splitDrafts;
}
