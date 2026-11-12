/**
 * One line on the review queue for status and next, with no imports: status loads it without the move
 * registry or the next-step words that depend on every move module (#1278).
 */
/**
 * Describe the queue's actual outstanding reviews and submission age [Q1,V15].
 *
 * @param {any} ctx
 * @param {any} queue
 * @param {(ctx: any, at: string) => string} span
 * @returns {string}
 */
export function reviewQueueLine(ctx, queue, span) {
  const age = queue.oldestSubmittedAt ? `${span(ctx, queue.oldestSubmittedAt)} ago` : 'none';
  if (queue.awaitingFirstReview !== undefined) {
    const released = queue.releasedItems?.map((item) => `#${item.item} released ${item.releases} ${item.releases === 1 ? 'time' : 'times'}: ${item.reason}`).join('; ');
    return `review queue: ${queue.pending} submitted; ${queue.awaitingFirstReview} waiting for a first reviewer, ${queue.releasedWithoutVerdict} released without a verdict${released ? ` (${released})` : ''}, ${queue.reviewing} agents reviewing; oldest submission ${age}`;
  }
  return `review queue: ${queue.pending} awaiting, ${queue.reviewing} agents reviewing; oldest submission ${age}`;
}
