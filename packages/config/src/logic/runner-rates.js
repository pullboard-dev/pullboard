/** A runner's rate card: what it cost, how long to pay it off, and what it draws, stored in machine settings [C7]. */
import { Refused } from '../../../kernel/light.js';

/** The card's fields: name, plain label for refusals, and the rule each value must meet. */
const FIELDS = [
  ['price', 'purchase price', value => value >= 0],
  ['months', 'months to pay off', value => Number.isSafeInteger(value) && value >= 1],
  ['watts', 'load watts', value => value >= 0],
  ['kwhPrice', 'power price per kWh', value => value >= 0],
];

/**
 * Check one rate card and return it with only its four fields, or refuse naming the field to fix.
 * Why: a later cost figure is only as honest as its inputs, so a bad or partial card never reaches it.
 *
 * @param {unknown} card
 * @param {string} [host] the runner the card belongs to, for the refusal text
 * @returns {{ price: number, months: number, watts: number, kwhPrice: number }}
 */
export function parseRunnerRate(card, host = 'this runner') {
  if (!card || typeof card !== 'object' || Array.isArray(card)) {
    throw new Refused('BAD_RUNNER_RATES', `the rate card for ${host} must be an object with price, months, watts and kwhPrice`, 'set { "price": 0, "months": 36, "watts": 0, "kwhPrice": 0 } with your numbers, or remove the card');
  }
  const parsed = {};
  for (const [name, label, valid] of FIELDS) {
    const value = card[name];
    if (typeof value !== 'number' || !Number.isFinite(value) || !valid(value)) {
      throw new Refused('BAD_RUNNER_RATES', `${name} (${label}) in the rate card for ${host} is missing or not a valid number`, `set ${name} to ${name === 'months' ? 'a whole number of 1 or more' : 'a number of 0 or more'}`);
    }
    parsed[name] = value;
  }
  return parsed;
}

/**
 * Check a whole `runnerRates` setting: a map from a runner host to its rate card.
 *
 * @param {unknown} rates
 * @returns {Record<string, { price: number, months: number, watts: number, kwhPrice: number }>}
 */
export function validateRunnerRates(rates) {
  if (rates === undefined) return {};
  if (!rates || typeof rates !== 'object' || Array.isArray(rates)) {
    throw new Refused('BAD_RUNNER_RATES', 'runnerRates must map each runner host to its rate card', 'use { "<host>": { "price": …, "months": …, "watts": …, "kwhPrice": … } } or remove runnerRates');
  }
  return Object.fromEntries(Object.entries(rates).map(([host, card]) => [host, parseRunnerRate(card, host)]));
}

/**
 * Read one runner's card back, or null when none is set.
 *
 * @param {unknown} rates the runnerRates setting
 * @param {string} host
 * @returns {{ price: number, months: number, watts: number, kwhPrice: number } | null}
 */
export function runnerRate(rates, host) {
  const card = rates && typeof rates === 'object' && Object.hasOwn(rates, host) ? rates[host] : undefined;
  return card === undefined ? null : parseRunnerRate(card, host);
}

/** Minutes in one payoff month: a 30-day month, so a card's price spreads evenly over its life. */
const MINUTES_PER_MONTH = 30 * 24 * 60;

/**
 * What one runner minute costs: the purchase price over its payoff minutes, plus the power it draws.
 * Why: a plain per-minute figure lets a runner minute be compared with any other cost of a minute.
 *
 * @param {unknown} card a rate card (checked with parseRunnerRate)
 * @param {string} [host] the runner the card belongs to, for refusal text
 * @returns {number} cost per minute, in the card's price unit
 */
export function costPerMinute(card, host = 'this runner') {
  const { price, months, watts, kwhPrice } = parseRunnerRate(card, host);
  return price / (months * MINUTES_PER_MONTH) + (watts / 1000) * kwhPrice / 60;
}
