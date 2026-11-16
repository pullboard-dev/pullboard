/**
 * How well the files an item was predicted to change matched the files its submissions changed.
 * Why: file leases are only as good as the prediction behind them, so the board reports the hit rate it has recorded.
 * A submit with a prediction and no `file_miss` event is a hit; claims.fileLease records the misses at submit.
 *
 * @param {Array<{ item_id: number|null, event_kind: string, event_detail: string }>} history every board event
 * @param {any[]} items every board item
 * @param {(item: any) => string[]} predict the files an item is predicted to change
 * @returns {{ predicted: number, missed: number, hit: number, accuracy: number|null, filesMissed: number, filesUnpredicted: number }}
 */
export function predictionAccuracy(history, items, predict) {
  const submitted = new Set(history.filter(event => event.event_kind === 'submit').map(event => event.item_id));
  const misses = new Map();
  for (const event of history.filter(row => row.event_kind === 'file_miss')) {
    const detail = JSON.parse(event.event_detail ?? '{}');
    const sum = misses.get(event.item_id) ?? { missed: 0, unpredicted: 0 };
    misses.set(event.item_id, { missed: sum.missed + (detail.missed?.length ?? 0), unpredicted: sum.unpredicted + (detail.unpredicted?.length ?? 0) });
  }
  const counted = items.filter(item => submitted.has(item.item_id) && predict(item).length > 0);
  const missed = counted.filter(item => misses.has(item.item_id));
  const total = (key) => missed.reduce((n, item) => n + misses.get(item.item_id)[key], 0);
  return { predicted: counted.length, missed: missed.length, hit: counted.length - missed.length,
    accuracy: counted.length ? (counted.length - missed.length) / counted.length : null,
    filesMissed: total('missed'), filesUnpredicted: total('unpredicted') };
}

/** One printed line for pullboard capacity; the unknown case says so rather than printing a zero. */
export function predictionLine(report) {
  if (!report.predicted) return 'file prediction: unknown, no submit with predicted files is recorded yet';
  return `file prediction: ${report.hit} of ${report.predicted} submits matched their predicted files (${(report.accuracy * 100).toFixed(0)}%); ${report.filesMissed} predicted files untouched, ${report.filesUnpredicted} changed files unpredicted`;
}
