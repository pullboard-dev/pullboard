/** Render detected timeline references without interpreting user prose as HTML or machine wording.
 * Navigation and clock formatting remain explicit browser ports; unmatched words stay byte-for-byte text.
 */
export function timelineBodyHtml(text, { itemHref, codeLink, timeLabel, commit = '', refusalTitles = {} } = {}) {
  /** Escape literal user text and every attribute supplied by a native reference. */
  const esc = value => String(value ?? '').replace(/[&<>"']/gu, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
  // Consume external references whole, before their path, fragment or hash can look repository-relative.
  const literalReference = /\b[A-Za-z][A-Za-z0-9+.-]*:\/\/[^\s<>"']+|\bmailto:[^\s<>"']+|(?<![A-Za-z0-9_.\/-])(?:~\/|\/|[A-Za-z]:[\\/])[^\s<>"']+/u;
  // Infer files only under conventional repository directories, with an actual filename extension.
  // Boundaries keep diff prefixes and path suffixes literal; hashes win before slash-separated prose.
  const detectedReference = /\b\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(?:\.\d+)?(?:Z|[+-]\d\d:\d\d)\b|\b[0-9a-f]{12,64}\b|(?<![A-Za-z0-9_.\/-])[A-Za-z0-9_.-]+\.[A-Za-z0-9]+:\d+(?:-\d+)?@[0-9a-f]{7,40}|(?<![A-Za-z0-9_.\/-])(?:\.github|apps|assets|api|bin|config|docs|examples|lib|packages|public|scripts|src|test|tests|tools|web)\/(?:[A-Za-z0-9_.-]+\/)*[A-Za-z0-9_.-]+\.[A-Za-z0-9]+(?::\d+(?:-\d+)?)?(?:@[0-9a-f]{7,64})?|#[1-9]\d*\b|\b[A-Z][A-Z0-9]*(?:_[A-Z0-9]+)+\b/u;
  const pattern = new RegExp(literalReference.source + '|' + detectedReference.source, 'gu');
  const source = String(text ?? '');
  let html = '', at = 0;
  for (const match of source.matchAll(pattern)) {
    const value = match[0];
    html += esc(source.slice(at, match.index));
    if (literalReference.test(value)) html += esc(value);
    else if (/^\d{4}-/u.test(value) && Number.isFinite(Date.parse(value))) {
      html += '<time datetime="' + esc(value) + '" title="' + esc(value) + '">' + esc(timeLabel ? timeLabel(value) : value) + '</time>';
    } else if (value.startsWith('#') && itemHref) {
      const id = Number(value.slice(1));
      html += Number.isSafeInteger(id) ? '<a class="ref" data-go="item:' + id + '" href="' + esc(itemHref(id)) + '">' + value + '</a>' : esc(value);
    } else if ((value.includes('/') || /:\d+(?:-\d+)?@[0-9a-f]{7,40}$/u.test(value)) && codeLink) {
      const parts = /^(.*?)(?::(\d+)(?:-(\d+))?)?(?:@([0-9a-f]{7,64}))?$/u.exec(value);
      const path = parts[1], safe = !path.split('/').some(part => !part || part === '.' || part === '..');
      const sha = parts[4] || commit;
      html += safe && sha ? codeLink(path + ':' + (parts[2] || '1') + (parts[3] ? '-' + parts[3] : '') + '@' + sha, value) : esc(value);
    } else if (/^[0-9a-f]{12,64}$/u.test(value)) {
      html += '<button class="hash-copy" type="button" title="' + esc(value) + '" aria-label="Copy full hash ' + esc(value) + '" data-copy="' + esc(value) + '"><code class="inline sha" title="' + esc(value) + '">' + value.slice(0, 12) + '</code></button>';
    } else if (/^[A-Z][A-Z0-9]*(?:_[A-Z0-9]+)+$/u.test(value)) {
      const title = refusalTitles[value] || value.toLowerCase().replaceAll('_', ' ');
      html += '<code class="inline refusal" title="' + esc(title) + '">' + esc(value) + '</code>';
    } else html += esc(value);
    at = match.index + value.length;
  }
  return html + esc(source.slice(at));
}
