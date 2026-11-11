/** Clause facts that cite a run at an earlier head of the same item: found, linked to the exact-head outcome, or named stale [C7]. */
import { criterionClauses } from './clauses.js';

const EVIDENCE = 'test|command|screenshot|measurement|reasoning';
const TICK = new RegExp(`^clause (\\d+) \\[(${EVIDENCE})\\]:\\s*(\\S[\\s\\S]*)$`, 'u');
const HEAD_CITED = /\b(?:at|head|commit)\s+([a-f0-9]{7,64})\b/giu;
const TEST_FILE = /[\w./-]+\.(?:test|spec)\.[cm]?js\b/gu;

/** The heads a piece of evidence cites, as written, in order. */
function citedHeads(evidence) {
  return [...new Set([...String(evidence).matchAll(HEAD_CITED)].map(match => match[1].toLowerCase()))];
}

/** Whether the cited head spelling is the exact head (a prefix of it). */
function isExactHead(cited, head) {
  return String(head).toLowerCase().startsWith(cited);
}

/** The named cases and test files a fact's evidence cites: double-quoted case names and test paths. */
export function namedEvidence(evidence) {
  const text = String(evidence);
  const cases = [...text.matchAll(/"([^"]{8,})"/gu)].map(match => match[1].trim());
  const files = [...new Set([...text.matchAll(TEST_FILE)].map(match => match[0].replace(/^\.\//u, '')))];
  return { cases, files };
}

/**
 * Every clause fact (a note ticking `clause <n> [kind]: ...`) that cites a head other than `head`, for a numbered
 * criterion. Why: a builder's run at an earlier head is real evidence, but a reviewer needs the exact-head
 * receipt's outcome next to it; and the builder needs to know before queuing which clause rests on an old head.
 * By default a clause with any tick that cites no head or the exact head is not listed: its evidence is current.
 * With `everyEarlier` every fact that cites an earlier head is listed even then, which is what a reviewer sees.
 *
 * @param {{ item_criterion?: string, item_owner?: string }} item
 * @param {{ type: string, kind?: string, by?: string, text?: string, id?: string }[]} thread
 * @param {string} head - The exact head commit.
 * @param {{ anyAuthor?: boolean, everyEarlier?: boolean }} [options] - Read facts by any author; list every earlier-head fact.
 * @returns {{ clause: number, kind: string, fact: string|null, cited: string, evidence: string, files: string[], cases: string[] }[]}
 */
export function earlierHeadFacts(item, thread, head, { anyAuthor = true, everyEarlier = false } = {}) {
  const clauses = criterionClauses(item.item_criterion);
  if (!clauses.length || !head) return [];
  const byClause = new Map();
  for (const entry of thread ?? []) {
    if (entry.type !== 'fact' || entry.kind !== 'note' || (!anyAuthor && entry.by !== item.item_owner)) continue;
    const match = TICK.exec(String(entry.text ?? '').trim());
    if (!match) continue;
    const n = Number(match[1]);
    const heads = citedHeads(match[3]);
    const row = { clause: n, kind: match[2], fact: entry.id ?? null, evidence: match[3].trim(), heads };
    byClause.set(n, [...(byClause.get(n) ?? []), row]);
  }
  const found = [];
  for (const clause of clauses) {
    const rows = byClause.get(clause.number) ?? [];
    if (!rows.length) continue;
    const isCurrent = row => !row.heads.length || row.heads.some(cited => isExactHead(cited, head));
    if (!everyEarlier && rows.some(isCurrent)) continue;
    for (const row of rows) {
      if (isCurrent(row)) continue;
      const { cases, files } = namedEvidence(row.evidence);
      found.push({ clause: row.clause, kind: row.kind, fact: row.fact, cited: row.heads[0], evidence: row.evidence, files, cases });
    }
  }
  return found;
}

/** The clause numbers whose only evidence cites an earlier head, in order. */
export function staleHeadClauses(item, thread, head) {
  return [...new Set(earlierHeadFacts(item, thread, head).map(row => row.clause))];
}

/**
 * The submit's one line per clause whose only evidence cites an earlier head, printed before queuing, or [].
 *
 * @returns {string[]}
 */
export function staleHeadLines(item, thread, head) {
  const facts = earlierHeadFacts(item, thread, head);
  return [...new Set(facts.map(row => row.clause))].map(n => {
    const cited = facts.filter(row => row.clause === n).map(row => row.cited).join(', ');
    return `clause ${n}: its only evidence cites an earlier head (${cited}), not ${String(head).slice(0, 10)}; refresh it: pullboard fact ${item.item_id} note "clause ${n} [test]: <the case> passed at ${String(head).slice(0, 10)}"`;
  });
}

/**
 * Match each earlier-head fact to the exact-head receipt's outcomes for the same named cases.
 * A case named in the fact is `pass` or `fail` when the exact-head receipt recorded it, else `missing`; a fact naming
 * only a test file is judged by that file's run at the exact head, else `missing`. A fact is stale when anything it
 * names is missing, or when it names nothing the receipt could answer for.
 *
 * @param {ReturnType<typeof earlierHeadFacts>} facts
 * @param {{ file: string, test: string, result: string }[]} cases - Executed cases at the exact head.
 * @param {{ file: string, result: string }[]} fileRuns - File-level runs at the exact head.
 * @returns {{ clause: number, fact: string|null, cited: string, stale: boolean, outcomes: { name: string, file: string|null, outcome: string }[] }[]}
 */
export function linkEarlierFacts(facts, cases, fileRuns) {
  const strip = name => String(name).replace(/^\.\//u, '').trim();
  return facts.map(fact => {
    const outcomes = fact.cases.map(name => {
      const row = cases.find(candidate => strip(candidate.test) === name)
        ?? cases.find(candidate => name.length >= 12 && (strip(candidate.test).includes(name) || name.includes(strip(candidate.test))));
      return { name, file: row?.file ?? null, outcome: row ? row.result : 'missing' };
    });
    if (!fact.cases.length) {
      for (const file of fact.files) {
        const runs = fileRuns.filter(run => run.file === file);
        outcomes.push({ name: file, file, outcome: !runs.length ? 'missing' : runs.some(run => run.result === 'fail') ? 'fail' : 'pass' });
      }
    }
    return { clause: fact.clause, fact: fact.fact, cited: fact.cited, outcomes,
      stale: !outcomes.length || outcomes.some(row => row.outcome === 'missing') };
  });
}
