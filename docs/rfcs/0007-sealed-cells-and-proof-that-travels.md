# RFC 0007: Sealed cells and proof that travels

- Status: accepted, 7 November 2026
- Proposed: 7 November 2026, by Corey Olson
- Builds on RFC 0006 and its approved amendment of 31 October 2026 (rows A1–A6, local sealing). Changes no approved row.
- Replaces the private draft of 28 October and the split note of 31 October. Per the architect's ruling, one RFC holds both halves: §1 local sealing, §2 proof that travels. This RFC owns the receipt and its reuse key; RFC 0008 runs the jobs that produce receipts and cites this one.
- Rule ids in brackets (SC1…) are this RFC's design ids; on approval each becomes a row in `DOCTRINE.md` under CS with a new id, as RFC 0006's appendix did.

## Summary

Every judgement Pullboard makes about code is a **receipt**: a pure, recorded verdict keyed by three tree ids, the candidate, the base and the tooling pin. The same key always means the same judgement, so a receipt is computed once and reused by review, landing and audit.

A cell is **sealed** when a receipt proves its tests green at its current content hash and every cell it imports is sealed. While the hash holds, the cell is never proven again. Work pays only for the cells it unseals.

Receipts and seal records are signed. A board can import a signed seal from another board, recompute the hash from its own tree, and reuse the proof. Which signers a board trusts is the person's decision.

## Motivation

Measured on Pullboard's own board, 30 October 2026:
- About 1.5 runner-hours of testing per landed item, mostly repeated runs of unchanged code.
- 93% of builder wall time went to tools, not thinking.
- Result reuse was defeated by the tangle: submit reused about one file per run.
- 212k lines of tests against 124k of code.

The causes:
- **Proof is keyed by the wrong thing.** Gate results today bind a commit, a checkout path and a run. A main move that touches none of a change's files still forces a rerun.
- **Judgement and bookkeeping are mixed.** A cache write or an accounting step that fails after the tests can change what the gate reports.
- **Nothing outlives its board.** A cell proven on one machine is proven again on the next, and again in every repo that copies it.

Before-and-after numbers from the 0.9.4 cells moves go here when the case study has them.

## Constraints

RFC 0006's K1–K10 (CD1–CD10) hold. In addition:
- A proof is only as good as its inputs. A key covers every file the verdict depends on, or there is no proof.
- Invalidation is computed from trees and the import graph, never judged.
- No metadata file in a cell (CD16). Receipts and seal records are board records.
- The receipt is language-agnostic: it judges outcomes a runner reports for the project's own command, whatever language or tool produced them.

## 1. Local sealing

### 1.1 Approved already (RFC 0006 amendment, 31 October)

Cited here, unchanged:
- [A1] A cell's verdict is keyed to a content hash of its files and assets plus the hashes of the front doors it imports.
- [A2] Invalidation is computed, never judged: a change unseals exactly the cells whose hash it changes, through the import graph.
- [A3] Submit and landing run only the tests of the cells a change unseals, plus contracts at changed front doors; journeys run per landing batch.
- [A4] An item proves once: review and landing reuse its proof and add only the merge composition and the batch's journeys.
- [A5] A reviewer cites a sealed cell's verdict receipt instead of re-checking it.
- [A6] Until seals exist, a generated tier manifest classifies each test file, and per-change selection uses only the touched cells' tests.

The rows below make A1–A6 checkable: what a receipt is, what its key is, when it may be reused, and what a seal record holds.

### 1.2 The receipt

- [SC1] A receipt is the one record of a judgement: per-section outcomes and codes, one verdict, the key it was judged under, and the ids of the result files it judged.
- [SC2] The sections are static, criterion, proof, cells and comparison, judged in that order; each comes to pass, fail, skip or infra.
- [SC3] Judgement is pure: the same collected results give the same receipt, with no file, clock, board or process read.
- [SC4] A missing or malformed section is infra, never pass. The verdict is red if any section failed, else infra if any was lost, else green.
- [SC5] The verdict is recorded before bookkeeping runs (caches, accounting, logs, flake notes), and bookkeeping can never change it.
- [SC6] Only a red verdict returns an item to its builder; an infra verdict is retried by the job that produced it (RFC 0008).

**As built.** `packages/receipt` on main holds `judge(collected)`, `verdictStep(judgement, receiptId)` and `settle(collected, receiptId, io)`, with `SECTIONS` and `OUTCOMES`. They implement SC2–SC5 as written. The gate's existing run receipts (`packages/gate/src/io/run/receipt.js`) record a tree, the command's digest, the result and the failed tests under the git directory; they are the result files a receipt judges until RFC 0008's runner result files replace them. Not built yet: the key and the reuse rule below.

### 1.3 The reuse key

- [SC7] A receipt's key is three tree ids: the candidate's tree, the base's tree, and the tooling pin's tree. Commit ids, branch names, paths, hosts and processes are never part of a key.
- [SC8] The tooling pin is the tree of the last landing; every job runs that tooling, whatever a seat has checked out. Before any landing writes one, the tooling is the candidate's own tree.
- [SC9] The command a runner ran is read from those trees, so it is fixed by the key. The receipt records the command's digest, and a reader refuses a receipt whose recorded digest disagrees with the one its key gives.
- [SC10] A receipt with the exact key is reused by anyone who asks: submit, review, landing, the audit, `show`. Nobody reruns a judgement the board already holds.
- [SC11] A receipt is reusable for a different base when the base moved only through changes that touch none of the cells the candidate's change reaches, computed from the import graph (A2). Landing then adds only the merge composition and the batch's journeys (A4).
- [SC12] The reuse decision is a pure function of the receipt, the new composition and the import graph, recorded with its reason on the job that reused it.

**Why.** Tree ids are content: two checkouts of the same tree on two machines name it the same way, and a sweep that deletes a folder cannot change what a key names. Pinning the tooling means a verdict depends on which tooling judged it, never on which seat asked. The `pin` cell on main provides `treeOf` and `pinFor(commit) → {tree, tooling}`; the per-landing tooling pin (`writeToolingPin`, `toolingPin`, `toolingFor`) is on item branch `core/item-3407`.

### 1.4 Seals

- [SC13] A cell's content hash covers the git tree id of its folder, its assets, the content hashes of the cells it imports (so invalidation is transitive, A2), and the tooling identity: the hashes of the cells the judgement runs from. A landing that leaves the gate's own cells unchanged unseals nothing on that account.
- [SC14] A seal record is a board record: cell, content hash, the receipt ids that proved it, verifier, model family, time.
- [SC15] A seal covers its cell's own tests and the contract tests at its front door. Journeys are never part of a seal; they run per landing batch.
- [SC16] `pullboard cells` shows each cell as sealed or unsealed, and for an unsealed cell, the change that broke the seal.
- [SC17] An agent's generated context (CD53) shows a sealed cell by its front door and contracts only, never its body.
- [SC18] The audit re-proves sealed cells on its computed cadence (CS5) with real adapters. A seal the audit breaks becomes a Rigor item (CS3).
- [SC19] The count of cells unsealed for longer than a day is reported and only falls.

**Why.** A1 keys a verdict to a cell; SC7 keys a receipt to a tree. A seal joins them: a whole-tree receipt proves many cells at once, and each cell keeps the proof for as long as its own hash holds. Using git's tree id for the folder gives the hash for free and in any language.

## 2. Proof that travels

- [SC20] The same content hash carries the same proof on any board, machine or hosted runner whose signer the board trusts.
- [SC21] Every receipt is signed by the board that judged it and lists the signed result files it judged (RFC 0008). Every seal record is signed by the board that made it.
- [SC22] A board may import a seal record or receipt from another board. On import it checks every signature, recomputes the content hash from its own tree, and refuses a record whose hash does not match. The import is an event on the board. Proof is never copied by hand.
- [SC23] Which signers a board trusts is a person's decision (P6), recorded on the board, and revocable. A new board trusts only itself.
- [SC24] An imported seal skips tests; it never replaces an item's verification. Every item still needs a second agent's verdict on this board (P1).
- [SC25] The audit re-proves imported seals first. A broken imported seal is a Rigor item and a notice to the person naming the signer; trust changes only by the person's decision.

**Why.** This is the step from one repo's cache to shared, proven foundations. A cell built and sealed once is reused, with its proof attached, wherever its hash matches. Recomputing the hash on import means a board trusts a signer for a judgement, never for a claim about which code was judged. Signing reuses the board's existing key material (`packages/keys`).

## What changes

- The receipt cell gains `receiptKey(candidate, base, tooling)` and `reusable(receipt, composition)` (design item 17 of the durable-gate plan).
- Review and landing look up receipts by key; `show` reads the receipt for an item's gate.
- The gate's run receipts become result files the receipt judges, then retire when RFC 0008's runner result files land.
- A landing batch's receipt later carries each item's frozen row set, so landing writes RFC 0005's `Pullboard-Rows` from the receipt; until then that trailer is optional (proposed 0005 ruling).
- A6's tier manifest stays the bridge until seal records exist.
- Seals (§1.4) start after the cells moves and A3's per-cell selection land.
- Travelling proof (§2) starts after RFC 0008's signed result files land.
- Applies from the release that ships each part. Old gate receipts stay readable and are never reused across a tooling change.

## Open questions

1. **Section 1 and the approved amendment (settled, 7 November 2026).** One RFC holds both halves: §1 cites A1–A6 in place and adds SC1–SC19 beside them; §2 holds travelling proof.
2. **Default trust (settled for now, 7 November 2026).** A board trusts only itself (SC23), including other boards of the same person and any Cloud fleet. Wider default trust may come later through an amendment to this RFC.
3. **Model family (deferred, 7 November 2026).** Whether a seal needs a verifier from another model family before it travels belongs to a later trust-model RFC, which will treat each relationship between boards on its own terms. Under SC23 no proof travels by default, so nothing is required now.
4. **Seal lifetime.** How long a seal stays valid without an audit pass, or only until the audit cadence (CS5) next reaches it.
5. **Shared, versioned cells.** Versions tied to contract fingerprints, and building new features in layers on sealed cells; held for a later RFC.
