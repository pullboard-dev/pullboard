/** The SPEC.md row grammar: the reader and the constants it needs, pure so a light path can parse a spec without spec's shell [C7,CD60]. */
import { Refused } from '../../../kernel/browser.js';
import { parseRowVerification } from './format.js';

export const STATUSES = ['approved', 'draft', 'pending', 'fact', 'wont', 'retired'];
export const TIERS = ['must', 'aim'];
/** Shared SPEC.md/PRACTICE.md row grammar; bump for incompatible persisted format changes. */
export const SPEC_GRAMMAR_VERSION = 1;

const ID = '[A-Za-z]+\\d+(?:\\.\\d+)*';
export const ID_RE = new RegExp(`^${ID}$`);
const ROW_RE = new RegExp(`^- (${ID}) \\[([a-z]+)(?:,\\s*([a-z]+))?\\]\\s+(.+)$`);
const ROWISH_RE = new RegExp(`^- ${ID}\\s+\\[`);
const SECTION_RE = /^##\s+(.+)$/;

export const FIELD_NAMES = ['gate', 'serves', 'signers', 'count', 'runs', 'mode', 'files', 'source', 'quote', 'verify', 'stakes'];
/** How much a wrong approval costs: a row writes one of these after `| stakes:`; a row that writes none is team [C7]. */
export const STAKES = ['low', 'team', 'critical'];
export const CHECK_FIELDS = ['count', 'runs', 'mode', 'files'];

/**
 * One row's trailing fields, after the text: `| gate: ...`, `| serves: a, b` and `| signers: CO,AB`.
 * A doctrine rule may add `| count: N`, `| runs: nightly`, `| mode: watch` and `| files: <paths>`
 * to a `gate: check`;
 * those keys appear on the row only when written, so rows without them parse exactly as before.
 * Any row may add `| source: <name> <id> <url>`, the reference a blueprint rule came from; it too
 * appears only when written. A source-backed fact may add `| quote: <sentence>`, the words it rests on,
 * stored next to its value and read back as written.
 * A check command may itself contain ` | `: a part that names no known field continues it.
 *
 * @param {string} rest
 * @returns {{ text: string, gate: string, serves: string[], signers: string[], unknown: string[], stakes: string, count?: string, runs?: string, mode?: string, files?: string, source?: string, quote?: string }}
 */
function splitFields(rest) {
  const [text = '', ...parts] = rest.split(' | ');
  const fields = { text: text.trim(), gate: '', serves: [], signers: [], unknown: [], stakes: 'team' };
  let inCheck = false;
  let verdictReason = false;
  for (const part of parts) {
    if (verdictReason) {
      fields.verify = parseRowVerification(fields.verify, part.trim());
      verdictReason = false;
      continue;
    }
    const [key = '', ...value] = part.split(':');
    const joined = value.join(':').trim();
    if (inCheck && !FIELD_NAMES.includes(key.trim())) {
      fields.gate += ` | ${part.trim()}`;
      continue;
    }
    inCheck = false;
    if (key.trim() === 'verify') {
      if (Object.hasOwn(fields, 'verify')) fields.unknown.push('duplicate verify field');
      fields.verify = joined;
      verdictReason = true;
    } else if (key.trim() === 'gate') {
      fields.gate = joined;
      inCheck = /^check(\s|$)/u.test(joined);
    } else if (key.trim() === 'stakes') {
      if (STAKES.includes(joined)) fields.stakes = joined;
      else fields.unknown.push(`stakes must be low, team or critical: ${part.trim()}`);
    } else if (CHECK_FIELDS.includes(key.trim()) || key.trim() === 'source' || key.trim() === 'quote') fields[key.trim()] = joined;
    else if (key.trim() === 'serves') {
      fields.serves = joined.split(',').map((id) => id.trim()).filter(Boolean);
    } else if (key.trim() === 'signers') {
      fields.signers = joined.split(',').map((signer) => signer.trim()).filter(Boolean);
    } else fields.unknown.push(part.trim());
  }
  if (verdictReason) fields.verify = parseRowVerification(fields.verify, '');
  return fields;
}

/**
 * Read SPEC.md text into its title, intro, sections and rows. Lines that look like rows but do not
 * parse are kept as problems, never dropped silently.
 *
 * @param {string} source
 * @param {{ strictGrammarVersion?: boolean }} [options] - Historical text is parsed for ids without enforcing its marker.
 * @returns {{ grammarVersion: number, title: string, intro: string[], sections: any[], rows: any[], problems: any[] }}
 */
export function parseSpec(source, { strictGrammarVersion = true } = {}) {
  const spec = { grammarVersion: SPEC_GRAMMAR_VERSION, title: '', intro: [], sections: [], rows: [], problems: [] };
  let section = null;
  let fence = '';
  source.split(/\r?\n/).forEach((line, index) => {
    const lineNo = index + 1;
    const marker = /^ {0,3}(`{3,}|~{3,})(.*)$/u.exec(line);
    if (fence) {
      if (marker && marker[1][0] === fence[0] && marker[1].length >= fence.length && !marker[2].trim()) fence = '';
      return;
    }
    if (marker && (marker[1][0] === '~' || !marker[2].includes('`'))) {
      fence = marker[1];
      return;
    }
    const grammar = /^\uFEFF?\s*<!--\s*pullboard-grammar(?:\s+(.*?))?\s*-->\s*$/.exec(line);
    if (grammar) {
      const declared = grammar[1]?.trim() ?? '';
      const valid = /^\d+$/u.test(declared);
      if (strictGrammarVersion && (!valid || BigInt(declared) !== BigInt(SPEC_GRAMMAR_VERSION))) {
        const found = valid ? declared : 'invalid';
        throw new Refused(
          'A5_GRAMMAR_VERSION',
          `grammar ${found} is not supported; this Pullboard reads grammar ${SPEC_GRAMMAR_VERSION}; upgrade Pullboard or use a file written for grammar ${SPEC_GRAMMAR_VERSION}`,
        );
      }
      return;
    }
    if (line.startsWith('# ') && !spec.title) {
      spec.title = line.slice(2).trim();
      return;
    }
    const heading = SECTION_RE.exec(line);
    if (heading) {
      section = { name: heading[1].trim(), line: lineNo };
      spec.sections.push(section);
      return;
    }
    const match = ROW_RE.exec(line);
    if (match && section) {
      const [, id, status, tier, rest] = match;
      const fields = splitFields(rest);
      spec.rows.push({ id, status, tier: tier ?? '', ...fields, section: section.name, line: lineNo });
      return;
    }
    if (ROWISH_RE.test(line)) {
      spec.problems.push({ line: lineNo, message: 'row does not parse: - ID [status, tier] text | gate: ... | serves: ...' });
      return;
    }
    if (!section && line.trim() && !line.startsWith('# ')) spec.intro.push(line.trim());
  });
  return spec;
}
