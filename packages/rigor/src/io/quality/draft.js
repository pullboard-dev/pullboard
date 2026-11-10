/**
 * `pullboard rigor quality` and `pullboard rigor --draft-quality` [D1,D3]. The first reports the
 * person's quality rules broken by one change, each with its file, line and rule. The second
 * drafts each rule as a Doctrine row through the ordinary draft writer: a draft with a check and
 * a count of 0, never approved here, so nothing is switched on until the person approves it.
 */
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { loadDoctrine } from '../../../../doctrine/index.js';
import { Refused } from '../../../../kernel/index.js';
import {
  GROWTH_BUDGET,
  QUALITY_RULES,
  breachLine,
  changeRange,
  qualityBreaches,
} from '../quality.js';
import { draftRow } from '../../../../spec/index.js';

/** The source a drafted quality row carries, so a rerun finds it whatever the person decided. */
export function qualitySource(key) {
  return `rigor-quality:${key}`;
}

/**
 * The doctrine row id for each quality rule the repo's doctrine carries, by rule key.
 *
 * @param {string} root
 * @param {any} config
 * @returns {Map<string, string>}
 */
export function qualityRows(root, config) {
  const rows = new Map();
  for (const row of loadDoctrine(root, config).repo.rows) {
    const key = /^rigor-quality:([a-z-]+)$/u.exec(row.source ?? '')?.[1];
    if (key && !rows.has(key)) rows.set(key, row.id);
  }
  return rows;
}

/**
 * The command a drafted row's check runs. Why two forms: this repo's hooks run the source in the
 * checkout, while any other repo runs the installed pullboard.
 *
 * @param {string} root
 * @param {string} key
 * @returns {string}
 */
export function qualityCommand(root, key) {
  const bin = existsSync(join(root, 'apps/cli/pullboard.js')) && existsSync(join(root, 'packages/rigor/src/io/quality.js')) ? 'node apps/cli/pullboard.js' : 'pullboard';
  return `${bin} rigor quality --rule ${key}`;
}

/**
 * pullboard rigor quality: print each breach as `path:line: [row] rule: what broke` and exit 1
 * with any, 0 with none, so a doctrine row's check counts it.
 *
 * @param {any} io
 * @param {{ values: any }} args
 * @param {{ root: string, config: any }} ctx
 * @returns {number}
 */
export function rigorQualityCommand(io, { values }, { root, config }) {
  const rules = values.rule ? String(values.rule).split(',').map((key) => key.trim()).filter(Boolean) : undefined;
  // A flag wins over the board's committed rigor.budget setting, which wins over the default.
  const budget = values.budget === undefined ? config.rigor?.budget ?? GROWTH_BUDGET : Number(values.budget);
  if (!Number.isSafeInteger(budget) || budget < 0) throw new Refused('USAGE', `--budget takes a whole number of lines, such as ${GROWTH_BUDGET}`);
  const range = changeRange(root, { base: values.base, head: values.head });
  const breaches = qualityBreaches(root, range, { rules, budget });
  const rows = qualityRows(root, config);
  io.result?.({ base: range.base, head: range.head, breaches: breaches.map((breach) => ({ ...breach, row: rows.get(breach.rule) ?? null })) });
  for (const breach of breaches) io.say(breachLine(breach, rows));
  return breaches.length ? 1 : 0;
}

/**
 * Draft each quality rule the doctrine does not carry yet as a pending Doctrine row. Each id is
 * reserved on the board first (#878); a reservation whose row never reached the file is finished
 * at its id, unless the person already decided it. Coordinator only, from the main checkout,
 * because the doctrine file is the coordinator's to write.
 *
 * @param {{ info: { root: string, isMain: boolean }, config: any }} ctx
 * @param {{ read: () => { coordinator: boolean, rows: any[], decisions?: any[] }, reserve: (row: any) => Promise<{ id: string }> }} deps
 * @returns {Promise<{ id: string, file: string, line: string, row: any }[]>}
 */
export async function draftQualityRows(ctx, { read, reserve }) {
  const state = read();
  if (!ctx.info.isMain || !state.coordinator) throw new Refused('COORDINATOR_ONLY', 'only the coordinator drafts the quality rules; ask your coordinator to run pullboard rigor --draft-quality from the main checkout');
  const { root } = ctx.info;
  const drafts = [];
  for (const rule of QUALITY_RULES) {
    const doctrine = loadDoctrine(root, ctx.config);
    if (doctrine.repo.rows.some((row) => row.source === qualitySource(rule.key))) continue;
    const sections = doctrine.repo.sections.map((section) => /^([A-Z][A-Z0-9]*)\s*[·.:-]/u.exec(section.name)?.[1]).filter(Boolean);
    const request = { target: 'doctrine', text: `${rule.text} ${rule.how}`, gate: `check ${qualityCommand(root, rule.key)}`,
      fields: ['count: 0', `source: ${qualitySource(rule.key)}`], section: sections.includes(rule.section) ? rule.section : undefined };
    const pending = state.rows.find((row) => row.written && row.target === 'doctrine' && row.text === request.text
      && !doctrine.repo.rows.some((existing) => existing.id === row.id));
    if (pending && (state.decisions ?? []).some((decision) => decision.kind === 'doctrine' && decision.id === pending.id)) {
      throw new Refused('STALE_ROW_DECISION', `${pending.id} has a person decision but its doctrine row is missing; a quality draft cannot recreate it`, 'ask the coordinator to restore the decided doctrine row and run pullboard spec apply before retrying');
    }
    if (pending) {
      drafts.push(draftRow(root, ctx.config, { ...request, id: pending.id }, { loadDoctrine }));
      continue;
    }
    const planned = draftRow(root, ctx.config, { ...request, taken: state.rows.map((row) => row.id), write: false }, { loadDoctrine });
    const entry = await reserve({ ...planned.row, target: 'doctrine' });
    drafts.push(draftRow(root, ctx.config, { ...request, id: entry.id }, { loadDoctrine }));
    state.rows.push({ ...planned.row, id: entry.id, target: 'doctrine', written: true });
  }
  return drafts;
}
