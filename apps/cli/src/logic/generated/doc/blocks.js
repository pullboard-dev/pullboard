/** Render declared documentation regions without replacing authored prose [C7,A1]. */

/** Escape one Markdown table cell while retaining declaration punctuation. */
export function docCell(value) {
  return String(value).replaceAll('|', '\\|').replaceAll('\n', ' ');
}

/** Render table cells; callers retain ownership of descriptions and ordering. */
export function docTable(headings, rows) {
  return [headings, headings.map(() => '---'), ...rows]
    .map(row => `| ${row.map(docCell).join(' | ')} |`).join('\n');
}

/** Render the actual required fields, rather than maintaining a second shape list. */
export function shapeTable(heading, shapes) {
  return docTable(heading, Object.entries(shapes).map(([name, fields]) => [
    `\`${name}\``, Object.entries(fields).map(([key, type]) => `\`${key}:${type}\``).join(', '),
  ]));
}

/** Replace exactly one marked region, refusing missing, duplicated or reversed markers. */
export function replaceDocBlock(source, name, content) {
  const start = `<!-- ${name}:start -->`, end = `<!-- ${name}:end -->`;
  const first = source.indexOf(start), last = source.indexOf(end);
  if (first < 0 || last < first || source.indexOf(start, first + start.length) >= 0
      || source.indexOf(end, last + end.length) >= 0) throw new Error(`documentation needs one ordered ${name} region`);
  return source.slice(0, first + start.length) + '\n' + content + '\n' + source.slice(last);
}

/** Refresh the table inside a region while retaining explanatory prose within its markers. */
export function replaceDocTable(source, name, table) {
  const start = `<!-- ${name}:start -->`, end = `<!-- ${name}:end -->`;
  const old = source.slice(source.indexOf(start) + start.length, source.indexOf(end)).replace(/^\n|\n$/gu, '');
  const pattern = /^\|[^\n]*(?:\n\|[^\n]*)*/mu;
  if (!pattern.test(old)) throw new Error(`${name} region needs its generated table`);
  return replaceDocBlock(source, name, old.replace(pattern, () => table));
}
