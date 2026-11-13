/** The guards of a coordinator's named landing: one check run on the combined tree, a bisection when it is red [C7,#5559]. */
import { entriesTouching } from '../static.js';
import { mergeGroup } from './merge.js';
import { save } from './merge.js';

/** Whether a refusal is the static check going red on the merged tree: the only red a named landing can have. */
function staticRed(error) {
  return Boolean(error) && (error.code === 'LAND_STATIC_RED' || (error.code === 'GATE_RED' && /static checks are red/u.test(error.message)));
}

/**
 * Run the batch's guards once on the merged tree; when the static checks are red, set the culprits aside and guard the
 * green rest, so one bad item never stops the good ones. Resolves the green gate, null when no item is left, or `{ interaction: true }` when the green items are red together.
 *
 * How: a refusal naming files charges the items that changed them (entriesTouching); one that charges none, or all,
 * bisects by halves, each half re-merged and guarded on the runners, as the product's test bisection does. The green
 * set is merged and guarded whole at the end, and a red there with every part green is an interaction the caller refuses as LAND_INTERACTION.
 * Why: the checks run as runner jobs, so the coordinator only merges and swaps main; nothing scans the tree locally.
 *
 * @param {object} state - The landing state.
 * @param {Function} guards - quickGuards, passed in to keep this file free of an import cycle.
 */
export async function externalGuards(state, guards) {
  try { return await guards(state); } catch (error) {
    if (!staticRed(error) || state.batch.items.length < 2) throw error;
    state.say(`static checks are red on the combined tree; finding the item at fault: ${String(error.message).slice(0, 300)}`);
    const green = await sortOut(state, state.batch.items, error, guards, 'external-split');
    if (!green.length) return null;
    const rebuilt = await mergeGroup(state, green);
    await save(state, { ...rebuilt, culprits: state.culprits });
    try { return await guards(state, 'external-green-items'); } catch (again) {
      if (!staticRed(again)) throw again;
      await save(state, { state: 'blocked', culprits: state.culprits });
      return { interaction: true };
    }
  }
}

/** Record one named item as a culprit of the batch: it keeps its board status, since it was never verified here. */
async function setAside(state, entry, error) {
  if (!state.culprits.some(culprit => culprit.id === entry.id)) {
    state.culprits.push({ id: entry.id, commit: entry.commit, mergeCommit: state.batch.tip,
      tests: [{ file: error.rows?.[0]?.file ?? null, name: String(error.message).slice(0, 200) }] });
  }
  await save(state, { culprits: state.culprits });
  state.say(`culprit #${entry.id}: ${String(error.message).slice(0, 200)}`);
}

/** The items of `items` that pass the static checks, with the rest recorded as culprits. */
async function sortOut(state, items, error, guards, label) {
  if (items.length === 1) { await setAside(state, items[0], error); return []; }
  const charged = error.files?.length ? entriesTouching(state.batch.root, state.batch.base, items, error.files) : [];
  if (charged.length && charged.length < items.length) {
    for (const entry of charged) await setAside(state, entry, error);
    return items.filter(entry => !charged.includes(entry));
  }
  const middle = Math.ceil(items.length / 2);
  const green = [];
  for (const [index, part] of [items.slice(0, middle), items.slice(middle)].entries()) {
    const build = await mergeGroup(state, part);
    await save(state, { ...build, state: 'bisecting' });
    try { await guards(state, `${label}-${index}`); green.push(...build.items); } catch (partError) {
      if (!staticRed(partError)) throw partError;
      green.push(...await sortOut(state, build.items, partError, guards, `${label}-${index}`));
    }
  }
  return green;
}
