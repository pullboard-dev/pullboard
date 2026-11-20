/** The test-input header rules, pure over a file's text: which header declares a test's inputs and what counts as a read [D1,C7,V4,#10084]. */

export const SOURCE_TREE_INPUT = '/** @pullboard-test-input source-tree */';
export const DECLARATIONS = new Set([SOURCE_TREE_INPUT, '// pullboard: browser', '/** @pullboard-test-input test-tree */', '/** @pullboard-test-input docs-tree */']);
export const READ = /(?<![\w$])(?:readFileSync|readFile|readdirSync|readdir|opendirSync|opendir|createReadStream|cpSync|cp|copyFileSync|copyFile)\s*\(/u;
// A header naming the exact files a test reads, such as `/** @pullboard-test-input packages/gate/src/io/run/slots.js */`, also declares it.
export const NAMED_INPUTS = /^\/\*\* @pullboard-test-input (?!source-tree \*\/$)\S.* \*\/$/u;
const SOURCE_CELL_LINE = /^\/\*\* @pullboard-test-input source-cell((?:\s+[\w.-]+(?:\/[\w.-]+)?)+)\s*\*\/$/u;

/**
 * The cells a header line names, `/** @pullboard-test-input source-cell gate *\/`, as path prefixes; null when the line is
 * not a source-cell line. A cell is `packages/<name>`, `apps/<name>` or a bare name that means either. A test that names
 * cells reads only those cells' source, so a change elsewhere leaves it alone [C7].
 */
export function sourceCellPrefixes(line) {
  const match = SOURCE_CELL_LINE.exec(line.trim());
  if (!match) return null;
  return match[1].trim().split(/\s+/u).flatMap(cell => (cell.includes('/') ? [cell] : [`packages/${cell}`, `apps/${cell}`])).map(cell => `${cell}/`);
}

/** True when a header line starts a source-cell declaration, well formed or not. */
export function isSourceCellLine(line) {
  return /^\/\*\* @pullboard-test-input source-cell(?:\s|\*)/u.test(line.trim());
}

/**
 * True when the file's leading declaration lines include the source-tree input, read as the
 * affected-test selection reads them.
 *
 * @param {string} source
 * @returns {boolean}
 */
export function declaresSource(source) {
  for (const line of source.split(/\r?\n/u)) {
    if (line === SOURCE_TREE_INPUT) return true;
    if (isSourceCellLine(line)) { if (sourceCellPrefixes(line) === null) return false; return true; }
    if (NAMED_INPUTS.test(line)) return true;
    if (!DECLARATIONS.has(line)) return false;
  }
  return false;
}

/** A repo path the exact rule holds to a header: a cell's data, tests (the folder itself included) or journeys folder, or docs [C7,#12055]. */
export const DECLARED_READ_PATH = /^(?:(?:packages|apps)\/[^/]+\/(?:data|tests|journeys)|docs)(?:\/|$)/u;

/**
 * The patterns a test's leading header lines declare it reads, as regular expressions over repo paths. A source-cell line
 * and source-tree name source, never a data, tests or journeys path, and a bare `**` names nothing exact, so none of them
 * counts; docs-tree covers docs and test-tree covers every cell's tests and journeys folders [C7,#12055].
 *
 * @param {string} source
 * @returns {RegExp[]}
 */
export function declaredReadPatterns(source) {
  const patterns = [];
  for (const line of source.split(/\r?\n/u)) {
    if (line === '// pullboard: browser') continue;
    if (!line.startsWith('/** @pullboard-')) break;
    const match = /^\/\*\* @pullboard-test-input (.+?) \*\/$/u.exec(line.trim());
    if (!match || isSourceCellLine(line)) continue;
    for (const value of match[1].trim().split(/\s+/u)) {
      if (value === 'source-tree' || value === '**') continue;
      if (value === 'docs-tree') patterns.push(/^docs(?:\/|$)/u);
      else if (value === 'test-tree') patterns.push(/^(?:packages|apps)\/[^/]+\/(?:tests|journeys)(?:\/|$)/u);
      else patterns.push(globExpression(value));
    }
  }
  return patterns;
}

/** A header glob as an expression: `**` spans folders, `*` stays inside one. */
function globExpression(glob) {
  let text = '';
  for (let at = 0; at < glob.length; at += 1) {
    if (glob.startsWith('**', at)) { text += '.*'; at += 1; }
    else if (glob[at] === '*') text += '[^/]*';
    else text += glob[at].replace(/[.+?^${}()|[\]\\]/gu, '\\$&');
  }
  return new RegExp(`^${text}$`, 'u');
}

/**
 * True when the declared patterns cover a read of `path`: the path itself, or for a folder read everything under it. A path
 * that escapes the repository is compared by its tail, so `../tests/fixtures/a.json` needs a header ending in it.
 */
export function readIsDeclared(patterns, path) {
  if (path.startsWith('../')) {
    const tail = path.replace(/^(?:\.\.\/)+/u, '');
    return patterns.some(pattern => pattern.test(tail) || pattern.source.replace(/\\/gu, '').endsWith(`/${tail}$`));
  }
  return patterns.some(pattern => pattern.test(path) || pattern.test(`${path}/\0`));
}
