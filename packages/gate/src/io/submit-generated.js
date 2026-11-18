/** Submit's generated-file stage: runs the declared generator of each stale generated file, listed only when submit.regenerateDeclared is on [C7]. */
import { staleGeneratedFiles } from '../../../config/index.js';
import { git } from '../../../git/index.js';
import { tryGit } from '../../../git/index.js';
import { runShell } from './run/shell.js';

/**
 * Regenerate the declared generated files a submit's diff makes stale, in the composed tree at HEAD, and commit what changed.
 * Nothing runs, and git is untouched, when submit.regenerateDeclared is off or no declared input changed. Why: a builder who
 * edits a generator's input should not also have to remember to rerun it, and the result must be in the proved commit [C7].
 *
 * @param {string} root - The clean checkout whose HEAD is the composed tree.
 * @param {{ submit?: { regenerateDeclared?: boolean }, generated?: { file: string, generator: string, inputs: string[] }[] }} config
 * @param {{ base: string, item?: number }} range - The claim head the diff starts from, and the item the commit cites.
 * @returns {{ commit: string, files: string[] } | null} The new head and the files it regenerated; null when nothing changed.
 */
export function regenerateDeclaredFiles(root, config, { base, item = null }) {
  if (config.submit?.regenerateDeclared !== true || !base) return null;
  const changed = tryGit(root, ['diff', '--name-only', `${base}..HEAD`]).stdout.split('\n').filter(Boolean);
  const stale = staleGeneratedFiles(config.generated, changed);
  if (!stale.length) return null;
  for (const entry of stale) {
    const ran = runShell(root, entry.generator);
    if (!ran.isGreen) throw new Error(`the generator for ${entry.file} failed: ${String(ran.output).slice(-400)}`);
  }
  const files = stale.map(entry => entry.file).filter(file => tryGit(root, ['status', '--porcelain', '--', file]).stdout.trim() !== '');
  if (!files.length) return null;
  git(root, ['add', '--', ...files]);
  // Plumbing, so the builder's lane hook (which judges handwritten commits) does not refuse a regenerated file [C7].
  const tree = git(root, ['write-tree']);
  const message = `chore(core): regenerate ${files.join(' ').slice(0, 40)}${item ? `\n\nPullboard-Item: #${item}` : ''}\n`;
  const commit = git(root, ['commit-tree', tree, '-p', 'HEAD', '-m', message]);
  git(root, ['update-ref', 'HEAD', commit]);
  return { commit, files };
}
