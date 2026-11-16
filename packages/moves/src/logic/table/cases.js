/** A generated-test kit for move tables: seeded cases, row coverage, refusal invariants and metamorphic breaks [C7,#8066]. */
import { Refused } from '../../../../kernel/light.js';
import { runTable } from './run.js';

/**
 * A small seeded generator (mulberry32): the same seed gives the same cases, with no clock and no Math.random.
 *
 * @param {number} seed
 * @returns {{ rand: () => number, int: (n: number) => number, pick: <T>(list: T[]) => T }}
 */
export function seeded(seed) {
  let state = seed >>> 0;
  const rand = () => {
    state = (state + 0x6D2B79F5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
  return { rand, int: (n) => Math.floor(rand() * n), pick: (list) => list[Math.floor(rand() * list.length)] };
}

/**
 * Run `count` generated cases through a table and report what they prove.
 * `generate(g, index)` returns `{ snapshot, move, breaks? }`; `breaks` maps a fact name to a pure function that
 * returns a `{ snapshot, move }` where that fact fails.
 * Why: a row no generated case reaches is untested, and a refusal that still writes is the worst kind of bug.
 *
 * @param {import('./run.js').MoveTable} table
 * @param {Readonly<Record<string, object>>} rules - From defineRules.
 * @param {(g: ReturnType<typeof seeded>, index: number) => { snapshot: object, move: object, breaks?: Record<string, Function> }} generate
 * @param {{ seed: number, count: number, run?: typeof runTable }} options - `run` defaults to the engine; a test passes a faulty one to prove the checks bite.
 * @returns {{ cases: number, unreached: { guards: string[], outcomes: string[], followups: string[] }, writingRefusals: { index: number, row: string | null }[], unbroken: { index: number, fact: string }[] }}
 */
export function tableCases(table, rules, generate, { seed, count, run = runTable }) {
  const g = seeded(seed);
  const guards = new Set(), outcomes = new Set(), followups = new Set();
  const writingRefusals = [], unbroken = [];
  const required = new Set(table.guards.map(guard => guard.requires));
  for (let index = 0; index < count; index++) {
    const made = generate(g, index);
    const result = run(table, rules, structuredClone(made.snapshot), made.move);
    if (result.refused) {
      guards.add(result.refused.row);
      if ('patch' in result || 'events' in result) writingRefusals.push({ index, row: result.refused.row });
      continue;
    }
    outcomes.add(result.via[0]);
    for (const id of result.via.slice(1)) followups.add(id);
    for (const fact of Object.keys(made.breaks ?? {})) {
      if (!required.has(fact)) continue;
      const broken = breakOne(made, fact);
      if (!run(table, rules, broken.snapshot, broken.move).refused) unbroken.push({ index, fact });
    }
  }
  const missing = (rows, seen) => rows.map(row => row.id).filter(id => !seen.has(id));
  return { cases: count, unreached: { guards: missing(table.guards, guards), outcomes: missing(table.outcomes, outcomes), followups: missing(table.followups ?? [], followups) }, writingRefusals, unbroken };
}

/**
 * Turn a valid case into one where `fact` fails, on a copy; the original case is untouched.
 * When a guard requires that fact the broken case refuses; when none does, the outcome still stands.
 *
 * @param {{ snapshot: object, move: object, breaks?: Record<string, Function> }} made
 * @param {string} fact
 * @returns {{ snapshot: object, move: object, broken: string }}
 */
export function breakOne(made, fact) {
  const breaker = made.breaks?.[fact];
  if (typeof breaker !== 'function') throw new Refused('CASE_UNBREAKABLE', `case has no way to break fact ${fact}`, `give the generated case a breaks.${fact} function`);
  const { snapshot, move } = breaker(structuredClone(made.snapshot), structuredClone(made.move));
  return { snapshot, move, broken: fact };
}
