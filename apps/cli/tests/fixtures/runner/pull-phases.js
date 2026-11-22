/** Safe, observational phase snapshots for the real pulled-worker fixture [C7,#12952]. */

/** Generate a private fixture observer; it never changes a job, lease, command, or wait budget. */
export function pullPhaseDiagnosticsSource({ home, machineHome, requests }) {
  return `
    const phaseStarted = Date.now();
    const phaseIds = new Map();
    let phasePrevious = '';
    const phaseNames = directory => { try { return readdirSync(directory); } catch { return []; } };
    const phaseRead = file => { try { return readFileSync(file, 'utf8'); } catch { return ''; } };
    const phaseId = id => { if (!phaseIds.has(id)) phaseIds.set(id, phaseIds.size + 1); return phaseIds.get(id); };
    const phaseSnapshot = () => {
      const records = join(${JSON.stringify(machineHome)}, 'runner-jobs');
      const controller = phaseNames(records).filter(name => name.endsWith('.json')).flatMap(name => {
        let row; try { row = JSON.parse(phaseRead(join(records, name))); } catch { return []; }
        return [{ job: phaseId(row.id), phase: row.phase, marks: Object.fromEntries(Object.entries(row.phaseAt ?? {}).map(([name, at]) => [name, at - phaseStarted])) }];
      });
      const remote = ['queue', 'running', 'done'].flatMap(state => {
        const directory = join(${JSON.stringify(home)}, '.pullboard-runner', state);
        return phaseNames(directory).filter(id => /^[a-f0-9-]{36}$/u.test(id)).map(id => {
          const log = phaseRead(join(directory, id, 'control.log'));
          return { job: phaseId(id), state, need: log.includes('PULLBOARD_RUNNER_NEED '), ready: log.includes('PULLBOARD_RUNNER_READY '), result: log.includes('PULLBOARD_RUNNER_RESULT '),
            sourceSent: phaseRead(join(directory, id, 'source.pack.ready')) !== '' };
        });
      });
      const transports = phaseRead(${JSON.stringify(requests + '.phases')}).trim().split('\\n');
      return { controller, remote, dispatched: transports.filter(line => line === 'dispatched').length, returned: transports.filter(line => line === 'returned').length };
    };
    const pullDiagnostic = (stage, details = {}) => {
      const state = phaseSnapshot();
      const key = JSON.stringify(state);
      if (stage === 'snapshot' && key === phasePrevious) return;
      phasePrevious = key;
      process.stderr.write('PULL_FIXTURE_PHASE ' + JSON.stringify({ ms: Date.now() - phaseStarted, stage, ...details, ...state }) + '\\n');
    };
    const phaseTimer = setInterval(() => pullDiagnostic('snapshot'), 1000);
    const stopPullDiagnostics = () => clearInterval(phaseTimer);
  `;
}
