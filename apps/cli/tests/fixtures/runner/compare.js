import { itemThread } from '../../../../../packages/store/index.js';

/** A test file whose two cases fail, and one whose only case fails; main's receipts name only "main case" as red. */
/** The cases the pulled gate compares. */
export const CASES = {
  'web/mixed.test.js': "import { test } from 'node:test';\ntest('main case', () => { throw new Error('main'); });\ntest('new case', () => { throw new Error('new'); });\n",
  'web/main.test.js': "import { test } from 'node:test';\ntest('main case', () => { throw new Error('main'); });\n",
};

/** The text of every fact on an item's thread. */
export function facts(board, id) {
  return itemThread(board, id).filter(entry => entry.type === 'fact').map(entry => entry.text ?? entry.fact?.text ?? '').join('\n');
}
