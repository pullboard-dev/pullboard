/** The pair check for engine floors: a move that mixes two feature options takes the larger floor [C7,V4,H16,#9670]. */
import { minimumMoveEngine } from '../../../../../../packages/moves/index.js';

/** True for a plain object, the shape of a move's options argument. */
function isOptions(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

/** Merge two option objects, descending into nested plain objects so `receipt` or `batch` keep both options' keys. */
function mergeOptions(first, second) {
  const merged = { ...first };
  for (const [key, value] of Object.entries(second)) {
    merged[key] = isOptions(value) && isOptions(first[key]) ? mergeOptions(first[key], value) : value;
  }
  return merged;
}

/**
 * Combine two options' arguments slot by slot: option objects merge (nested objects too), any other slot keeps the
 * first one's value.
 * Why: a real move carries both options at once, so the registry sees one argument list.
 */
export function combineArgs(first, second) {
  const length = Math.max(first.length, second.length);
  return Array.from({ length }, (_, slot) => (isOptions(first[slot]) && isOptions(second[slot])
    ? mergeOptions(first[slot], second[slot]) : first[slot] ?? second[slot]));
}

/** The name of a pair, in a stable order, as the allow-list spells it. */
export function pairName(first, second) {
  return [first.name, second.name].sort().join(' + ');
}

/**
 * Every pair of a move's feature options whose combined engine floor is below the larger of the two floors.
 * Options that need board state (`board` set) are listed in the table but cannot be combined here; options in one
 * `group` exclude each other (they set the same field), so they are never combined.
 *
 * @param {{ move: string, options: Array<{ name: string, args: unknown[], floor: number, group?: string, board?: string }> }} table One move's trigger table.
 * @param {(move: string, args: unknown[]) => number} [floorOf] The floor the registry gives a move and arguments, replaceable to test the check on a toy.
 * @returns {string[]} One line per failing pair, naming both options and the floors seen.
 */
export function floorPairProblems(table, floorOf = (move, args) => minimumMoveEngine(move, args, null, undefined)) {
  const problems = [];
  const options = table.options.filter(option => !option.board);
  for (let first = 0; first < options.length; first += 1) {
    for (let second = first + 1; second < options.length; second += 1) {
      const [a, b] = [options[first], options[second]];
      if (a.group !== undefined && a.group === b.group) continue;
      const wanted = Math.max(a.floor, b.floor);
      const got = floorOf(table.move, combineArgs(a.args, b.args));
      if (got < wanted) problems.push(`${table.move}: ${pairName(a, b)} yields ${got}, below the larger floor ${wanted}`);
    }
  }
  return problems;
}

/** Every option that, alone, yields a floor other than the one the table lists for it. */
export function floorAloneProblems(table) {
  return table.options.filter(option => !option.board).flatMap(option => {
    const got = minimumMoveEngine(table.move, option.args, null, undefined);
    return got === option.floor ? [] : [`${table.move}: ${option.name} alone yields ${got}, the table lists ${option.floor}`];
  });
}
