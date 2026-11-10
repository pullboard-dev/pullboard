/** Read recorded decision provenance without importing answer authority [N29,B29,P6]. */
/**
 * The origin an answer event recorded; unknown when it recorded none.
 *
 * @param {{ provenance?: { origin?: string } }} detail an answer event's detail
 * @returns {string}
 */
export function originOf(detail) {
  const origin = detail?.provenance?.origin;
  return typeof origin === 'string' && origin ? origin : 'unknown';
}
