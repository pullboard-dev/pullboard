/** The lines `pullboard show` prints from the item row alone, kept pure so a thin door can print them without the heavy readers [C7]. */

/**
 * The item row's printed lines, in the order show prints them (other sections sit between them, so each comes back named).
 *
 * @param {any} item the board's item row
 * @param {{ itemLine: string, checkText?: string }} facts the item line the caller formatted, and the check text the full path chose (frozen or live)
 * @returns {{ item: string, expectedBuild: string | null, criterion: string | null, check: string[] }}
 */
export function coreLines(item, { itemLine, checkText = '' }) {
  return {
    item: itemLine,
    expectedBuild: item.item_expected_build_minutes != null ? `expected build: ${item.item_expected_build_minutes} min` : null,
    criterion: item.item_criterion ? `criterion: ${item.item_criterion}` : null,
    check: checkText ? [`check: ${checkText}`, ...(item.item_frozen_digest ? [`check digest: ${item.item_frozen_digest}`] : [])] : [],
  };
}

/**
 * The reservation line for an item, or null: printed only while route.reservations is on and the item holds a reservation (#9178).
 *
 * @param {any} item the board's item row
 * @param {boolean} on whether route.reservations is on
 * @returns {string | null}
 */
export function reservationLine(item, on) {
  if (!on || !item.item_reservation_holder) return null;
  return `reserved for ${item.item_reservation_holder}${item.item_reservation_by ? ` by ${item.item_reservation_by}` : ''}${item.item_reservation_at ? ` at ${item.item_reservation_at}` : ''}`;
}
