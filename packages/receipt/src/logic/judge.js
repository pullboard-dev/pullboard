/**
 * Pure judgement of one gate job's collected results [C7]. Nothing here reads a file, a clock, the board or a
 * process: the same collected input always gives the same judgement. The driver writes the verdict step once; what
 * runs after it (caches, accounting, logs) is bookkeeping and can never change what was judged.
 */
import { Refused } from '../../../kernel/light.js';

/** The sections a verdict is made of, in the order they are judged. */
export const SECTIONS = Object.freeze(['static', 'criterion', 'proof', 'cells', 'comparison']);

/** What one section can come to: it held, it failed, it did not apply, or the infrastructure failed it. */
export const OUTCOMES = Object.freeze(['pass', 'fail', 'skip', 'infra']);

/**
 * Judge collected results into per-section outcomes and codes, then one overall verdict. A missing section is an
 * infrastructure outcome (the result never arrived), never a pass. Infra outranks red only when nothing failed
 * outright, so a real failure is never hidden by a lost runner on another section.
 *
 * @param {Record<string, { outcome?: string, code?: string } | undefined>} collected
 * @returns {{ sections: Record<string, { outcome: string, code: string | null }>, verdict: 'green' | 'red' | 'infra', code: string | null }}
 */
export function judge(collected) {
  if (!collected || typeof collected !== 'object') {
    throw new Refused('JUDGE_INPUT', 'judge needs the collected results as an object; pass what the job collected.');
  }
  const sections = {};
  for (const name of SECTIONS) {
    const raw = collected[name];
    if (raw === undefined || raw === null) {
      sections[name] = { outcome: 'infra', code: 'SECTION_MISSING' };
      continue;
    }
    if (!OUTCOMES.includes(raw.outcome)) {
      sections[name] = { outcome: 'infra', code: 'OUTCOME_INVALID' };
      continue;
    }
    sections[name] = { outcome: raw.outcome, code: typeof raw.code === 'string' && raw.code ? raw.code : null };
  }
  const named = (outcome) => SECTIONS.find((name) => sections[name].outcome === outcome);
  const failed = named('fail');
  const lost = named('infra');
  const verdict = failed ? 'red' : lost ? 'infra' : 'green';
  const at = failed ?? lost;
  return { sections, verdict, code: at ? (sections[at].code ?? at.toUpperCase()) : null };
}

/**
 * The verdict step a driver writes for a judgement: the judgement itself and the id of the receipt it was made
 * from. It is a plain frozen value so a repeat write with the same job and step stores the same payload.
 *
 * @param {ReturnType<typeof judge>} judgement
 * @param {string} receiptId
 * @returns {{ name: 'verdict', payload: { receipt: string, verdict: string, code: string | null, sections: object } }}
 */
export function verdictStep(judgement, receiptId) {
  if (typeof receiptId !== 'string' || !receiptId) {
    throw new Refused('VERDICT_RECEIPT', 'a verdict step stores a receipt id; pass the id of the gate run receipt.');
  }
  return Object.freeze({
    name: 'verdict',
    payload: Object.freeze({ receipt: receiptId, verdict: judgement.verdict, code: judgement.code, sections: judgement.sections }),
  });
}

/**
 * Judge, record the verdict step, then run bookkeeping. The verdict is recorded before bookkeeping starts and the
 * returned judgement is the one recorded, whatever bookkeeping does; a bookkeeping failure is reported beside it.
 *
 * @param {object} collected
 * @param {string} receiptId
 * @param {{ record: (step: ReturnType<typeof verdictStep>) => void, bookkeeping?: (step: ReturnType<typeof verdictStep>) => void }} io
 * @returns {{ step: ReturnType<typeof verdictStep>, bookkeepingError: string | null }}
 */
export function settle(collected, receiptId, io) {
  const step = verdictStep(judge(collected), receiptId);
  io.record(step);
  let bookkeepingError = null;
  try { io.bookkeeping?.(step); } catch (error) { bookkeepingError = String(error?.message ?? error); }
  return { step, bookkeepingError };
}
