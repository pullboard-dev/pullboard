/** The one builder and parser for generated commit messages: header, ids that fit, then +N, and the Pullboard trailers (RFC 0005) [C7]. */

/** A commit header's length limit, which the commit hook also enforces by default. */
import { headerRows } from "../../../spec/index.js";
export const HEADER_LIMIT = 72;

/** Trailer keys this format writes, in the order they appear. */
export const ITEM_TRAILER = 'Pullboard-Item';
export const ROWS_TRAILER = 'Pullboard-Rows';

const HEADER_RE = /^([a-z]+)(?:\(([a-z0-9._/-]+)\))?(!)?: (.*)$/u;
const TRAILER_RE = /^([A-Za-z][A-Za-z0-9-]*): (.*)$/u;

/**
 * Clean a title into a lower-case header subject: emoji, line breaks and bracketed text go, so a
 * title can never forge or break the id brackets that follow it.
 *
 * @param {string} title
 * @returns {string[]} The title's words.
 */
function titleWords(title) {
  return String(title ?? '').toLowerCase()
    .replace(/[\p{Extended_Pictographic}‍︎️]/gu, '')
    .replace(/[\r\n]+/gu, ' ')
    .replace(/\[[^\]]*\]/gu, '')
    .replace(/[[\]]/gu, '')
    .trim().split(/\s+/u).filter(Boolean);
}

/**
 * The bracket suffix for a header with `room` characters left: every id when they all fit, else the
 * first ids that fit and `+N` for the rest. The first id always fits, because the title left room for it.
 *
 * @param {string[]} rows
 * @param {number} room
 * @returns {string} The suffix with its leading space, or '' when there are no rows.
 */
function bracket(rows, room) {
  if (!rows.length) return '';
  const all = ` [${rows.join(',')}]`;
  if (all.length <= room) return all;
  let shown = 1;
  while (shown < rows.length - 1 && ` [${[...rows.slice(0, shown + 1), `+${rows.length - shown - 1}`].join(',')}]`.length <= room) shown += 1;
  return ` [${[...rows.slice(0, shown), `+${rows.length - shown}`].join(',')}]`;
}

/**
 * Build a commit message from board facts. The title keeps priority: it takes the header up to the
 * room the first id (and a `+N`) needs, so the header always cites a row the commit hook can check,
 * then the rows fill what is left. It never refuses for how many rows an item
 * cites: every row is in the `Pullboard-Rows` trailer whatever the header shows.
 *
 * @param {{ type: string, scope?: string, title: string, item?: number | null, rows?: string[], fallback?: string, body?: string, preferRows?: boolean }} message
 *   rows must already be in spec order; preferRows reserves all header ids when they fit; fallback is for an empty title.
 * @returns {{ header: string, body: string, trailers: string, message: string }}
 */
export function buildCommitMessage({ type, scope = '', title, item = null, rows = [], fallback = '', body = '', preferRows = false }) {
  const prefix = `${type}${scope ? `(${scope})` : ''}: `;
  const allRows = rows.length ? ` [${rows.join(',')}]`.length : 0;
  const minimumReserve = rows.length ? ` [${rows.length === 1 ? rows[0] : `${rows[0]},+${rows.length - 1}`}]`.length : 0;
  const reserve = preferRows && allRows < HEADER_LIMIT - prefix.length ? allRows : minimumReserve;
  const budget = HEADER_LIMIT - prefix.length - reserve;
  let subject = '';
  for (const word of titleWords(title)) {
    const next = subject ? `${subject} ${word}` : word;
    if (next.length > budget) break;
    subject = next;
  }
  subject = subject.replace(/\.+$/u, '');
  if (!subject) subject = (titleWords(title).join(' ') || fallback || (item ? `item ${item}` : 'update')).slice(0, Math.max(1, budget));
  const head = `${prefix}${subject}`;
  const header = `${head}${bracket(rows, HEADER_LIMIT - head.length)}`;
  const trailers = [
    ...(item ? [`${ITEM_TRAILER}: #${item}`] : []),
    ...(rows.length ? [`${ROWS_TRAILER}: ${rows.join(',')}`] : []),
  ].join('\n');
  const text = String(body ?? '').trim();
  return { header, body: text, trailers, message: [header, text, trailers].filter(Boolean).join('\n\n') };
}

/**
 * Parse a commit message into its header parts and trailers: the exact inverse of
 * buildCommitMessage. Trailers are read only from the last paragraph, and only when every line of it
 * is a `Key: value` trailer, so text after the trailers leaves the message with none.
 *
 * @param {string} message
 * @returns {{ header: string, type: string | null, scope: string, breaking: boolean, title: string,
 *   shown: string[], more: number, body: string, trailers: { key: string, value: string }[],
 *   item: number | null, rows: string[] | null }}
 */
export function parseCommitMessage(message) {
  const text = String(message ?? '').replace(/\r\n/gu, '\n').replace(/\s+$/u, '');
  const [header = '', ...restLines] = text.split('\n');
  const paragraphs = restLines.join('\n').split(/\n{2,}/u).map((part) => part.replace(/^\n+|\n+$/gu, '')).filter(Boolean);
  const last = paragraphs.at(-1) ?? '';
  const lines = last.split('\n');
  const isTrailers = Boolean(last) && lines.every((line) => TRAILER_RE.test(line));
  const trailers = isTrailers ? lines.map((line) => { const [, key, value] = TRAILER_RE.exec(line); return { key, value: value.trim() }; }) : [];
  const body = (isTrailers ? paragraphs.slice(0, -1) : paragraphs).join('\n\n');
  // Historical coordinator companions named their item with this retired alias; writers never do.
  const itemValue = (trailers.find((entry) => entry.key === ITEM_TRAILER)
    ?? trailers.find((entry) => entry.key === 'Pullboard-Companion'))?.value;
  const rowsValue = trailers.find((entry) => entry.key === ROWS_TRAILER)?.value;
  const typed = HEADER_RE.exec(header);
  const { shown, more, rest } = headerRows(header);
  const subject = typed ? HEADER_RE.exec(rest)?.[4] ?? '' : rest;
  return {
    header,
    type: typed ? typed[1] : null,
    scope: typed?.[2] ?? '',
    breaking: Boolean(typed?.[3]),
    title: subject,
    shown,
    more,
    body,
    trailers,
    item: itemValue && /^#[1-9]\d*$/u.test(itemValue) ? Number(itemValue.slice(1)) : null,
    rows: rowsValue === undefined ? null : rowsValue.split(',').filter(Boolean),
  };
}

/**
 * Every way a generated message differs from what the board says it must carry: the header limit,
 * the item trailer, the rows trailer and the header's ids being the first rows plus `+N` for the rest.
 * A landing checks every message with this before its first merge.
 *
 * @param {string} message
 * @param {{ item: number, rows: string[] }} expected - rows in spec order.
 * @returns {string[]}
 */
export function commitMessageProblems(message, { item, rows }) {
  const parsed = parseCommitMessage(message);
  const problems = [];
  if (parsed.header.length > HEADER_LIMIT) problems.push(`its header has ${parsed.header.length} characters, over ${HEADER_LIMIT}`);
  if (!parsed.type) problems.push('its header has no type(scope): prefix');
  if (parsed.trailers.some((entry) => entry.key === 'Pullboard-Companion')) {
    problems.push('its Pullboard-Companion trailer is retired; generate Pullboard-Item instead');
  }
  if (parsed.item !== item) problems.push(`its ${ITEM_TRAILER} trailer is not #${item}`);
  const written = parsed.rows ?? [];
  if (written.join(',') !== rows.join(',')) problems.push(`its ${ROWS_TRAILER} trailer is not ${rows.join(',') || 'absent'}`);
  if (!rows.length && parsed.rows !== null) problems.push(`an item that cites no rows has no ${ROWS_TRAILER} trailer`);
  const prefix = rows.slice(0, parsed.shown.length);
  if (prefix.join(',') !== parsed.shown.join(',') || parsed.shown.length + parsed.more !== rows.length) {
    problems.push('its header ids are not the first rows followed by +N for the rest');
  }
  return problems;
}

/**
 * Order cited rows as the spec lists them; doctrine and unknown ids follow in citation order, so
 * the same cited set always writes the same trailer.
 *
 * @param {string[]} ids
 * @param {{ rows: { id: string }[] } | null} spec
 * @returns {string[]}
 */
export function specOrder(ids, spec) {
  const unique = [...new Set(ids.map((id) => String(id).trim()).filter(Boolean))];
  if (!spec?.rows?.length) return unique;
  const position = new Map();
  spec.rows.forEach((row, index) => { if (!position.has(row.id)) position.set(row.id, index); });
  return unique
    .map((id, index) => ({ id, index, at: position.get(id) ?? Infinity }))
    .sort((left, right) => left.at - right.at || left.index - right.index)
    .map((entry) => entry.id);
}

const REGEX_SPECIALS = /[.*+?^${}()|[\]\\]/gu;

/**
 * The lines of a message that quote a configured person: the name as a whole word, any case, followed within 30
 * characters by a colon and an opening quote, or by said/says/wrote/told/asked/replied/ruled and a quote. A plain
 * mention or a dated ruling citation without quoted words passes, and an empty names list checks nothing [C7,#11300].
 *
 * @param {string} text
 * @param {string[]} names - commits.quotedNames.
 * @returns {string[]} One refusal per offending line, naming the line and the next step.
 */
export function quotedPersonProblems(text, names) {
  const wanted = (names ?? []).map(name => String(name).trim()).filter(Boolean);
  if (!wanted.length) return [];
  const alternation = wanted.map(name => name.replace(REGEX_SPECIALS, '\\$&')).join('|');
  const speaker = `\\b(?:${alternation})\\b`;
  const patterns = [
    new RegExp(`${speaker}[^\\n]{0,30}:\\s*["“]`, 'iu'),
    new RegExp(`${speaker}(?:,[^\\n"]{0,24})?\\s+(?:said|says|wrote|asked|told|replied|ruled)\\b[^\\n]{0,40}["“]`, 'iu'),
  ];
  const problems = [];
  String(text).split('\n').forEach((line, index) => {
    if (patterns.some(pattern => pattern.test(line))) {
      problems.push(`line ${index + 1} quotes a configured person; state the rule itself or cite its item or spec id`);
    }
  });
  return problems;
}
