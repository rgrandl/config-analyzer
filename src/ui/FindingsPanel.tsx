// Steps 2 and 3: the findings with their recommended mitigations, and what applying them changed.
import type { Analysis } from '../engine/analyzer/analyze';
import type { Finding, Target } from '../engine/analyzer/finding';
import type { AppliedPatch, MitigationResult } from '../engine/analyzer/mitigation/applyMitigations';
import { patchLine, targetLabel } from './format';

export type MitigationState =
  | { readonly kind: 'none' }
  | { readonly kind: 'applied'; readonly result: MitigationResult; readonly yaml: string; readonly stale: boolean }
  | { readonly kind: 'failed'; readonly message: string };

// ---------------------------------------------------------------------------
// Findings
// ---------------------------------------------------------------------------

interface FindingsProps {
  readonly analysis: Analysis;
  readonly selected: ReadonlySet<string>;
  readonly highlightedId: string | undefined;
  readonly onToggle: (id: string) => void;
  readonly onSelectAll: (all: boolean) => void;
  readonly onHighlight: (id: string | undefined) => void;
}

export function FindingsList({ analysis, selected, highlightedId, onToggle, onSelectAll, onHighlight }: FindingsProps) {
  const { findings, graph } = analysis;
  const calleeOf = (service: string, call: string) => graph.callsOf(service).find((e) => e.config.name === call)?.callee;

  if (findings.length === 0) {
    return <p className="notice">No findings. You can still simulate the config below.</p>;
  }
  const withMitigation = findings.filter((finding) => finding.mitigation);
  return (
    <div className="findings">
      <div className="findings-bar">
        <p>
          {findings.length} {findings.length === 1 ? 'finding' : 'findings'}, {selected.size} selected
        </p>
        <button type="button" className="button-quiet" onClick={() => onSelectAll(selected.size < withMitigation.length)}>
          {selected.size < withMitigation.length ? 'Select all' : 'Select none'}
        </button>
      </div>
      <ul className="finding-list">
        {findings.map((finding) => (
          <FindingItem
            key={finding.id}
            finding={finding}
            label={targetLabel(finding.target, calleeOf)}
            checked={selected.has(finding.id)}
            highlighted={finding.id === highlightedId}
            onToggle={() => onToggle(finding.id)}
            onHighlight={() => onHighlight(finding.id === highlightedId ? undefined : finding.id)}
          />
        ))}
      </ul>
    </div>
  );
}

interface FindingItemProps {
  readonly finding: Finding;
  readonly label: string;
  readonly checked: boolean;
  readonly highlighted: boolean;
  readonly onToggle: () => void;
  readonly onHighlight: () => void;
}

function FindingItem({ finding, label, checked, highlighted, onToggle, onHighlight }: FindingItemProps) {
  const { mitigation } = finding;
  return (
    <li className={`finding${highlighted ? ' finding-highlighted' : ''}`} data-testid="finding">
      <div className="finding-head">
        <input
          type="checkbox"
          aria-label={`Apply the mitigation for: ${finding.title}`}
          checked={checked}
          disabled={!mitigation}
          onChange={onToggle}
        />
        <button type="button" className="finding-title" aria-pressed={highlighted} onClick={onHighlight}>
          <span className={`severity severity-${finding.severity}`}>{finding.severity === 'high' ? 'High' : 'Medium'}</span>
          {finding.title}
        </button>
      </div>
      <p className="finding-target">{label}</p>
      <p className="finding-text">{finding.explanation}</p>
      {mitigation ? (
        <div className="finding-fix">
          <p>{mitigation.summary}</p>
          <ul>
            {mitigation.patches.map((patch) => (
              <li key={patch.field}>
                <code>{patchLine(patch)}</code>
              </li>
            ))}
          </ul>
        </div>
      ) : (
        <p className="finding-fix finding-fix-none">No safe automatic mitigation: this one needs a person to decide.</p>
      )}
    </li>
  );
}

// ---------------------------------------------------------------------------
// Mitigation result
// ---------------------------------------------------------------------------

interface ResultProps {
  readonly state: MitigationState;
  readonly analysis: Analysis;
  readonly onReapply: () => void;
  readonly onCopyIntoEditor: (yaml: string) => void;
}

export function MitigationView({ state, analysis, onReapply, onCopyIntoEditor }: ResultProps) {
  if (state.kind === 'none') {
    return <p className="hint">Select the mitigations to try, then apply them to get a mitigated config to compare.</p>;
  }
  if (state.kind === 'failed') {
    return (
      <div className="notice notice-error" role="alert">
        <p>Applying the mitigations failed: {state.message}</p>
        <p>The original config and its findings are unchanged.</p>
      </div>
    );
  }

  const { result, yaml, stale } = state;
  const calleeOf = (service: string, call: string) =>
    analysis.graph.callsOf(service).find((e) => e.config.name === call)?.callee;
  return (
    <div className="mitigation" data-testid="mitigation-result">
      {stale && (
        <div className="notice notice-stale">
          <p>Out of date: the config or the selection changed after these mitigations were applied.</p>
          <button type="button" onClick={onReapply}>
            Apply again
          </button>
        </div>
      )}
      <p className="mitigation-summary">
        {result.applied.length} {result.applied.length === 1 ? 'change' : 'changes'} applied.{' '}
        {result.unresolved.length === 0 && result.introduced.length === 0
          ? 'A re-check of the mitigated config finds nothing left.'
          : `A re-check finds ${result.unresolved.length} still unresolved and ${result.introduced.length} new.`}
      </p>
      <ul className="patch-list">
        {result.applied.map((patch) => (
          <li key={`${targetLabel(patch.target)}#${patch.field}`}>
            <span className="patch-target">{targetLabel(patch.target, calleeOf)}</span>
            <code>{patchLine(patch)}</code>
          </li>
        ))}
      </ul>
      <NotNeeded patches={result.notNeeded} label={(target) => targetLabel(target, calleeOf)} />
      <RemainingFindings title="Still unresolved" findings={result.unresolved} />
      <RemainingFindings title="New after mitigation" findings={result.introduced} />
      <details className="mitigated-yaml">
        <summary>Mitigated config (YAML)</summary>
        <pre className="code">{yaml}</pre>
        <button type="button" className="button-quiet" onClick={() => onCopyIntoEditor(yaml)}>
          Copy into the editor
        </button>
      </details>
    </div>
  );
}

/** Retry guards left out because their call makes a single attempt now; one line per call. */
function NotNeeded({
  patches,
  label,
}: {
  readonly patches: readonly AppliedPatch[];
  readonly label: (target: Target) => string;
}) {
  if (patches.length === 0) return null;
  const byCall = new Map<string, { target: Target; fields: string[] }>();
  for (const patch of patches) {
    const key = targetLabel(patch.target);
    const entry = byCall.get(key) ?? { target: patch.target, fields: [] };
    entry.fields.push(patch.field);
    byCall.set(key, entry);
  }
  return (
    <div className="remaining">
      <p>Not needed ({patches.length})</p>
      <ul>
        {[...byCall.entries()].map(([key, { target, fields }]) => (
          <li key={key}>
            {label(target)} makes a single attempt now, so {fields.join(' and ')}{' '}
            {fields.length === 1 ? 'has' : 'have'} no effect and {fields.length === 1 ? 'is' : 'are'} left out.
          </li>
        ))}
      </ul>
    </div>
  );
}

function RemainingFindings({ title, findings }: { readonly title: string; readonly findings: readonly Finding[] }) {
  if (findings.length === 0) return null;
  return (
    <div className="remaining">
      <p>
        {title} ({findings.length})
      </p>
      <ul>
        {findings.map((finding) => (
          <li key={finding.id}>{finding.title}</li>
        ))}
      </ul>
    </div>
  );
}
