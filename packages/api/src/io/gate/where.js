/** The places a red gate receipt's static checks reported, for the red fact behind gate.redFactLocation [C7,#9083]. */

const LOCATION = /(?:^|[\s("'])((?:[\w.@-]+\/)*[\w.@-]+\.(?:m?js|cjs|json|md|ts)):(\d+)(?::\d+)?/gu;
const SHOWN = 3;

/** Every text of a receipt a lint or guard check printed its findings in: refusal messages first, then each red phase's own output. */
function reportedTexts(receipt) {
  const gate = receipt?.gate ?? {};
  const refusals = (gate.analysis?.refusals ?? []).map(row => row?.message);
  const phases = (gate.phases ?? []).filter(phase => phase?.status !== 0).flatMap(phase => [phase.digest, phase.exit, phase.tail]);
  return [...refusals, ...phases].filter(text => typeof text === 'string' && text);
}

/**
 * One short line naming the first few file:line places a red receipt's checks reported, then a count of the rest; null when
 * they named none. Why: the lint's location sat only in the runner's full log, so a builder had to open it [C7].
 *
 * @param {Record<string, any>} receipt
 * @returns {string | null}
 */
export function redLocationLine(receipt) {
  const seen = new Set();
  for (const text of reportedTexts(receipt)) for (const match of text.matchAll(LOCATION)) seen.add(`${match[1]}:${match[2]}`);
  const found = [...seen];
  if (!found.length) return null;
  const more = found.length - SHOWN;
  return `red at: ${found.slice(0, SHOWN).join(', ')}${more > 0 ? `; ${more} more` : ''}`;
}
