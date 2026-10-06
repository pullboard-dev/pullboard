/**
 * Products: named groups of spec rows, declared in pullboard.json beside the lanes (S11).
 *
 * Nothing stores which product a row, an item or a lane belongs to. It is read from the spec and
 * the config each time (S12), so changing a product's list moves everything that depends on it at
 * once, and no copy can drift.
 */

/** Spec statuses that leave a row out of a product's count: decided against, or no longer in force. */
const OUT_OF_FORCE = ['wont', 'retired'];

/**
 * True when a product's or a lane's entry names this spec id: the id itself and its sub-ids (N26
 * names N26 and N26.1), or a whole section by its letters (B names B1 to B16, not BX1).
 *
 * @param {string} entry
 * @param {string} id
 * @returns {boolean}
 */
export function names(entry, id) {
  if (/^[A-Za-z]+$/.test(entry)) return /^[A-Za-z]+/.exec(id)?.[0] === entry;
  return id === entry || id.startsWith(`${entry}.`);
}

/**
 * The spec ids an item cites.
 *
 * @param {any} item
 * @returns {string[]}
 */
const citedBy = (item) => (item.item_spec_ids ?? '').split(',').filter(Boolean);

/**
 * The products that name any of these spec ids, in the order pullboard.json declares them.
 *
 * @param {any} config
 * @param {string[]} ids
 * @returns {string[]}
 */
function productsNaming(config, ids) {
  return Object.entries(config.products ?? {})
    .filter(([, entries]) => ids.some((id) => entries.some((entry) => names(entry, id))))
    .map(([name]) => name);
}

/**
 * The products a spec row belongs to.
 *
 * @param {any} config
 * @param {string} id
 * @returns {string[]}
 */
export function productsOfRow(config, id) {
  return productsNaming(config, [id]);
}

/**
 * The products an item belongs to: those of the rows it cites.
 *
 * @param {any} config
 * @param {any} item
 * @returns {string[]}
 */
export function productsOfItem(config, item) {
  return productsNaming(config, citedBy(item));
}

/**
 * The products a lane works for: those that name a row the lane's own spec list names.
 *
 * @param {any} config
 * @param {{ rows: { id: string }[] }} spec
 * @param {string} lane
 * @returns {string[]}
 */
export function productsOfLane(config, spec, lane) {
  const entries = config.lanes?.[lane]?.specs ?? [];
  return productsNaming(config, spec.rows.filter((row) => entries.some((entry) => names(entry, row.id))).map((row) => row.id));
}

/**
 * Each product's standing: its rows in force, how many are approved, how many an accepted item
 * cites, and its items by state. Withdrawn items are left out.
 *
 * @param {any} config
 * @param {{ rows: { id: string, status: string }[] }} spec
 * @param {any[]} items - As the board lists them, with lapsed claims read as open.
 * @returns {{ name: string, rows: number, approved: number, proven: number, items: { open: number, claimed: number, submitted: number, verified: number } }[]}
 */
export function productSummaries(config, spec, items) {
  return Object.entries(config.products ?? {}).map(([name, entries]) => {
    const rows = spec.rows.filter((row) => !OUT_OF_FORCE.includes(row.status) && entries.some((entry) => names(entry, row.id)));
    const ids = new Set(rows.map((row) => row.id));
    const mine = items.filter((item) => citedBy(item).some((id) => ids.has(id)));
    const accepted = items.filter((item) => item.item_status === 'verified');
    const count = (state) => mine.filter((item) => item.item_status === state).length;
    return {
      name,
      rows: rows.length,
      approved: rows.filter((row) => row.status === 'approved').length,
      proven: rows.filter((row) => accepted.some((item) => citedBy(item).includes(row.id))).length,
      items: { open: count('open'), claimed: count('claimed'), submitted: count('submitted'), verified: count('verified') },
    };
  });
}

/**
 * Every entry in a product's list that names no row of the spec, so a typo cannot quietly leave
 * rows out of a product.
 *
 * @param {any} config
 * @param {{ rows: { id: string }[] }} spec
 * @returns {string[]}
 */
export function productProblems(config, spec) {
  return Object.entries(config.products ?? {}).flatMap(([name, entries]) =>
    entries.filter((entry) => !spec.rows.some((row) => names(entry, row.id))).map((entry) => `product "${name}": "${entry}" names no row in the spec`),
  );
}

/**
 * One product's standing as a line of text.
 *
 * @param {ReturnType<typeof productSummaries>[number]} product
 * @returns {string}
 */
export function productLine({ name, rows, approved, proven, items }) {
  return `product ${name}: ${rows} rows, ${approved} approved, ${proven} cited by accepted items; items ${items.open} open, ${items.claimed} building, ${items.submitted} awaiting verification, ${items.verified} verified`;
}
