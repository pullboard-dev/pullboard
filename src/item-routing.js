import { ROUTES } from './route-escalation.js';
/** Validate the brief and check required for an item's declared route [B10,B14]. */
import { briefFiles } from './brief.js';
import { briefSections } from './reference-lines.js';
import { refuseMaskedExit } from '../packages/kernel/src/core/literal-shell-words.js';
import { REFERENCE_ENGINE } from './reference-engine.js';
import { Refused } from './refused.js';

const BRIEF_LIMIT = 8000;

/**
 * Refuse an item a lighter model could not build cold (B10, B14). Any brief stays short enough to
 * read. Below the strong route the item needs all of it: a criterion, a check command that proves
 * it, and a brief naming the files and the test.
 *
 * @param {{ brief: string, route: string, criterion: string, check: string }} item
 */
export function checkRouted({ brief, route, criterion, check }, engine) {
  if (brief.length > BRIEF_LIMIT) {
    throw new Refused('BRIEF_TOO_LONG', `the brief is ${brief.length} characters; keep it under ${BRIEF_LIMIT} and point to longer docs by path`);
  }
  refuseMaskedExit(check);
  if (route === 'strong') return;
  const referenceOptions = { references: engine >= REFERENCE_ENGINE };
  const sections = briefSections(brief, referenceOptions);
  const missing = [
    ...(briefFiles(brief, referenceOptions).length ? [] : ['a brief with a Files: section naming the paths to touch']),
    ...(sections.test?.length ? [] : ['a Test: section saying what the test asserts']),
    ...(criterion.trim() ? [] : ['--criterion, saying when it is done']),
    ...(check.trim() ? [] : ['--check, the command that proves it']),
  ];
  if (missing.length) {
    throw new Refused('NO_BRIEF', `an item routed ${route} must be buildable cold; it needs ${missing.join(', ')}`);
  }
}


/**
 * Refuse a route that is not one of ROUTES.
 *
 * @param {string} route
 */
export function checkRoute(route) {
  if (!ROUTES.includes(route)) {
    throw new Refused('BAD_ROUTE', `route "${route}" is light (a small or local model can build it from the brief), mid (a capable model) or strong (a frontier model)`);
  }
}

