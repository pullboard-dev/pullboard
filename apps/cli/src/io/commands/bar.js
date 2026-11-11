import { itemCheckBaseline } from '../../../../../packages/store/index.js';
import { listItems } from '../../../../../packages/store/index.js';
import {
  confirmBarEffect,
  executingBarEffect,
  personBarMode,
} from '../../../../../packages/person/index.js';
import {
  barCoverageForPolicy,
  prepareBarCoverage,
} from '../../../../../packages/verify/index.js';
import { mainPolicy } from '../../../../../packages/sandbox/index.js';
/** Inspect, enable, sign and repair acceptance bars [B4,V1,V2,H16]. */
import { getItem } from '../../../../../packages/store/index.js';
import {
  barReadiness,
  barReadySetting,
} from '../../../../../packages/verify/index.js';
import {
  actOn,
  barActorForCommand,
  idArg,
  ordered,
  personMode,
} from '../entry.js';
import { Refused } from '../../../../../packages/kernel/index.js';
import { sweepFullSuiteBars } from '../bar.js';

/** Run the board-scoped readiness setting or show/sign one exact revision. */
export async function run(io, { first, second, rest, values }) {
  return actOn(io, async (ctx, board, me) => {
    if (first === 'sweep-full-suite') {
      if (second || rest.length) throw new Refused('USAGE', 'pullboard bar sweep-full-suite');
      const result = await sweepFullSuiteBars({
        board,
        agent: me.id,
        listItems,
        edit: (id, change) => ordered(ctx, board, 'editItem', [id, change]),
      });
      io.result?.(result);
      io.say(`S10 full-suite bar sweep edited ${result.changed.length} item(s), skipped ${result.skipped.length}`);
      for (const row of result.changed) io.say(`#${row.id}: removed ${JSON.stringify(row.removed)}`);
      for (const row of result.skipped) io.say(`#${row.id}: skipped ${row.code}: ${row.reason}`);
      return 0;
    }
    if (first === 'ready') {
      if (rest.length || second && !['on', 'off'].includes(second)) throw new Refused('USAGE', 'pullboard bar ready [on|off]');
      const setting = second ? await ordered(ctx, board, 'setBarReady', [{ agentId: me.id, enabled: second === 'on' }]) : barReadySetting(board);
      io.result?.({ barReady: setting });
      io.say(`bar readiness ${setting.enabled ? 'on' : 'off'}; bars frozen before activation keep working until edited`);
      return 0;
    }
    const sign = first === 'sign';
    if (rest.length || !sign && second) throw new Refused('USAGE', 'pullboard bar <id> | sign <id> --note "can a builder meet it, and would two reviewers grade it the same?"');
    const id = idArg(sign ? second : first);
    const item = getItem(board, id);
    const status = barReadiness(board, item, { signature: !sign }, { itemCheckBaseline });
    if (!sign) {
      io.result?.({ id, ...status });
      io.say(status.missing.length ? `#${id} needs: ${status.missing.join('; ')}` : `#${id}'s bar is ready`);
      return 0;
    }
    io.say(`Sign-off asks: can the builder meet this bar, and would two reviewers grade it the same? Check the named baseline, every measurement method, coverage and reviewer edges in pullboard show ${id}.`);
    const sealed = executingBarEffect(ctx, board, 'bar-sign', id);
    const coverage = sealed ? barCoverageForPolicy(ctx.info.root, item, sealed.coverage, mainPolicy(ctx.info.root)) : prepareBarCoverage(ctx.info.root, item, mainPolicy(ctx.info.root), values['coverage-file']);
    const asPerson = personBarMode(ctx, board, me, values, personMode);
    const effect = sealed ?? { revision: status.revision?.revision, digest: status.revision?.digest, note: values.note, coverage };
    const confirmed = await confirmBarEffect(ctx, board, me, { verb: 'bar-sign', item: id, args: { note: effect.note } }, effect, asPerson);
    if (confirmed !== null) return confirmed;
    const signed = await ordered(ctx, board, 'signBar', [id, { agentId: io.personRequest?.phase === 'execute' ? 'person' : me.id, ...effect, barActor: barActorForCommand(ctx, board, { asPerson }) }]);
    io.result?.({ signed });
    io.say(`signed #${id} revision ${signed.revision}; any bar edit needs a fresh signature`);
    return 0;
  });
}
