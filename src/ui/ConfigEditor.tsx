// Step 1: the two YAML documents, edited as text, with every validation error listed by field path.
import { useState } from 'react';
import type { ConfigError } from '../engine/config/result';

export type ConfigTab = 'system' | 'scenario';

interface Props {
  readonly systemText: string;
  readonly scenarioText: string;
  readonly systemErrors: readonly ConfigError[];
  /** Null when the scenario was not checked because the system is invalid. */
  readonly scenarioErrors: readonly ConfigError[] | null;
  readonly onSystemChange: (text: string) => void;
  readonly onScenarioChange: (text: string) => void;
  readonly onLoadDemo: () => void;
}

export function ConfigEditor(props: Props) {
  const [tab, setTab] = useState<ConfigTab>('system');
  const errors = tab === 'system' ? props.systemErrors : (props.scenarioErrors ?? []);
  const tabLabel = (name: ConfigTab, label: string, count: number) => (
    <button
      type="button"
      role="tab"
      aria-selected={tab === name}
      className={`tab${tab === name ? ' tab-active' : ''}`}
      onClick={() => setTab(name)}
    >
      {label}
      {count > 0 && <span className="tab-count">{count}</span>}
    </button>
  );

  return (
    <div className="editor">
      <div className="editor-bar">
        <div role="tablist" aria-label="Configuration documents">
          {tabLabel('system', 'System', props.systemErrors.length)}
          {tabLabel('scenario', 'Scenario', props.scenarioErrors?.length ?? 0)}
        </div>
        <button type="button" className="button-quiet" onClick={props.onLoadDemo}>
          Load demo
        </button>
      </div>
      <p className="hint">
        {tab === 'system'
          ? 'Services, their calls and their resilience settings. The analyzer reads only this.'
          : 'Traffic and faults for the simulation: arrival rate, run length, and what goes wrong when.'}
      </p>
      <textarea
        className="code"
        aria-label={tab === 'system' ? 'System config (YAML)' : 'Scenario (YAML)'}
        spellCheck={false}
        value={tab === 'system' ? props.systemText : props.scenarioText}
        onChange={(event) =>
          tab === 'system' ? props.onSystemChange(event.target.value) : props.onScenarioChange(event.target.value)
        }
      />
      {tab === 'scenario' && props.scenarioErrors === null && (
        <p className="notice">The scenario is checked once the system config is valid.</p>
      )}
      {errors.length > 0 && (
        <div className="notice notice-error" role="alert">
          <p>
            {errors.length === 1 ? '1 error' : `${errors.length} errors`} in the {tab === 'system' ? 'system config' : 'scenario'}:
          </p>
          <ul className="error-list">
            {errors.map((error, index) => (
              <li key={index}>
                {error.path && <code>{error.path}</code>} {error.message}
              </li>
            ))}
          </ul>
        </div>
      )}
    </div>
  );
}
