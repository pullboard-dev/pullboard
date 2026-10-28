/** Routing rulings are rules the coordinator records; next reads them, no prose ruling routes work [C7]. */
import { Refused } from '../refused.js';
import { actOn } from '../cli.js';
import { context } from '../cli.js';
import { idArg } from '../cli.js';
import { ordered } from '../cli.js';
import { withBoardRead } from '../cli.js';
import { routingRules } from '../routing-rules.js';
import { STANDING_RULINGS } from '../routing-rules.js';

const USAGE = 'pullboard rule add review|build|any <only-seat|bar-seat|require-family|bar-family|bar-pool|require-session|bar-session> <value> (--item <id> | --tier strict) --source <shout-id> [--note "why"]; rule revoke <id>; rule migrate; rule list';

/** One line per rule, naming its source shout. */
function line(rule) {
  const scope = rule.scope.item === undefined ? 'strict items' : `#${rule.scope.item}`;
  return `rule #${rule.id}: ${rule.act} of ${scope}: ${rule.effect} ${rule.value}${rule.source ? ` (shout ${rule.source})` : ''}${rule.note ? ` - ${rule.note}` : ''}`;
}

/** Add, revoke, migrate or list routing rules. */
export async function run(io, { first, second, rest, values }) {
  if (!first || first === 'list') {
    const rules = withBoardRead(context(io), board => routingRules(board));
    io.result?.({ rules });
    for (const rule of rules) io.say(line(rule));
    if (!rules.length) io.say('no routing rules');
    return 0;
  }
  if (first === 'migrate') {
    return actOn(io, async (ctx, board, me) => {
      for (const ruling of STANDING_RULINGS) await ordered(ctx, board, 'setRoutingRule', [{ agentId: me.id, ...ruling }]);
      const rules = routingRules(board);
      io.result?.({ rules });
      io.say(`${STANDING_RULINGS.length} standing routing rulings are rules now; list them with pullboard rule list`);
      return 0;
    });
  }
  if (first === 'revoke') {
    if (rest.length) throw new Refused('USAGE', USAGE);
    const revoke = idArg(second);
    return actOn(io, async (ctx, board, me) => {
      await ordered(ctx, board, 'setRoutingRule', [{ agentId: me.id, revoke }]);
      io.result?.({ revoked: revoke });
      io.say(`revoked routing rule #${revoke}`);
      return 0;
    });
  }
  if (first !== 'add' || rest.length !== 2 || (values.item === undefined) === (values.tier === undefined)) throw new Refused('USAGE', USAGE);
  const source = values.source === undefined ? null : idArg(values.source);
  const scope = values.item === undefined ? { tier: values.tier } : { item: idArg(values.item) };
  return actOn(io, async (ctx, board, me) => {
    const id = await ordered(ctx, board, 'setRoutingRule', [{ agentId: me.id, act: second, scope, effect: rest[0], value: rest[1], source,
      ...(values.note === undefined ? {} : { note: values.note }) }]);
    io.result?.({ id, rules: routingRules(board) });
    io.say(`recorded routing rule #${id}`);
    return 0;
  });
}
