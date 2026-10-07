/**
 * `pullboard spec view` (S7): the spec, its open questions, its sign-offs and the house rules as one
 * page for people. One self-contained HTML file: no server, no network, nothing to install. Every
 * piece of text from the files is escaped, so a row can never inject markup into the page.
 */
import { standings } from './spec.js';

const ESCAPES = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };

/**
 * Text made safe to place in HTML.
 *
 * @param {unknown} text
 * @returns {string}
 */
export const esc = (text) => String(text ?? '').replace(/[&<>"']/g, (char) => ESCAPES[char]);

/**
 * The sign-off cell for a row: who signed and when, stale, or not yet; blank unless approved.
 *
 * @param {any} row
 * @param {Map<string, { met: any[], stale: any[] }>} by
 * @returns {{ html: string, state: string }}
 */
function signoffCell(row, by) {
  if (row.status !== 'approved') return { html: '', state: 'none' };
  const standing = by.get(row.id);
  if (standing?.met.length) {
    const names = standing.met.map((entry) => `${esc(entry.by)} ${esc(entry.on)}`).join(', ');
    const notes = standing.met.filter((entry) => entry.note).map((entry) => `<div>${esc(entry.by)}: ${esc(entry.note).replaceAll('\n', '<br>')}</div>`).join('');
    const missing = (row.signers ?? []).filter((signer) => !standing.met.some((entry) => entry.by === signer));
    if (missing.length) return { html: `<span class="so so-open">signed ${names}; waiting for ${esc(missing.join(', '))}</span>${notes}`, state: 'open' };
    return { html: `<span class="so so-met">signed ${names}</span>${notes}`, state: 'met' };
  }
  if (standing?.stale.length) {
    const notes = standing.stale.filter((entry) => entry.note).map((entry) => `<div>${esc(entry.by)}: ${esc(entry.note).replaceAll('\n', '<br>')}</div>`).join('');
    return { html: `<span class="so so-stale">stale: text changed since sign-off</span>${notes}`, state: 'stale' };
  }
  return { html: '<span class="so so-open">not signed</span>', state: 'open' };
}

/**
 * One row as a table row, with its text kept in a data attribute for the search box.
 *
 * @param {any} row
 * @param {Map<string, any>} by
 * @param {boolean} withSignoff
 * @returns {string}
 */
function rowHtml(row, by, withSignoff) {
  const tier = row.tier ? ` <span class="tier">${esc(row.tier)}</span>` : '';
  const serves = row.serves.length ? esc(row.serves.join(', ')) : '';
  const label = row.status === 'wont' ? "won't build" : row.status;
  const search = esc(`${row.id} ${row.status} ${label} ${row.tier} ${row.text} ${row.gate}`.toLowerCase());
  const signoff = withSignoff ? `<td>${signoffCell(row, by).html}</td>` : '';
  return `<tr data-text="${search}"><td class="id">${esc(row.id)}</td><td><span class="st st-${esc(row.status)}">${esc(label)}</span>${tier}</td><td>${esc(row.text)}</td><td class="gate">${esc(row.gate)}</td><td class="id">${serves}</td>${signoff}</tr>`;
}

/**
 * A table of rows under a heading.
 *
 * @param {string} heading
 * @param {any[]} rows
 * @param {Map<string, any>} by
 * @param {boolean} withSignoff
 * @returns {string}
 */
function tableHtml(heading, rows, by, withSignoff) {
  if (!rows.length) return '';
  const signoffHead = withSignoff ? '<th>Sign-off</th>' : '';
  return `<h3>${esc(heading)}</h3><div class="scroll"><table><thead><tr><th>Id</th><th>Status</th><th>Row</th><th>Gate</th><th>Serves</th>${signoffHead}</tr></thead><tbody>${rows.map((row) => rowHtml(row, by, withSignoff)).join('')}</tbody></table></div>`;
}

/**
 * A parsed spec's rows grouped under their section headings.
 *
 * @param {any} spec
 * @param {Map<string, any>} by
 * @param {boolean} withSignoff
 * @returns {string}
 */
function sectionsHtml(spec, by, withSignoff) {
  return spec.sections
    .map((section) => tableHtml(section.name, spec.rows.filter((row) => row.section === section.name), by, withSignoff))
    .join('');
}

/**
 * The counts at the top: rows by status, and where the approved must-rows stand.
 *
 * @param {any} spec
 * @param {Map<string, any>} by
 * @returns {string}
 */
function summaryHtml(spec, by) {
  const count = (status) => spec.rows.filter((row) => row.status === status).length;
  const musts = spec.rows.filter((row) => row.status === 'approved' && row.tier === 'must');
  const states = musts.map((row) => signoffCell(row, by).state);
  const tally = (state) => states.filter((value) => value === state).length;
  const items = [
    [spec.rows.length, 'rows'],
    [count('approved'), 'approved'],
    [count('draft'), 'draft'],
    [count('pending'), 'open questions'],
    [`${tally('met')}/${musts.length}`, 'approved must-rows signed'],
    [tally('stale'), 'sign-offs gone stale'],
    ...(count('wont') ? [[count('wont'), "won't build"]] : []),
  ];
  return `<div class="summary">${items.map(([value, label]) => `<div><b>${esc(value)}</b><span>${esc(label)}</span></div>`).join('')}</div>`;
}

const STYLE = `
:root { --bg: #f4f6f3; --card: #fff; --ink: #17211b; --muted: #5a665f; --rule: #d7ddd8;
  --approved: #1d7748; --draft: #5a665f; --pending: #8a5b0c; --fact: #2b55a3; --wont: #7d5f4b; --retired: #9aa39e; --stale: #a1453a; }
@media (prefers-color-scheme: dark) { :root { --bg: #101512; --card: #161d19; --ink: #e5ebe7; --muted: #9aa69f;
  --rule: #29322d; --approved: #57c48d; --draft: #9aa69f; --pending: #e0b25a; --fact: #86a9ee; --wont: #c49f86; --retired: #6f7a74; --stale: #e08a7e; color-scheme: dark; } }
* { box-sizing: border-box; }
body { margin: 0; background: var(--bg); color: var(--ink); font: 15px/1.5 -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, Helvetica, Arial, sans-serif; }
.wrap { max-width: 1180px; margin: 0 auto; padding: 24px 16px 48px; }
h1 { margin: 0 0 4px; font-size: 1.7rem; } h3 { margin: 22px 0 8px; font-size: 1.05rem; }
.intro { color: var(--muted); max-width: 70ch; margin: 0 0 14px; }
.summary { display: flex; flex-wrap: wrap; gap: 10px 26px; padding: 12px 0; border-block: 1px solid var(--rule); margin-bottom: 14px; }
.summary div { display: grid; } .summary b { font-size: 1.25rem; font-variant-numeric: tabular-nums; } .summary span { color: var(--muted); font-size: .85rem; }
.tabs > input { position: absolute; opacity: 0; pointer-events: none; }
.tabs nav { display: flex; flex-wrap: wrap; gap: 6px; margin-bottom: 10px; }
.tabs nav label { padding: 6px 12px; border: 1px solid var(--rule); border-radius: 999px; cursor: pointer; background: var(--card); }
#t-spec:checked ~ nav label[for=t-spec], #t-questions:checked ~ nav label[for=t-questions],
#t-signoff:checked ~ nav label[for=t-signoff], #t-practice:checked ~ nav label[for=t-practice] { border-color: var(--ink); font-weight: 600; }
#t-spec:focus-visible ~ nav label[for=t-spec], #t-questions:focus-visible ~ nav label[for=t-questions],
#t-signoff:focus-visible ~ nav label[for=t-signoff], #t-practice:focus-visible ~ nav label[for=t-practice] { outline: 2px solid var(--fact); outline-offset: 2px; }
.panel { display: none; }
#t-spec:checked ~ #p-spec, #t-questions:checked ~ #p-questions, #t-signoff:checked ~ #p-signoff, #t-practice:checked ~ #p-practice { display: block; }
.search { width: 100%; max-width: 420px; padding: 8px 10px; border: 1px solid var(--rule); border-radius: 6px; background: var(--card); color: var(--ink); margin-bottom: 6px; font: inherit; }
.scroll { overflow-x: auto; border: 1px solid var(--rule); border-radius: 8px; background: var(--card); }
table { border-collapse: collapse; width: 100%; font-size: .92rem; }
th, td { text-align: left; padding: 8px 10px; border-bottom: 1px solid var(--rule); vertical-align: top; }
th { color: var(--muted); font-weight: 600; font-size: .78rem; text-transform: uppercase; letter-spacing: .04em; }
tr:last-child td { border-bottom: none; }
td.id { font-family: ui-monospace, Menlo, Consolas, monospace; white-space: nowrap; color: var(--muted); }
td.gate { color: var(--muted); }
.st { font-family: ui-monospace, Menlo, Consolas, monospace; font-size: .78rem; font-weight: 600; }
.st-approved { color: var(--approved); } .st-draft { color: var(--draft); } .st-pending { color: var(--pending); }
.st-fact { color: var(--fact); } .st-wont { color: var(--wont); font-style: italic; } .st-retired { color: var(--retired); text-decoration: line-through; }
.tier { color: var(--muted); font-size: .78rem; }
.so { font-size: .82rem; white-space: nowrap; } .so-met { color: var(--approved); } .so-stale { color: var(--stale); } .so-open { color: var(--muted); }
.empty { color: var(--muted); }
footer { margin-top: 28px; color: var(--muted); font-size: .82rem; }
`;

const SCRIPT = `
document.querySelectorAll('.search').forEach(function (box) {
  box.addEventListener('input', function () {
    var query = box.value.trim().toLowerCase();
    box.parentElement.querySelectorAll('tr[data-text]').forEach(function (row) {
      row.hidden = query !== '' && row.getAttribute('data-text').indexOf(query) === -1;
    });
  });
});
`;

/**
 * The whole page.
 *
 * @param {{ title: string, spec: any, practice: any, signoffs: any[], generatedAt: string, files: { spec: string, practice: string } }} input
 * @returns {string}
 */
export function renderSpecView({ title, spec, practice, signoffs, generatedAt, files }) {
  const by = standings(spec.rows, signoffs);
  const pending = spec.rows.filter((row) => row.status === 'pending');
  const approved = spec.rows.filter((row) => row.status === 'approved');
  const order = { open: 0, stale: 1, met: 2, none: 3 };
  const bySignoff = [...approved].sort((first, second) => order[signoffCell(first, by).state] - order[signoffCell(second, by).state]);
  const search = '<input class="search" type="search" placeholder="Filter rows" aria-label="Filter rows">';
  const practicePanel = practice?.exists
    ? sectionsHtml(practice, new Map(), false)
    : `<p class="empty">No ${esc(files.practice)} yet. Run pullboard init to start from the standard practice.</p>`;
  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>${esc(title || 'Spec')}</title><style>${STYLE}</style></head>
<body><div class="wrap">
<h1>${esc(title || 'Spec')}</h1>
${spec.intro.length ? `<p class="intro">${esc(spec.intro[0])}</p>` : ''}
${summaryHtml(spec, by)}
<div class="tabs">
<input type="radio" name="tab" id="t-spec" checked><input type="radio" name="tab" id="t-questions"><input type="radio" name="tab" id="t-signoff"><input type="radio" name="tab" id="t-practice">
<nav><label for="t-spec">Spec</label><label for="t-questions">Open questions (${pending.length})</label><label for="t-signoff">Sign-off</label><label for="t-practice">Practice</label></nav>
<section class="panel" id="p-spec">${search}${sectionsHtml(spec, by, true)}</section>
<section class="panel" id="p-questions">${pending.length ? tableHtml('Waiting on the person', pending, by, false) : '<p class="empty">No open questions.</p>'}</section>
<section class="panel" id="p-signoff">${search}${approved.length ? tableHtml('Approved rows, unsigned first', bySignoff, by, true) : '<p class="empty">No approved rows yet.</p>'}</section>
<section class="panel" id="p-practice">${search}${practicePanel}</section>
</div>
<footer>From ${esc(files.spec)}${practice?.exists ? ` and ${esc(files.practice)}` : ''} · generated ${esc(generatedAt)} · sign with: pullboard spec signoff &lt;ids&gt; --by &lt;initials&gt;</footer>
</div><script>${SCRIPT}</script></body></html>
`;
}
