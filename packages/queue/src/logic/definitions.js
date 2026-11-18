import { Refused } from '../../../kernel/browser.js';

/** Board-owned controller inputs; false means off, independently of machine gate settings. */
export const LINE_SETTING_DEFINITIONS = Object.freeze({
  'route.liveOnly': Object.freeze({ type: 'boolean' }),
  returnRejectedWork: Object.freeze({ type: 'boolean' }),
  reworkSameFamily: Object.freeze({ type: 'boolean' }),
  order: Object.freeze({ type: 'boolean' }),
  agingMinutes: Object.freeze({ type: 'number', min: 1, max: 10080, integer: false }),
  focusMilestone: Object.freeze({ type: 'milestone' }),
  reviewsFirst: Object.freeze({ type: 'boolean' }),
  requireReviewFamilies: Object.freeze({ type: 'boolean' }),
  wipPerReviewer: Object.freeze({ type: 'number', min: 1.5, max: 3, integer: false }),
  barReady: Object.freeze({ type: 'boolean' }),
  'bar.check': Object.freeze({ type: 'boolean' }),
  'bar.dryRunReview': Object.freeze({ type: 'boolean', arms: Object.freeze(['ab']) }),
  'bar.sharpenToPerson': Object.freeze({ type: 'boolean' }),
  takeoverMinutes: Object.freeze({ type: 'number', min: 15, max: 60, integer: true }),
  collisionFreeBatch: Object.freeze({ type: 'boolean' }),
  landingBatchSize: Object.freeze({ type: 'number', min: 1, max: 8, integer: true }),
  landingCadenceMinutes: Object.freeze({ type: 'number', min: 5, max: 30, integer: true }),
});

/** Validate a value after the caller establishes its key belongs to the shared registry. */
export function validateKnownLineSetting(key, value) {
  const definition = LINE_SETTING_DEFINITIONS[key];
  if (value === false || definition.type === 'boolean' && value === true) return;
  if (definition.arms?.includes(value)) return;
  if (definition.type === 'milestone' && typeof value === 'string' && value.trim() === value && value.length > 0 && !/[\r\n]/u.test(value)) return;
  if (definition.type === 'milestone' && value && typeof value === 'object' && !Array.isArray(value)
    && Object.keys(value).length === 2 && typeof value.name === 'string' && value.name.trim() === value.name
    && value.name.length > 0 && !/[\r\n]/u.test(value.name) && typeof value.overflow === 'boolean') return;
  if (definition.type === 'number' && typeof value === 'number' && Number.isFinite(value)
    && value >= definition.min && value <= definition.max && (!definition.integer || Number.isSafeInteger(value))) return;
  throw new Refused('LINE_SETTING_RANGE', `${key} accepts off or ${definition.type === 'boolean' ? ['on', ...(definition.arms ?? [])].join(' or ') : definition.type === 'milestone' ? 'a milestone name' : `${definition.integer ? 'whole numbers ' : 'numbers '}${definition.min} to ${definition.max}`}; read pullboard settings line`);
}
