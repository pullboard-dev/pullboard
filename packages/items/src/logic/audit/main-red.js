/** The statuses in which a repair still owns its cause. */
const PENDING = new Set(['open', 'claimed', 'submitted', 'verified']);

/**
 * The root cause a failure row records: a stable frame, or a specific first error, else the file alone.
 * Why: only evidence with a recorded cause may group failures; the rest stay apart by file.
 */
export function mainRedRootCause(row) {
  if (typeof row.stable === 'string' && row.stable.trim()) return `frame:${row.stable}`;
  const error = typeof row.firstError === 'string' ? row.firstError.trim() : '';
  if (error && !/^(?:expected values|assertionerror|error|\[redacted error\])/iu.test(error)) return `error:${error}`;
  return `file:${row.file}`;
}

/**
 * The one cause key every Main red filer uses: the test file and case, or the root cause when a cluster names one.
 * Why: titles differ per filer and per cause, so the same red filed again and again; the key does not.
 */
export function mainRedKey({ file, name = '', cause = null }) {
  const clean = value => String(value).replace(/\s+/gu, ' ').trim().slice(0, 300);
  return cause && !cause.startsWith('file:') ? `cause:${clean(cause)}` : `case:${clean(file)} :: ${clean(name)}`;
}

/** The brief lines that stamp an item with the keys it repairs, for later filings to find. */
export function mainRedKeyLines(rows) {
  return [...new Set(rows.map(row => `Cause: ${mainRedKey(row)}`))].join('\n');
}

/** Whether a pending item already repairs this cause: by its stamped key, or for older items by file title and case text. */
function repairs(item, row, key) {
  if (item.item_merged_commit || !PENDING.has(item.item_status)) return false;
  if (String(item.item_brief ?? '').split('\n').includes(`Cause: ${key}`)) return true;
  const title = String(item.item_title ?? '');
  if (title === `Main red: ${row.file}` && !String(item.item_brief ?? '').includes('Cause: ')) return !row.name || String(item.item_criterion ?? '').includes(row.name);
  return title.startsWith('Main red: scheduled audit (') && title.includes(row.file) && (!row.name || String(item.item_criterion ?? '').includes(row.name));
}

/**
 * Split failure rows into those a pending repair already owns and those that need an item of their own.
 *
 * @param {object[]} items - Board items.
 * @param {Array<{file: string, name?: string, cause?: string}>} rows
 * @returns {{ owned: Map<number, object[]>, fresh: object[] }} Rows by owning item id, and rows nobody owns.
 */
export function splitMainReds(items, rows) {
  const owned = new Map(), fresh = [];
  for (const row of rows) {
    const key = mainRedKey(row);
    const owner = items.find(item => repairs(item, row, key));
    if (owner) owned.set(owner.item_id, [...(owned.get(owner.item_id) ?? []), row]);
    else fresh.push(row);
  }
  return { owned, fresh };
}

/** The fact a repeat red adds to its open repair. */
export function mainRedFact(rows, source) {
  return `Red again: ${rows.map(row => `${row.file}${row.name ? ` :: ${row.name}` : ''}`).join('; ')}. ${source}`.slice(0, 2000);
}

/**
 * File Main red rows through one door: rows a pending repair owns get a fact on it, the rest get one new item.
 *
 * @param {{ items: object[], rows: object[], source: string, addFact: (id: number, text: string) => any, create: (rows: object[]) => any }} filing
 * @returns {Promise<{ facts: number[], created: any }>}
 */
export async function fileMainRed({ items, rows, source, addFact, create }) {
  const { owned, fresh } = splitMainReds(items, rows);
  for (const [id, owning] of owned) await addFact(id, mainRedFact(owning, source));
  return { facts: [...owned.keys()], created: fresh.length ? await create(fresh) : null };
}
