import { itemCheckBaseline } from '../board-query.js';
import {
  confirmBarEffect,
  executingBarEffect,
  personBarMode,
} from '../person-bar-cli.js';
import {
  barCoverageForPolicy,
  prepareBarCoverage,
} from '../bar-coverage.js';
import { mainPolicy } from '../trusted-policy.js';
/** Inspect, enable and independently sign acceptance bars [B4,V1,V2,H16]. */
import { getItem } from '../board.js';
import {
  barReadiness,
  barReadySetting,
} from '../bar-readiness.js';
import {
  actOn,
  barActorForCommand,
  idArg,
  ordered,
} from '../cli.js';
import { Refused } from '../refused.js';

/** Run the board-scoped readiness setting or show/sign one exact revision. */
export async function run(io, { first, second, rest, values }) {
  return actOn(io, async (ctx, board, me) => {
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
    const asPerson = personBarMode(ctx, board, me, values);
    const effect = sealed ?? { revision: status.revision?.revision, digest: status.revision?.digest, note: values.note, coverage };
    const confirmed = await confirmBarEffect(ctx, board, me, { verb: 'bar-sign', item: id, args: { note: effect.note } }, effect, asPerson);
    if (confirmed !== null) return confirmed;
    const signed = await ordered(ctx, board, 'signBar', [id, { agentId: io.personRequest?.phase === 'execute' ? 'person' : me.id, ...effect, barActor: barActorForCommand(ctx, board, { asPerson }) }]);
    io.result?.({ signed });
    io.say(`signed #${id} revision ${signed.revision}; any bar edit needs a fresh signature`);
    return 0;
  });
}
