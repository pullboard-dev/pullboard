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
