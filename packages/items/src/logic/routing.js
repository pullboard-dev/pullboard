import { ROUTES } from "../../../seats/browser.js";
/** Validate the brief and check required for an item's declared route [B10,B14]. */
import { briefFiles } from "./brief.js";
import { briefSections } from "../../../spec/light.js";
import { refuseMaskedExit } from "../../../kernel/index.js";
import { REFERENCE_ENGINE } from "../../../state/light.js";
import { PER_ITEM_FULL_SUITE_ENGINE } from '../../../state/light.js';
import { Refused } from "../../../kernel/light.js";

const BRIEF_LIMIT = 8000;
const OUT_OF_SCOPE_CHECK = /\b(?:the\s+)?(?:full|entire|complete)\s+suite\s+(?:passes?|is\s+green|succeeds?|runs?\s+successfully)\b|\b(?:CI|continuous\s+integration)\s+(?:must|needs?\s+to|has\s+to|is\s+required\s+to)\s+(?:pass|be\s+green|succeed)\b|\b(?:must|needs?\s+to|has\s+to|required\s+to)\s+pass\s+(?:CI|continuous\s+integration)\b/iu;
/** Detect an affirmative audit-scope gate per sentence, allowing local removal instructions. */
function outOfScopeRequirement(text) {
  return String(text ?? '').split(/(?<=[.!?])\s+/u).some(sentence => {
    if (!OUT_OF_SCOPE_CHECK.test(sentence) && !/\b(?:CI|continuous\s+integration)\s+(?:passes?|is\s+green|succeeds?|runs?\s+successfully)\b/iu.test(sentence)) return false;
    return !/\b(?:remove|drop|delete|omit|exclude)\b.{0,120}\b(?:full|entire|complete)\s+suite\b|\b(?:remove|drop|delete|omit|exclude)\b.{0,120}\bCI\b/iu.test(sentence);
  });
}

/** A per-item bar cannot make the main audit's full suite or CI a completion condition [S10]. */
export function checkPerItemCriterion(criterion, engine) {
  if (engine < PER_ITEM_FULL_SUITE_ENGINE) return;
  if (outOfScopeRequirement(criterion)) {
    throw new Refused('S10', 'a per-item criterion cannot require the full suite or CI to pass; remove that sentence because the full suite belongs to the main audit', 'drop the full-suite or CI requirement and keep the clause tied to this item’s named files');
  }
}

/** Remove only complete sentence clauses that make the main full suite or CI a per-item gate. */
export function stripPerItemFullSuiteCriterion(criterion) {
  const clauses = String(criterion ?? '').split(/(?<=[.!?])\s+/u);
  const removed = clauses.filter(clause => outOfScopeRequirement(clause));
  if (!removed.length) return { criterion: String(criterion ?? '').trim(), removed: [] };
  return { criterion: clauses.filter(clause => !outOfScopeRequirement(clause)).join(' ').trim(), removed };
}

/**
 * Refuse an item a lighter model could not build cold (B10, B14). Any brief stays short enough to
 * read. Below the strong route the item needs all of it: a criterion, a check command that proves
 * it, and a brief naming the files and the test.
 *
 * @param {{ brief: string, route: string, criterion: string, check: string }} item
 */
/**
 * The literal test files a check command names, in order and without repeats.
 *
 * @param {string} check
 * @returns {string[]}
 */
export function checkTestFiles(check) {
  return [...new Set([...String(check ?? '').matchAll(/(?:^|\s)(['"]?)([\w./-]+\.(?:test\.[cm]?js|spec\.[cm]?js))\1(?=\s|$)/gu)].map(match => match[2]))];
}

/**
 * The test files a check names that a commit lacks, so a submit can refuse before it queues a gate (#3095).
 *
 * @param {string} check
 * @param {(file: string) => boolean} exists - Whether the submitted commit holds the file.
 * @returns {string[]}
 */
export function missingCheckFiles(check, exists) {
  return checkTestFiles(check).filter(file => !exists(file));
}

/** Fill absent low-route file and test sections from literal test paths, bare or quoted, in the item's check (#3120). */
function inferBrief(brief, check, engine) {
  const referenceOptions = { references: engine >= REFERENCE_ENGINE };
  const sections = briefSections(brief, referenceOptions);
  const files = checkTestFiles(check);
  if (!files.length) return brief;
  const add = [];
  if (!briefFiles(brief, referenceOptions).length) add.push(`Files:\n${files.map(file => `- ${file}`).join('\n')}`);
  if (!sections.test?.length) add.push(`Test: ${files.join(', ')}`);
  return add.length ? `${brief.trim()}${brief.trim() ? '\n\n' : ''}${add.join('\n\n')}` : brief;
}

export function checkRouted({ brief, route, criterion, check }, engine) {
  checkPerItemCriterion(criterion, engine);
  if (brief.length > BRIEF_LIMIT) {
    throw new Refused('BRIEF_TOO_LONG', `the brief is ${brief.length} characters; keep it under ${BRIEF_LIMIT} and point to longer docs by path`);
  }
  refuseMaskedExit(check);
  if (route === 'strong') return brief;
  brief = inferBrief(brief, check, engine);
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
  return brief;
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

