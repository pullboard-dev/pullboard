/** A land job's green static checks carried across push attempts while trunk's new commits miss the batch's files, behind landing.reofferTrunkBusy [C7,#9103]. */
import { tryGit } from '../../../../git/index.js';

/**
 * The files that differ between two commits, or null when git cannot say.
 *
 * @param {string} root
 * @param {string} from
 * @param {string} to
 * @returns {string[] | null}
 */
function changedFiles(root, from, to) {
  const listed = tryGit(root, ['diff', '--name-only', '--no-renames', from, to]);
  return listed.status === 0 ? listed.stdout.split('\n').filter(Boolean) : null;
}

/**
 * A static-check runner that remembers its last green: when a later attempt checks the same items on a new trunk tip,
 * and the commits trunk gained since touch none of the files the batch's merge changed, the earlier green stands and
 * the checks do not run again. Off (the default) it runs the checks every attempt, as before.
 * Why: the static checks took 84-112 s on each of 5 attempts while trunk moved under every one (land:9000, 16 Nov).
 *
 * @param {{ enabled?: boolean }} [options] - enabled: the job's payload carried landing.reofferTrunkBusy.
 * @returns {(context: { root: string, base: string, items: number[] }, run: (context: object) => Promise<any> | any) => Promise<any>}
 */
export function staticCarry({ enabled = false } = {}) {
  let green = null;
  return async (context, run) => {
    if (!enabled) return run(context);
    const items = [...context.items].sort((a, b) => a - b).join(',');
    if (green && green.items === items && green.base !== context.base) {
      const moved = changedFiles(context.root, green.base, context.base);
      if (moved && !moved.some(file => green.touched.has(file))) {
        green = { ...green, base: context.base };
        return { ok: true, detail: null, carried: true };
      }
    }
    const result = await run(context);
    const touched = result?.ok ? changedFiles(context.root, context.base, 'HEAD') : null;
    green = touched ? { items, base: context.base, touched: new Set(touched) } : null;
    return result;
  };
}
