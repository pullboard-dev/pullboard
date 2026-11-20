/** The pullboard doctrine command, in its own module so an item adding another command never edits these lines. */
import { runnerExecutionServices } from '../../../../../packages/runners/index.js';
import { landingExecutionServices } from '../../../../../packages/landing/index.js';
import {
  checkRulesAt,
  doctrineReport,
  ruleLine,
} from '../../../../../packages/doctrine/index.js';
import {
  withGateSlot,
} from '../../../../../packages/gate/heavy.js';
import {
  Refused,
} from '../../../../../packages/kernel/index.js';
import {
  context,
  resourceAgent,
} from '../entry.js';

/** Run `pullboard doctrine` and return its exit code. */
export async function run(io, { first, second, rest }) {
  if (first !== 'check' || second || rest.length) throw new Refused('USAGE', 'pullboard doctrine check');
  const ctx = context(io);
  // Only a repo whose committed doctrine carries a check takes a machine slot for it.
  const rules = checkRulesAt(ctx.info.root, 'HEAD', ctx.config.practice).length
    ? await withGateSlot(ctx.info.root, () => doctrineReport(ctx.info.root, ctx.config), { executionServices: { runners: runnerExecutionServices(), landing: landingExecutionServices() }, itemCheck: true, agent: resourceAgent(ctx), kind: 'doctrine', item: 'doctrine check', onWait: io.gateWaitReporter(io) })
    : [];
  io.result?.({ rules });
  if (!rules.length) io.say('no committed doctrine rule carries a check; add one as | gate: check <command> | count: N');
  for (const rule of rules) io.say(ruleLine(rule));
  return rules.every((rule) => rule.holds) ? 0 : 1;
}
