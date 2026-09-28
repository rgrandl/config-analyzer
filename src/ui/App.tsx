// The whole tool on one page, in four steps: configure, review findings, mitigate, simulate.
// App holds the only state (the two YAML texts, the selection, the mitigation and simulation results); parsing,
// validation and analysis are derived from the text on every edit, since they take milliseconds. The
// simulation takes seconds, so it runs off the main thread and only when asked.
import { useEffect, useMemo, useRef, useState } from 'react';
import { stringify } from 'yaml';
import { DEMO_SCENARIO_YAML, DEMO_SYSTEM_YAML } from '../demo';
import { analyze, type Analysis } from '../engine/analyzer/analyze';
import { applyMitigations } from '../engine/analyzer/mitigation/applyMitigations';
import { loadScenario, loadSystem } from '../engine/config/load';
import type { Scenario, SystemConfig } from '../engine/config/schema';
import type { Comparison } from '../engine/simulator/compare';
import { CallGraphView } from './CallGraphView';
import { ConfigEditor } from './ConfigEditor';
import { ErrorBoundary } from './ErrorBoundary';
import { FindingsList, MitigationView, type MitigationState } from './FindingsPanel';
import { ResultsPanel } from './ResultsPanel';
import { runInWorker, type RunSimulation } from './simulation';

type AnalysisState = { readonly ok: true; readonly analysis: Analysis } | { readonly ok: false; readonly message: string };

/** The simulation step; `key` records the inputs a result belongs to, so edits mark it stale. */
type SimulationState =
  | { readonly kind: 'idle' }
  | { readonly kind: 'running' }
  | {
      readonly kind: 'done';
      readonly comparison: Comparison;
      readonly system: SystemConfig;
      readonly scenario: Scenario;
      readonly key: string;
    }
  | { readonly kind: 'failed'; readonly message: string; readonly key: string };

interface AppProps {
  /** How to run the four simulation runs; a Web Worker by default, in-process in tests. */
  readonly runSimulation?: RunSimulation;
}

export function App({ runSimulation = runInWorker }: AppProps = {}) {
  const [systemText, setSystemText] = useState(DEMO_SYSTEM_YAML);
  const [scenarioText, setScenarioText] = useState(DEMO_SCENARIO_YAML);
  const [deselected, setDeselected] = useState<ReadonlySet<string>>(new Set());
  const [highlightedId, setHighlightedId] = useState<string | undefined>();
  const [mitigation, setMitigation] = useState<{ state: MitigationState; key: string }>({
    state: { kind: 'none' },
    key: '',
  });
  const [simulation, setSimulation] = useState<SimulationState>({ kind: 'idle' });
  const running = useRef<AbortController | null>(null);
  const mitigateStep = useRef<HTMLElement>(null);
  const simulateStep = useRef<HTMLElement>(null);
  const [editorOpen, setEditorOpen] = useState(false);
  // A run still going when the page goes away is cancelled, so its worker does not linger.
  useEffect(() => () => running.current?.abort(), []);

  const system = useMemo(() => loadSystem(systemText), [systemText]);
  const scenario = useMemo(() => (system.ok ? loadScenario(scenarioText, system.value) : null), [system, scenarioText]);
  const analysis = useMemo<AnalysisState | null>(() => {
    if (!system.ok) return null;
    try {
      return { ok: true, analysis: analyze(system.value) };
    } catch (error) {
      return { ok: false, message: messageOf(error) };
    }
  }, [system]);

  const findings = analysis?.ok ? analysis.analysis.findings : [];
  const selected = useMemo(
    () => new Set(findings.filter((f) => f.mitigation && !deselected.has(f.id)).map((f) => f.id)),
    [findings, deselected],
  );
  // Mitigation results belong to one config and one selection; any change makes them stale.
  const currentKey = `${systemText}\n${[...selected].sort().join(',')}`;
  const mitigationState: MitigationState =
    mitigation.state.kind === 'applied' ? { ...mitigation.state, stale: mitigation.key !== currentKey } : mitigation.state;
  // A simulation also depends on the scenario.
  const simulationKey = `${currentKey}\n${scenarioText}`;
  const canSimulate = analysis?.ok === true && scenario?.ok === true && simulation.kind !== 'running';
  const highlighted = findings.find((finding) => finding.id === highlightedId);
  // The editor opens by itself when there is something to fix.
  const hasErrors = !system.ok || (scenario !== null && !scenario.ok);
  const showEditor = editorOpen || hasErrors;

  /** Applies the selected mitigations and returns the mitigated config, or null if that failed. */
  function mitigate(): SystemConfig | null {
    if (!system.ok || !analysis?.ok) return null;
    try {
      const result = applyMitigations(system.value, analysis.analysis.findings, selected);
      setMitigation({ state: { kind: 'applied', result, yaml: stringify(result.config), stale: false }, key: currentKey });
      return result.config;
    } catch (error) {
      setMitigation({ state: { kind: 'failed', message: messageOf(error) }, key: currentKey });
      return null;
    }
  }

  function apply() {
    mitigate();
    mitigateStep.current?.scrollIntoView?.({ behavior: 'smooth', block: 'start' });
  }

  /** Applies the current selection, then simulates the original and mitigated configs under the scenario. */
  async function applyAndSimulate() {
    if (!canSimulate || !system.ok || !scenario?.ok) return;
    const mitigated = mitigate();
    simulateStep.current?.scrollIntoView?.({ behavior: 'smooth', block: 'start' });
    if (!mitigated) return;
    const controller = new AbortController();
    running.current = controller;
    const key = simulationKey;
    setSimulation({ kind: 'running' });
    try {
      const input = { original: system.value, mitigated, scenario: scenario.value };
      const comparison = await runSimulation(input, controller.signal);
      setSimulation({ kind: 'done', comparison, system: system.value, scenario: scenario.value, key });
    } catch (error) {
      if (controller.signal.aborted) setSimulation({ kind: 'idle' });
      else setSimulation({ kind: 'failed', message: messageOf(error), key });
    } finally {
      if (running.current === controller) running.current = null;
    }
  }

  function cancel() {
    running.current?.abort();
  }

  function toggle(id: string) {
    setDeselected((previous) => {
      const next = new Set(previous);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }

  function loadDemo() {
    setSystemText(DEMO_SYSTEM_YAML);
    setScenarioText(DEMO_SCENARIO_YAML);
    setDeselected(new Set());
    setHighlightedId(undefined);
  }

  return (
    <div className="page">
      <header className="hero">
        <h1>Config Interaction Analyzer</h1>
        <p className="lede">
          Each service's timeouts, retries and queues can look reasonable on their own and still fail together. This
          tool finds those combinations, recommends a conservative change for each, and simulates both configs under
          the same fault.
        </p>
        <div className="hero-action">
          <p className="hero-status">
            {!system.ok
              ? 'Fix the system config to see its findings.'
              : findings.length === 0
                ? 'No risky combinations in this config.'
                : `${findings.length} risky ${findings.length === 1 ? 'combination' : 'combinations'} across ${Object.keys(system.value.services).join(', ')}.`}
          </p>
          {scenario?.ok === false ? (
            <button type="button" className="button-primary" disabled={!analysis?.ok || selected.size === 0} onClick={apply}>
              Apply {selected.size} {selected.size === 1 ? 'mitigation' : 'mitigations'}
            </button>
          ) : (
            <button type="button" className="button-primary" disabled={!canSimulate} onClick={applyAndSimulate}>
              {simulation.kind === 'running'
                ? 'Simulating…'
                : selected.size === 0
                  ? 'Simulate the config'
                  : `Apply ${selected.size} ${selected.size === 1 ? 'mitigation' : 'mitigations'} and simulate`}
            </button>
          )}
        </div>
      </header>

      <section className="step" aria-labelledby="step-configure">
        <div className="step-head">
          <h2 id="step-configure">1. Configure</h2>
          {!hasErrors && (
            <button type="button" className="button-quiet" aria-expanded={showEditor} onClick={() => setEditorOpen(!editorOpen)}>
              {showEditor ? 'Hide the config' : 'Edit the config'}
            </button>
          )}
        </div>
        {!showEditor && (
          <p className="hint">
            {systemText === DEMO_SYSTEM_YAML && scenarioText === DEMO_SCENARIO_YAML
              ? 'The demo is loaded: api calls orders, which calls db twice; the scenario slows db down 5× for 10 s. Edit it to try your own config.'
              : 'Your edited config is loaded.'}
          </p>
        )}
        {showEditor && (
        <ErrorBoundary name="the editor">
          <ConfigEditor
            systemText={systemText}
            scenarioText={scenarioText}
            systemErrors={system.ok ? [] : system.errors}
            scenarioErrors={scenario === null ? null : scenario.ok ? [] : scenario.errors}
            onSystemChange={setSystemText}
            onScenarioChange={setScenarioText}
            onLoadDemo={loadDemo}
          />
        </ErrorBoundary>
        )}
      </section>

      <section className="step" aria-labelledby="step-findings">
        <h2 id="step-findings">2. Review the findings</h2>
        {!system.ok && <p className="notice">The findings appear once the system config is valid.</p>}
        {analysis && !analysis.ok && (
          <div className="notice notice-error" role="alert">
            <p>The analysis failed: {analysis.message}</p>
          </div>
        )}
        {system.ok && analysis?.ok && (
          <div className="findings-layout">
            <ErrorBoundary name="the call graph">
              <div className="graph-panel">
                <CallGraphView system={system.value} analysis={analysis.analysis} highlighted={highlighted} />
                <p className="hint">
                  Badges count each service's findings, including those on the calls it makes. Select a finding to
                  highlight where it is.
                </p>
              </div>
            </ErrorBoundary>
            <ErrorBoundary name="the findings">
              <FindingsList
                analysis={analysis.analysis}
                selected={selected}
                highlightedId={highlightedId}
                onToggle={toggle}
                onSelectAll={(all) =>
                  setDeselected(all ? new Set() : new Set(findings.map((finding) => finding.id)))
                }
                onHighlight={setHighlightedId}
              />
            </ErrorBoundary>
          </div>
        )}
      </section>

      <section className="step" aria-labelledby="step-mitigate" ref={mitigateStep}>
        <div className="step-head">
          <h2 id="step-mitigate">3. Apply the mitigations</h2>
          <button type="button" disabled={!analysis?.ok || selected.size === 0} onClick={apply}>
            Apply {selected.size} selected
          </button>
        </div>
        {analysis?.ok && (
          <ErrorBoundary name="the mitigation result">
            <MitigationView
              state={mitigationState}
              analysis={analysis.analysis}
              onReapply={apply}
              onCopyIntoEditor={setSystemText}
            />
          </ErrorBoundary>
        )}
      </section>

      <section className="step" aria-labelledby="step-simulate" ref={simulateStep}>
        <div className="step-head">
          <h2 id="step-simulate">4. Simulate</h2>
          {simulation.kind === 'running' ? (
            <button type="button" onClick={cancel}>
              Cancel
            </button>
          ) : (
            <button type="button" disabled={!canSimulate} onClick={applyAndSimulate}>
              {simulation.kind === 'idle' ? 'Run the simulation' : 'Run it again'}
            </button>
          )}
        </div>
        <SimulationView
          state={simulation}
          stale={simulation.kind !== 'idle' && simulation.kind !== 'running' && simulation.key !== simulationKey}
          scenarioInvalid={scenario?.ok === false}
          selectedCount={selected.size}
          onRerun={applyAndSimulate}
        />
      </section>
    </div>
  );
}

interface SimulationViewProps {
  readonly state: SimulationState;
  readonly stale: boolean;
  readonly scenarioInvalid: boolean;
  readonly selectedCount: number;
  readonly onRerun: () => void;
}

function SimulationView({ state, stale, scenarioInvalid, selectedCount, onRerun }: SimulationViewProps) {
  if (scenarioInvalid) {
    return <p className="notice">The simulation needs a valid scenario. Fix the errors in the Scenario tab above.</p>;
  }
  const staleNotice = stale && (
    <div className="notice notice-stale">
      <p>The config, scenario or selection changed since this run.</p>
      <button type="button" onClick={onRerun}>
        Run it again
      </button>
    </div>
  );
  switch (state.kind) {
    case 'idle':
      return (
        <p className="hint">
          Runs the original and the mitigated config ({selectedCount} {selectedCount === 1 ? 'mitigation' : 'mitigations'})
          on the same traffic, with and without the fault: four runs, a few seconds in all.
        </p>
      );
    case 'running':
      return (
        <p className="running" role="status">
          <span className="spinner" aria-hidden="true" />
          Running the simulation (4 runs)…
        </p>
      );
    case 'failed':
      return (
        <>
          {staleNotice}
          <div className="notice notice-error" role="alert">
            <p>The simulation failed: {state.message}</p>
          </div>
        </>
      );
    case 'done':
      return (
        <>
          {staleNotice}
          <ErrorBoundary name="the simulation results">
            <ResultsPanel comparison={state.comparison} system={state.system} scenario={state.scenario} />
          </ErrorBoundary>
        </>
      );
  }
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
