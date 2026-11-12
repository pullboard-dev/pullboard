/** Runner job priority classes and the reserve each keeps of a runner's slots: which open job a claim takes first [C7]. */


/** The classes, highest first: an agent's own run, then gates, then landings, then sweeps. */
export const JOB_CLASSES = Object.freeze(['interactive', 'gate', 'landing', 'background']);

/** The class a job offered without one is read as. */
export const DEFAULT_JOB_CLASS = 'gate';

/**
 * The slots each class keeps on a runner of this many slots: a share above 0 keeps at least one slot, so a class with
 * a reserve always progresses. Why at least one: a 0.1 share of a 4-slot runner would otherwise round to none.
 *
 * @param {Record<string, number>} reserve - share of the runner's slots per class, 0 through 1.
 * @param {number} slots
 * @returns {Record<string, number>}
 */
export function reservedSlots(reserve, slots) {
  return Object.fromEntries(JOB_CLASSES.map(name => {
    const share = Number(reserve?.[name] ?? 0);
    return [name, share > 0 ? Math.max(1, Math.floor(share * slots)) : 0];
  }));
}

/**
 * Order the open jobs a runner may take: highest class first, then oldest. When the runner's free slots no longer
 * exceed what the classes still owed their reserve need, only those owed classes may take the slot, so a full runner
 * never starves a class that has a reserve and queued work.
 *
 * @template {{ priority: string }} T
 * @param {T[]} open - Jobs this runner can run, oldest first.
 * @param {{ reserve: Record<string, number>, slots: number | null, held: Record<string, number> }} runner - held: jobs it holds now, by class.
 * @returns {T[]}
 */
export function claimOrder(open, { reserve, slots, held }) {
  const rank = job => JOB_CLASSES.indexOf(job.priority);
  const ordered = [...open].sort((a, b) => rank(a) - rank(b));
  if (!Number.isSafeInteger(slots) || slots < 1) return ordered;
  const kept = reservedSlots(reserve, slots);
  const waiting = new Set(open.map(job => job.priority));
  const owed = JOB_CLASSES.filter(name => waiting.has(name) && (held[name] ?? 0) < kept[name]);
  const need = owed.reduce((sum, name) => sum + kept[name] - (held[name] ?? 0), 0);
  const free = slots - JOB_CLASSES.reduce((sum, name) => sum + (held[name] ?? 0), 0);
  return owed.length && free <= need ? ordered.filter(job => owed.includes(job.priority)) : ordered;
}
