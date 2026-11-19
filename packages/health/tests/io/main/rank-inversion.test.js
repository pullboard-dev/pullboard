/** A claim the coordinator reserved or held is not a rank inversion: the sentinel scan skips it [C7,#1479]. */
import assert from "node:assert/strict";
import { test } from "node:test";
import { CELL_CONFIG } from "../../../../store/tests/fixtures/cell.js";
import { cellBoard } from "../../../../store/tests/fixtures/cell.js";
import { cellClaim } from "../../../../store/tests/fixtures/cell.js";
import { cellItem } from "../../../../store/tests/fixtures/cell.js";
import { cellRepo } from "../../../../store/tests/fixtures/cell.js";
import { cellSeat } from "../../../../store/tests/fixtures/cell.js";
import { reserveItem } from "../../../../store/index.js";
import { healthReport } from "../../../index.js";

test("health.io-main-rank-inversion.reserved-or-held-claim-is-skipped: clause 1: healthReport raises no RANK_INVERSION for a live claim whose item has item_reservation_holder set or a hold reason, while the same board without either still raises it [C7,#1479]", t => {
  const repo = cellRepo(t);
  const board = cellBoard(t, repo.boardFile);
  const seat = cellSeat(board, { lane: "web", path: "/fixture/web-1", family: "claude" });
  const file = name => ({ lane: "web", title: name, criterion: "1. The fixture holds [command]", check: "true", brief: `Files: web/${name}.js\nTest: the sentinel scan reads the live queue.` });
  const ahead = cellItem(board, file("ahead")).item_id;
  const claimed = cellItem(board, file("claimed")).item_id;
  cellClaim(board, claimed, seat, { root: repo.root });
  const scan = () => healthReport({ db: board.db, root: repo.root, config: CELL_CONFIG, now: board.clock.now(), dispatchHealth: () => ({ findings: [] }) })
    .stuck.filter(row => row.cause === "RANK_INVERSION" && row.item === claimed);

  const control = scan();
  assert.equal(control.length, 1, "the control board raises the inversion");
  assert.equal(control[0].detail.ahead, ahead);

  reserveItem(board, claimed, { agentId: "coordinator", holder: seat.id });
  assert.equal(scan().length, 0, "a coordinator reservation silences it");

  board.db.prepare("UPDATE item SET item_reservation_holder=NULL, item_reservation_by=NULL, item_reservation_at=NULL WHERE item_id=?").run(claimed);
  assert.equal(scan().length, 1, "clearing the reservation raises it again");

  board.db.prepare("UPDATE item SET item_hold_reason=? WHERE item_id=?").run("coordinator hold", claimed);
  assert.equal(scan().length, 0, "a coordinator hold silences it");
});
