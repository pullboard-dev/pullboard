/**
 * Render the two-hour window comparison for Activity; every figure is a canonical API scalar, never reconstructed here.
 * @param {object|null} observed - The board's statsComparison read.
 * @param {object} [options] - Presentation settings.
 * @param {string} [options.locale] - Locale for number and time formatting.
 * @param {string} [options.timeZone] - Zone for the two ranges.
 * @returns {string} The comparison section markup, or '' when the board has none.
 */
export function comparisonHtml(observed, { locale = 'en-US', timeZone = 'UTC' } = {}) {
  /** Escape both text and attribute values supplied by a board. */
  const esc = value => String(value ?? '').replace(/[&<>"']/g, c => ({ '&':'&amp;', '<':'&lt;', '>':'&gt;', '"':'&quot;', "'":'&#39;' })[c]);
  if (!observed) return '';
  if (!observed.available) return '<section class="dash-card window-comparison" aria-label="Window comparison"><h2>The last two hours</h2><p>'+esc(observed.reason || 'Comparison unavailable')+'</p></section>';
  const { current, previous, change } = observed;
  /** Missing evidence stays visibly unmeasured, and share changes use absolute percentage points. */
  const figure = (value, share = false, delta = false) => value === null || value === undefined ? 'unmeasured'
    : (delta && value > 0 ? '+' : '') + (share ? (100*value).toFixed(1)+(delta?' pp':'%') : Number.isInteger(value)?String(value):value.toFixed(2));
  /** Bind displayed figures to exact API numbers for the native Dashboard journey. */
  const line = (label, key, share = false, group = null) => {
    const a = group ? current[group][key] : current[key], b = group ? previous[group][key] : previous[key], d = group ? change[group][key] : change[key];
    return '<tr data-stats-comparison="'+esc(group ? group+'.'+key : key)+'" data-current="'+esc(JSON.stringify(a))+'" data-previous="'+esc(JSON.stringify(b))+'" data-change="'+esc(JSON.stringify(d))+'"><th scope="row">'+esc(label)+'</th><td>'+esc(figure(a,share))+'</td><td>'+esc(figure(b,share))+'</td><td>'+esc(figure(d,share,true))+'</td></tr>';
  };
  const totals = [['Landed','landed'],['Agent-hours','agentHours'],['Agent-hours / landing','agentHoursPerLanding'],['Idle share','idleShare',true],['Submits / item','submitsPerItem'],['Reject rate','rejectRate',true],['Coordinator shouts / landing','shoutsPerLanding']].map(row=>line(...row)).join('');
  const idle = [['Nothing eligible','nothing-eligible'],['Held','held'],['Pending review family','review-family'],['Main red','main-red'],['Unknown','unknown']].map(([label,key])=>line('Idle: '+label,key,true,'idleReasons')).join('');
  const stages = [['Build','build'],['Rework','rework'],['Review wait','reviewWait'],['Review','review'],['Land','land']].map(([label,key])=>line('Stage: '+label,key,true,'stageShares')).join('');
  /** Minute precision and the caller's zone keep both ranges on the person's clock. */
  const stamp = value => new Date(value).toLocaleTimeString(locale, { timeZone, hour: 'numeric', minute: '2-digit' });
  const caption = '<span class="window-range" data-stats-as-of="'+esc(current.until)+'" title="'+esc(observed.durationMinutes)+'-minute windows">'+esc(stamp(current.since)+'–'+stamp(current.until)+' against '+stamp(previous.since)+'–'+stamp(previous.until))+'</span>';
  const metrics = [['Landed','landed',false,true], ['Sent back','rejectRate',true,false], ['Agents idle','idleShare',true,false], ['Agent-hours per landing','agentHoursPerLanding',false,false]];
  /** A missing canonical value never becomes a zero or a direction of improvement. */
  const measured = value => typeof value === 'number' && Number.isFinite(value);
  /** Compact headline values retain percentage-point units for share changes. */
  const compact = (value, share, key) => !measured(value) ? 'unmeasured' : share ? (100*value).toFixed(1)+'%' : key === 'landed' ? String(value) : value.toFixed(1);
  /** Color reflects this measure's direction, rather than treating every increase as good. */
  const direction = (delta, higherBetter) => !measured(delta) || delta === 0 ? '' : (delta > 0) === higherBetter ? 'good' : 'bad';
  const tiles = metrics.map(([label,key,share,higherBetter]) => {
    const a = current[key], b = previous[key], delta = change[key], tone = direction(delta,higherBetter);
    const max = share ? 1 : Math.max(measured(a)?a:0,measured(b)?b:0,1);
    const difference = !measured(delta) ? 'unmeasured' : delta === 0 ? 'No change' : (delta > 0 ? '▲ ' : '▼ ') + (share ? (Math.abs(delta)*100).toFixed(1)+' pts' : key==='landed' ? String(Math.abs(delta)) : Math.abs(delta).toFixed(1));
    return '<div class="window-tile '+tone+'" data-window-tile="'+key+'"><div class="window-key">'+label+'</div><div class="window-value"><b>'+esc(compact(a,share,key))+'</b><span class="window-change '+tone+'">'+esc(difference)+'</span></div><svg class="window-bar" viewBox="0 0 1000 6" preserveAspectRatio="none" aria-hidden="true">'+(measured(b)?'<rect class="window-before" x="0" y="0" height="6" width="'+Math.min(1000,Math.max(0,b/max*1000))+'"/>':'')+(measured(a)?'<rect class="window-after" x="0" y="0" height="6" width="'+Math.min(1000,Math.max(0,a/max*1000))+'"/>':'')+'</svg><small>was '+esc(compact(b,share,key))+'</small></div>';
  }).join('');
  /** Generate plain changes from all four observed values without inventing a causal explanation. */
  const sentence = metrics.map(([label,key,share]) => {
    const a=current[key], b=previous[key], d=change[key];
    if (!measured(a) || !measured(b) || !measured(d)) return label+' is unmeasured for one or both windows.';
    return label+': '+compact(a,share,key)+(d===0?', unchanged.':', '+(d>0?'up':'down')+' from '+compact(b,share,key)+'.');
  }).join(' ');
  const stageKeys = [['Build','build'],['Rework','rework'],['Pending review','reviewWait'],['Review','review'],['Landing','land']];
  /** Shares already come normalized from the canonical API; no browser lifecycle replay is used. */
  const stack = (period, label) => {
    const shares = observed[period].stageShares;
    let offset = 0;
    const bars = stageKeys.map(([name,key]) => {
      if (!measured(shares[key])) return '';
      const x = offset; offset += Math.max(0,shares[key]);
      return '<rect class="window-stage-'+key+'" data-window-stage="'+period+'.'+key+'" data-share="'+shares[key]+'" x="'+x*1000+'" y="0" height="1" width="'+Math.max(0,shares[key])*1000+'"><title>'+name+' '+(shares[key]*100).toFixed(1)+'%</title></rect>';
    }).join('');
    return '<div class="window-stage-row"><span>'+label+'</span><svg class="window-stack" viewBox="0 0 1000 1" preserveAspectRatio="none" role="img" aria-label="'+label+' item time">'+bars+'</svg></div>';
  };
  const legend = '<div class="window-keys">'+stageKeys.map(([label,key]) => '<span><i class="window-stage-'+key+'"></i>'+label+' '+esc(compact(current.stageShares[key],true,key))+'</span>').join('')+'</div>';
  return '<section class="dash-card window-comparison" aria-label="Window comparison"><div class="window-head"><h2>The last two hours</h2>'+caption+'</div><p class="window-sentence">'+esc(sentence)+'</p><div class="window-tiles">'+tiles+'</div><h3 class="window-time-heading">Where item time went</h3>'+stack('current','now')+stack('previous','before')+legend
    + '<details class="dash-comparison" data-dashboard-disclosure="comparison"><summary>All 17 measures →</summary><table><thead><tr><th>Metric</th><th>Current</th><th>Previous</th><th>Change</th></tr></thead><tbody>'+totals+idle+stages+'</tbody></table><p>Idle reasons use all observed seat-hours as their denominator and add up to the idle share; older reasons remain unknown. Stage shares use the five recorded stage durations. Rework is time returned to open. Share changes are percentage points.</p></details></section>';
}
