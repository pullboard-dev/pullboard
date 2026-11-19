import { JSON_SHAPES } from '../../../../../packages/config/index.js';
import { commandOutput as collectCommandOutput } from '../../../../../packages/config/index.js';
import { versionedRefusal } from '../../../../../packages/config/index.js';
import { withMoveNextSteps } from '../../../../../packages/moves/light.js';
import { DEFAULT_NEXT_STEPS } from '../../../../../packages/state/light.js';
/** Pure refusal guidance shared by JSON and CLI output without loading ledger or Git [P4,W4,C7]. */
import { RECORDED_GENERIC_NEXT } from '../../../../../packages/state/light.js';

import {
  COORDINATOR_PERSON_REQUEST,
  personRequestStep,
  personRequestGuidance,
} from '../../../../../packages/config/index.js';
export {
  COORDINATOR_PERSON_REQUEST,
  personRequestStep,
  personRequestGuidance,
} from '../../../../../packages/config/index.js';

/** @type {Readonly<Record<string, string>>} */
export const NEXT_STEPS = withMoveNextSteps(DEFAULT_NEXT_STEPS);

/**
 * Take the step a message already spells out: the clause from its first repair word to the end of
 * that line. One line only, so a multi-line report (a gate digest) is never repeated as the step.
 *
 * @param {string} message
 * @returns {string | undefined}
 */
function stepInMessage(message) {
  const line = String(message).split('\n')[0];
  const match = /(?:^|; |\. |: )((?:run|install|upgrade|fix|restore|commit|merge|test|check out|set|give|use|reject|git push|git fetch|push|claim|start|submit|ask your coordinator|answer from the main checkout|the coordinator(?= (?:runs?|sets?|restores?|either|must)\b)|to keep looking|never work around)\b.*)/i.exec(line);
  const step = match?.[1];
  // UNKNOWN_MOVE contains a documentation placeholder, not a supported reason value.
  return step && !/--reason\s+CODE\b/u.test(step) ? step : undefined;
}

/**
 * The next step for one refusal: its existing final next line, else the step its raise site passed,
 * else prose guidance or this code's row. Unknown remote codes name the service owner and rule.
 *
 * @param {{ code?: string, next?: string } | null | undefined} error
 * @param {string} message
 * @param {{ caller?: 'seat'|'coordinator'|'person'|'unknown' }} [options]
 * @returns {string}
 */
export function nextStepFor(error, message, options = {}) {
  if (options.caller !== 'person' && personRequestGuidance(String(message), options) !== String(message)) return COORDINATOR_PERSON_REQUEST;
  const code = typeof error?.code === 'string' ? error.code : '';
  const finalStep = /(?:^|\r?\n)next:[ \t]*([^\r\n]*\S)[ \t]*(?:\r?\n)*$/u.exec(String(message))?.[1];
  if (finalStep) return personRequestStep(finalStep.trim(), options);
  if (typeof error?.next === 'string' && error.next.trim() && error.next.trim() !== RECORDED_GENERIC_NEXT) return personRequestStep(error.next.trim(), options);
  if (code === 'SPEC_BEHIND_MAIN') return personRequestStep(NEXT_STEPS.SPEC_BEHIND_MAIN, options);
  return personRequestStep(stepInMessage(message) ?? NEXT_STEPS[code]
    ?? `ask the service owner about refusal code ${code || '(unknown)'}, including the displayed refusal`, options);
}


/** A refusal shared by the CLI and API, presenting guidance for a known caller without changing its receipt (A1, A2, B26). */
export function refusalDocument(error, options = {}) {
  const message = String(error.message).replace(/^\[[A-Z][A-Z0-9_]*\] /, '');
  const code = error.code ?? 'INTERNAL';
  return versionedRefusal({ code, message: personRequestGuidance(message, options), next: nextStepFor({ code, next: error.next }, message, options) }, { version: JSON_SHAPES.version });
}

/** Collect output with the already-loaded synchronous public refusal renderer [A1]. */
export function commandOutput(argv, streams) {
  return collectCommandOutput(argv, streams, { version: JSON_SHAPES.version, refusalDocument });
}
