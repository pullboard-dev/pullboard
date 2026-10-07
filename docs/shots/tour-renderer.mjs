/** Draw the real tour as the person's compact, animated eight-step card [I13]. */

/** Keep captured terminal text literal inside SVG text, titles and metadata. */
function escapeXml(value) {
  return String(value).replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;').replaceAll('"', '&quot;').replaceAll("'", '&apos;');
}

/** Read the tour's actual steps; an unexpected recording must be repaired rather than disguised. */
function tourSteps(captured) {
  const sections = [];
  for (const { text } of captured) {
    const heading = /^(\d+) {2}(.*)$/u.exec(text);
    if (heading) sections.push({ number: Number(heading[1]), heading: heading[2], lines: [] });
    else sections.at(-1)?.lines.push(text);
  }
  if (sections.length !== 8 || sections.some(({ number }, index) => number !== index + 1)) {
    throw new Error('The tour card needs the eight numbered tour steps in order; inspect pullboard tour and regenerate the card.');
  }
  return sections;
}

/** Require facts from the recording so an old successful card cannot conceal a changed tour. */
function fact(value, name) {
  if (!value) throw new Error(`The tour recording has no ${name}; inspect pullboard tour and regenerate the card.`);
  return value;
}

/** Condense the captured headings and results into the approved card's one-line descriptions. */
function cardRows(captured) {
  const steps = tourSteps(captured);
  const spec = fact(steps[0].lines.find((line) => /^\s*[A-Z]\d+: /u.test(line)), 'approved spec row');
  const functionName = fact(/\b([\w$]+)\(name\)/u.exec(spec)?.[1], 'greeting function');
  const expected = fact(/blank name.*"Hello, ([^"]+)!"/u.exec(spec)?.[1], 'blank-name requirement');
  const item = fact(/^\s*#(\d+)$/mu.exec(steps[0].lines.join('\n'))?.[1], 'filed item');
  fact(steps[1].lines.some((line) => line.includes(`claimed #${item}`)), 'builder claim');
  fact(steps[2].lines.some((line) => line.includes('gate green')), 'green submission');
  const probe = steps[3].lines.findIndex((line) => /\$ node -e /u.test(line));
  const wrong = fact(probe >= 0 && steps[3].lines[probe + 1]?.trim(), 'blank-name counterexample');
  const rejection = fact(/rejected #\d+: ([A-Z_]+)[;:]/u.exec(steps[3].lines.join('\n'))?.[1], 'rejection reason');
  fact(steps[4].lines.some((line) => line.includes('pullboard resume')), 'board resumption');
  fact(steps[5].lines.some((line) => line.includes('gate green')), 'revised submission');
  fact(steps[6].lines.some((line) => /# fail [1-9]/u.test(line)), 'deliberately failing test');
  fact(steps[6].lines.some((line) => /# pass [1-9]/u.test(line)), 'restored passing test');
  const acceptance = fact(/verified #\d+: ([A-Z_]+)/u.exec(steps[6].lines.join('\n'))?.[1], 'acceptance reason');
  fact(steps[7].lines.some((line) => /#\d+ merged as /u.test(line)), 'merged receipt');
  return [
    { actor: 'you', text: `approve one spec row: ${functionName} a blank name as "${expected}"`, source: spec },
    { actor: 'coordinator', text: `files it as task #${item}`, source: steps[0].heading },
    { actor: 'builder', text: `claims it, builds ${functionName}(), submits with tests green`, source: steps[1].heading + ' ' + steps[2].heading },
    { actor: 'verifier', text: `tries a blank name, gets "${wrong}"`, tag: 'REJECT', reason: rejection, source: steps[3].heading },
    { actor: 'builder', text: steps[4].heading.replace(/^The builder's next session starts/u, 'reads why'), source: steps[4].heading },
    { actor: 'builder', text: steps[5].heading.replace(/^It fixes the edge/u, 'fixes it').replace(', and submits a new commit.', ', submits again'), source: steps[5].heading },
    { actor: 'verifier', text: steps[6].heading.replace(/^The verifier /u, '').replace(', to prove the new test can fail, then restores it and accepts.', ', sees the test fail'), tag: 'ACCEPT', reason: acceptance, source: steps[6].heading },
    { actor: 'coordinator', text: steps[7].heading.replace(/^The coordinator /u, '').replace('. The ledger', '; the ledger'), source: steps[7].heading },
  ];
}

/** Render an SVG image whose own styles work in GitHub, both color schemes and reduced motion. */
export function renderTour(captured) {
  const transcript = captured.map(({ text, at }) => ({
    text: text.replaceAll('^D\b\b', '').replace(/\x1b\[[0-9;]*m/gu, '').replace(/[\x00-\x08\x0b-\x1f]/gu, '')
      .replace(/^.*Look around: cd .*/u, '   Look around: cd greeter && pullboard log'), at,
  }));
  const rows = cardRows(transcript);
  const contents = rows.map(({ actor, text, tag, reason, source }, index) => {
    const y = 89 + index * 37;
    const verdict = tag ? `<g class="verdict ${tag.toLowerCase()}"><rect x="553" y="${y - 15}" width="62" height="22" rx="6"/><text x="584" y="${y}" text-anchor="middle">${tag}</text><title>${escapeXml(reason)}</title></g>` : '';
    return `<g class="tour-step" data-step="${index + 1}" data-actor="${actor}"><title>${escapeXml(source)}${reason ? ': ' + escapeXml(reason) : ''}</title><rect class="step-glow" x="18" y="${y - 22}" width="604" height="35" rx="9" style="animation-delay:${index * 2}s"/><text class="number" x="30" y="${y}">${index + 1}</text><text class="actor ${actor}" x="60" y="${y}">${actor}</text><text class="description" x="155" y="${y}">${escapeXml(text)}</text>${verdict}</g>`;
  }).join('\n');
  return `<svg xmlns="http://www.w3.org/2000/svg" class="tour-card" viewBox="0 0 640 420" width="640" height="420" role="img" aria-labelledby="tour-title tour-description">
<title id="tour-title">The tour, in thirty seconds</title><desc id="tour-description">Eight steps: a real change is submitted, rejected, fixed, tested and accepted before it merges.</desc>
<metadata id="tour-transcript">${escapeXml(JSON.stringify(transcript))}</metadata>
<style>
.tour-card{--surface:#ffffff;--line:#dce5df;--ink:#101714;--muted:#4f5b55;--faint:#65746b;--blue:#315f8f;--violet:#6547bc;--green:#087546;--green-soft:#dff4e8;--red:#b33026;--red-soft:#fce8e5;--highlight:#edf7f1;font-family:system-ui,-apple-system,"Segoe UI",sans-serif}
@media(prefers-color-scheme:dark){.tour-card{--surface:#111714;--line:#34443a;--ink:#e9eeeb;--muted:#b6c3bc;--faint:#9cafa3;--blue:#80bfff;--violet:#c1aeff;--green:#61e6b1;--green-soft:#163829;--red:#ff8a80;--red-soft:#321917;--highlight:#193426}}
.surface{fill:var(--surface);stroke:var(--line)}.divider{stroke:var(--line)}.heading{fill:var(--ink);font-size:16px;font-weight:650}.command,.number,.actor,.verdict text{font-family:ui-monospace,SFMono-Regular,Menlo,monospace}.command,.number{fill:var(--faint);font-size:12px}.actor{font-size:12px;font-weight:600}.you{fill:var(--ink)}.coordinator{fill:var(--blue)}.builder{fill:var(--violet)}.verifier{fill:var(--green)}.description{fill:var(--muted);font-size:13px}.footer{fill:var(--muted);font-size:12px}.verdict text{font-size:11px;font-weight:650}.reject rect{fill:var(--red-soft)}.reject text{fill:var(--red)}.accept rect{fill:var(--green-soft)}.accept text{fill:var(--green)}
.step-glow{fill:transparent;animation:light-step 16s linear infinite}@keyframes light-step{0%,11%{fill:var(--highlight)}13%,100%{fill:transparent}}
@media(prefers-reduced-motion:reduce){.step-glow{animation:none;fill:transparent}}
</style>
<rect class="surface" x="0.5" y="0.5" width="639" height="419" rx="16"/>
<text class="heading" x="26" y="37">The tour, in thirty seconds</text><text class="command" x="615" y="37" text-anchor="end">$ pullboard tour</text><path class="divider" d="M26 57H614"/>
${contents}
<text class="footer" x="26" y="393">Real commands on a throwaway repo. No model runs.</text>
</svg>\n`;
}
