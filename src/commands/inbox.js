/** The pullboard inbox command separates canonical interrupts from break-time summaries [R2,N26]. */
import { activityDeliveryLines } from '../activity-delivery-cli.js';
import { deliverActivity } from '../activity-delivery-cli.js';
import { context } from '../cli.js';
import { activityDeliveryPorts } from '../cli.js';

/** Read the feed, or explicitly mark only this recipient's delivered interrupt ids acted on. */
export async function run(io, { values = {} } = {}) {
  const ctx = context(io);
  const actedIds = (values['acted-on'] ?? '').split(',').filter(Boolean);
  const ports = activityDeliveryPorts();
  const result = await deliverActivity(ctx, { actedIds }, ports);
  const { agents, ...document } = result;
  io.result?.(document);
  for (const line of activityDeliveryLines(result, ctx.config, ports)) io.say(line);
  return 0;
}
