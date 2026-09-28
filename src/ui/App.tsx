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
  // Set when a run finishes; the scroll waits for the results to render.
  const scrollToResults = useRef(false);
  useEffect(() => {
    if (!scrollToResults.current) return;
    scrollToResults.current = false;
    simulateStep.current?.scrollIntoView?.({ behavior: 'smooth', block: 'start' });
  });

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
  const isDemo = systemText === DEMO_SYSTEM_YAML && scenarioText === DEMO_SCENARIO_YAML;
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
    if (!mitigated) {
      mitigateStep.current?.scrollIntoView?.({ behavior: 'smooth', block: 'start' });
      return;
    }
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
    // Once there is something to see (results or an error), bring it into view; not after a cancel.
    if (!controller.signal.aborted) scrollToResults.current = true;
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

  /** Back to the first visit: the demo, everything selected, no results. */
  function resetDemo() {
    running.current?.abort();
    setSystemText(DEMO_SYSTEM_YAML);
    setScenarioText(DEMO_SCENARIO_YAML);
    setDeselected(new Set());
    setHighlightedId(undefined);
    setMitigation({ state: { kind: 'none' }, key: '' });
    setSimulation({ kind: 'idle' });
  }

  return (
    <div className="page">
      <header className="hero">
        <h1>Config Interaction Analyzer</h1>
        <p className="lede">
          In a system of services, each team tunes its own settings, and each choice can be reasonable on its own while
          the combination fails under stress. This tool analyzes a service call graph for settings that are risky
          together, recommends a conservative change for each, and simulates both configurations under the same fault
          to show the difference.
        </p>
        <p className="lede-scope">This version covers resilience settings: timeouts, retries, backoff, deadlines and queues.</p>
        <div className="hero-action">
          <HeroStatus
            valid={system.ok}
            services={system.ok ? Object.keys(system.value.services) : []}
            high={findings.filter((finding) => finding.severity === 'high').length}
            total={findings.length}
          />
          {scenario?.ok === false ? (
            <button type="button" className="button-primary" disabled={!analysis?.ok || selected.size === 0} onClick={apply}>
              Apply {selected.size} {selected.size === 1 ? 'mitigation' : 'mitigations'}
            </button>
          ) : (
            <div className="shortcut">
              <button type="button" className="button-primary" disabled={!canSimulate} onClick={applyAndSimulate}>
                {simulation.kind === 'running'
                  ? 'Simulating…'
                  : shortcutLabel(isDemo, selected.size, findings.filter((finding) => finding.mitigation).length)}
              </button>
              <a className="walk-through" href="#step-configure">
                or walk through the steps below <span aria-hidden="true">↓</span>
              </a>
            </div>
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
            {isDemo
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
            onResetDemo={resetDemo}
            isDemo={isDemo}
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

/**
 * The top button is a shortcut through steps 3 and 4: "Quick demo: apply all 12 fixes and simulate" on the
 * untouched demo, otherwise "Shortcut: apply 9 selected fixes and simulate".
 */
function shortcutLabel(isDemo: boolean, selected: number, fixable: number): string {
  if (selected === 0) return 'Shortcut: simulate the config';
  const fixes = selected === 1 ? 'fix' : 'fixes';
  const which = selected === fixable ? `all ${selected}` : `${selected} selected`;
  return `${isDemo && selected === fixable ? 'Quick demo' : 'Shortcut'}: apply ${which} ${fixes} and simulate`;
}

/** The hook: how many findings, how many high, and on which services. */
function HeroStatus({ valid, services, high, total }: { valid: boolean; services: string[]; high: number; total: number }) {
  if (!valid) return <p className="hero-status">Fix the system config to see its findings.</p>;
  if (total === 0) return <p className="hero-status">No findings: nothing in this config is risky in combination.</p>;
  return (
    <div className="hero-status">
      <p className="hero-count">
        {total} {total === 1 ? 'finding' : 'findings'}
      </p>
      <p className="hero-detail">
        {high} high · {total - high} medium, across {services.join(', ')}.
      </p>
    </div>
  );
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
        <div className="preview">
          <p>
            <strong>Results appear here:</strong> whether each config recovers from the fault, the numbers side by
            side, and charts of both runs.
          </p>
          <p className="hint">
            Runs the original and the mitigated config ({selectedCount} {selectedCount === 1 ? 'fix' : 'fixes'}) on the
            same traffic, with and without the fault.
          </p>
        </div>
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
