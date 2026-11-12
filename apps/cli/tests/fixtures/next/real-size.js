/** A real-size board for `next`: 230,000 events, 1,800 agents, open build and review items [N2]. */
export const REAL_SIZE = Object.freeze({ events: 230_000, agents: 1_800, buildItems: 400, reviewItems: 200 });

/**
 * Seed a fixture board with the real production shape, deterministically.
 * One transaction and prepared statements keep it under a minute; no randomness, so the same seed gives the same board.
 * @param {{board: {db: import('node:sqlite').DatabaseSync}}} box a fixture() box.
 * @returns {{events: number, agents: number, buildItems: number, reviewItems: number}} counts seeded.
 */
export function seedRealSize(box) {
  const { db } = box.board;
  const at = '2026-10-01T00:00:00.000Z';
  const agent = db.prepare(`INSERT INTO agent (agent_id, agent_lane, agent_path, agent_route, agent_family, agent_created_at)
    VALUES (?, ?, ?, ?, ?, ?)`);
  const item = db.prepare(`INSERT INTO item (item_lane, item_title, item_criterion, item_route, item_created_by, item_created_at, item_updated_at)
    VALUES (?, ?, 'The real fixture succeeds.', ?, 'coordinator', ?, ?)`);
  const event = db.prepare('INSERT INTO event (event_at, event_by, event_kind, item_id, event_detail) VALUES (?, ?, ?, ?, ?)');
  const lanes = ['web', 'core', 'docs', 'review'];
  const routes = ['light', 'mid', 'strong'];
  const families = ['Family Alpha', 'Family Beta', 'Family Gamma'];
  db.exec('BEGIN');
  try {
    for (let n = 0; n < REAL_SIZE.agents; n++) {
      agent.run(`real-${n}`, lanes[n % lanes.length], `/real-size/seat-${n}`, routes[n % routes.length], families[n % families.length], at);
    }
    const ids = [];
    for (let n = 0; n < REAL_SIZE.buildItems; n++) {
      ids.push(Number(item.run(lanes[n % 3], `Real build ${n}`, routes[n % routes.length], at, at).lastInsertRowid));
    }
    for (let n = 0; n < REAL_SIZE.reviewItems; n++) {
      // The board files an item open and only moveItem changes its status, so review work is open items in the review lane.
      ids.push(Number(item.run('review', `Real review ${n}`, routes[n % routes.length], at, at).lastInsertRowid));
    }
    for (let n = 0; n < REAL_SIZE.events; n++) {
      event.run(at, `real-${n % REAL_SIZE.agents}`, 'edit', ids[n % ids.length], '{}');
    }
    db.exec('COMMIT');
  } catch (error) { db.exec('ROLLBACK'); throw error; }
  return { events: REAL_SIZE.events, agents: REAL_SIZE.agents, buildItems: REAL_SIZE.buildItems, reviewItems: REAL_SIZE.reviewItems };
}
