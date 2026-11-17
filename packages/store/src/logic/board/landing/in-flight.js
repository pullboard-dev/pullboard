/** The batches a landing lease record has in flight: a pure reader, no writer and no caller yet [C7,#8936,#9826]. */

/**
 * Name the batch ids a landing lease record has in flight, in order.
 * A record with a `batches` array lists them itself; a record without one reads as it does today, one running batch while a holder has the trunk and none when idle.
 * Why a reader first: pipelined landing needs a second batch to start while one runs, and nothing may start one until this reading is agreed.
 *
 * @param {{ batches?: unknown[], holder?: { token?: string } | null } | null | undefined} lease
 * @returns {string[]}
 */
export function inFlightBatches(lease) {
  if (Array.isArray(lease?.batches)) return lease.batches.map(String);
  const running = lease?.holder?.token;
  return running === undefined || running === null ? [] : [String(running)];
}
