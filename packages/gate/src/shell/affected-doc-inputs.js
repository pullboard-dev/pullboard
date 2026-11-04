/** Find the documentation files a module can read, conservatively and without running it [V4,C7]. */
import { posix } from 'node:path';

/** A scanner declares this header when it reads the whole documentation tree. */
export const DOCS_TREE_INPUT = '/** @pullboard-test-input docs-tree */';

/**
 * Find literal documentation inputs without executing repository code. File references are resolved
 * both from the repository and from the reader; directory references deliberately overselect their
 * subtree. Split path arguments and template prefixes count as directory reads. Comments may add
 * readers, which is safe: this is conservative input discovery, not JavaScript data-flow analysis.
 * Computed Markdown names select the docs tree; opaque helpers declare DOCS_TREE_INPUT. The
 * landing gate remains complete and never uses this submit-only optimization.
 */
export function documentationInputs(path, source, imports, changedDocs = []) {
  const inputs = new Set();
  if (source.split(/\r?\n/u).includes(DOCS_TREE_INPUT)) inputs.add('docs');
  // Plain text is the required conservative rule: syntax, comments, and escapes do not matter.
  // Keep the older literal-reader scan below as an additional conservative signal.
  if (source.includes('docs') && source.includes('.md')) {
    for (const doc of changedDocs) inputs.add(doc);
  }
  for (const doc of changedDocs) {
    const basename = posix.basename(doc).replace(/[.*+?^${}()|[\]\\]/gu, '\\$&');
    const wholeWord = new RegExp(`(?:^|[^\\p{L}\\p{M}\\p{N}_])${basename}(?:$|[^\\p{L}\\p{M}\\p{N}_])`, 'u');
    if (wholeWord.test(source)) inputs.add(doc);
  }
  const markdownReader = imports.some(target => target === 'node:fs' || target === 'node:fs/promises');
  const literals = /(['"])(?:\\[\s\S]|(?!\1)[^\\\r\n])*\1|`(?:\\[\s\S]|[^`\\])*`/uy;
  // Try every quote start: a quote in a comment or regular expression must not hide a later real path.
  for (const quote of source.matchAll(/['"`]/gu)) {
    literals.lastIndex = quote.index;
    const match = literals.exec(source);
    if (!match) continue;
    let values;
    if (match[0][0] === '`') {
      const raw = match[0].slice(1,-1);
      // Cook escape sequences only; never evaluate an interpolation. Keep raw text too for tags.
      const cooked = raw.replace(/\\(u\{[\da-fA-F]+\}|u[\da-fA-F]{4}|x[\da-fA-F]{2}|\r\n|[\s\S])/gu, (_, escape) => {
        if (/^u\{[\da-fA-F]+\}$/u.test(escape)) return String.fromCodePoint(parseInt(escape.slice(2,-1),16));
        if (/^(?:u[\da-fA-F]{4}|x[\da-fA-F]{2})$/u.test(escape)) return String.fromCharCode(parseInt(escape.slice(1),16));
        return ({ n:'\n', r:'\r', t:'\t', b:'\b', f:'\f', v:'\v', 0:'\0', '\n':'', '\r':'', '\r\n':'' })[escape] ?? escape;
      });
      values = [...new Set([raw,cooked])].map(text => {
        const rootDoc = /(?:^|\/)docs(?:\/|$)/u.exec(text);
        if (!rootDoc && text.includes('${') && text.endsWith('.md') && markdownReader) inputs.add('docs');
        return (rootDoc ? text.slice(rootDoc.index + (rootDoc[0].startsWith('/') ? 1 : 0)) : text).split('${',1)[0];
      });
    }
    else {
      // Only a complete quoted string matched above is evaluated, never a template or expression.
      try { values = [match[0].includes('\\') ? new Function(`return ${match[0]};`)() : match[0].slice(1,-1)]; }
      catch { continue; }
    }
    for (let value of values) {
      if (typeof value !== 'string') continue;
      value = value.split(/[?#]/u)[0].replace(/\/$/u,'');
      const embeddedRoot = /\/docs(?:\/|$)/u.exec(value);
      if (embeddedRoot) value = value.slice(embeddedRoot.index + 1);
      const wildcard = value.search(/[\*\[\{]/u);
      if (wildcard !== -1) value = value.slice(0,value.lastIndexOf('/',wildcard) + 1);
      if (value === '.md' && markdownReader) { inputs.add('docs'); continue; }
      if (!value) continue;
      const directoryReader = /\b(?:readdir|glob|opendir)/u.test(source);
      if (!value.includes('/') && !value.endsWith('.md') && value !== 'docs' && !directoryReader) continue;
      const prefix = value === 'docs' || value.endsWith('.md') ? source.slice(0,match.index).trimEnd() : '';
      if (/\.(?:startsWith|endsWith|includes|indexOf)\($/u.test(prefix)) continue;
      if (markdownReader && value.endsWith('.md') && !value.includes('docs/')
        && (/\+$/u.test(prefix) || /^\s*\+/u.test(source.slice(match.index + match[0].length)))) inputs.add('docs');
      // Bare "docs" is also a commit type or lane. In a call/path assignment, or a directory
      // scanner, it can name an input; a declaration of commit types alone is not a reader.
      const callArgument = /[,(]$/u.test(prefix) && prefix.lastIndexOf('(') > prefix.lastIndexOf('[');
      const joinedArray = prefix.lastIndexOf('[') > prefix.lastIndexOf(']')
        && /^[^\]]*\]\s*\.join\s*\(/u.test(source.slice(match.index + match[0].length));
      if (value === 'docs' && !callArgument && !joinedArray && !/(?<![=!<>])=$/u.test(prefix) && !directoryReader) continue;
      for (const candidate of [posix.normalize(value), posix.normalize(posix.join(posix.dirname(path),value))]) {
        if (candidate === 'docs' || candidate.startsWith('docs/')) inputs.add(candidate.replace(/\/$/u,''));
      }
    }
  }
  return inputs;
}
