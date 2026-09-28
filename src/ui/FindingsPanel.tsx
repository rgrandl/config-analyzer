// Steps 2 and 3: the findings with their recommended mitigations, and what applying them changed.
import type { Analysis } from '../engine/analyzer/analyze';
import { useId, useState } from 'react';
import type { Finding, Severity, Target } from '../engine/analyzer/finding';
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
  const { findings } = analysis;
  if (findings.length === 0) {
    return <p className="notice">No findings. You can still simulate the config below.</p>;
  }
  const withMitigation = findings.filter((finding) => finding.mitigation);
  // High first; within a severity, the analyzer's order (by rule, then by position in the graph).
  const sorted = [...findings].sort((a, b) => SEVERITY_ORDER[a.severity] - SEVERITY_ORDER[b.severity]);
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
      <Glossary />
      <ul className="finding-list">
        {sorted.map((finding) => (
          <FindingItem
            key={finding.id}
            finding={finding}
            checked={selected.has(finding.id)}
            highlighted={finding.id === highlightedId}
            onToggle={() => onToggle(finding.id)}
            onHighlight={(on) => onHighlight(on ? finding.id : undefined)}
          />
        ))}
      </ul>
    </div>
  );
}

const SEVERITY_ORDER: Record<Severity, number> = { high: 0, medium: 1 };

/** Four terms the findings use, one sentence each. */
function Glossary() {
  return (
    <details className="glossary">
      <summary>What the terms mean</summary>
      <dl>
        <dt>Backoff and jitter</dt>
        <dd>Waiting a growing, randomized delay before each retry, so retries do not arrive all at once.</dd>
        <dt>Retry budget</dt>
        <dd>A cap on retries as a share of normal requests (here 10%), so retries cannot multiply the load.</dd>
        <dt>Deadline propagation</dt>
        <dd>Passing the caller's remaining time along with a request, so every service can drop work nobody waits for.</dd>
        <dt>Goodput</dt>
        <dd>Requests answered successfully within the user's deadline, per second.</dd>
      </dl>
    </details>
  );
}

interface FindingItemProps {
  readonly finding: Finding;
  readonly checked: boolean;
  readonly highlighted: boolean;
  readonly onToggle: () => void;
  readonly onHighlight: (on: boolean) => void;
}

/**
 * Two lines by default: severity and title, then the fix. "Why?" (or the title) opens the explanation and
 * highlights the finding in the graph.
 */
function FindingItem({ finding, checked, highlighted, onToggle, onHighlight }: FindingItemProps) {
  const { mitigation } = finding;
  const [open, setOpen] = useState(false);
  const explanationId = useId();
  const toggleOpen = () => {
    setOpen(!open);
    onHighlight(!open);
  };
  const single = mitigation?.patches.length === 1 ? mitigation.patches[0] : undefined;
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
        <button type="button" className="finding-title" aria-expanded={open} aria-controls={explanationId} onClick={toggleOpen}>
          <span className={`severity severity-${finding.severity}`}>{finding.severity === 'high' ? 'High' : 'Medium'}</span>
          {finding.title}
        </button>
        <button type="button" className="why" aria-expanded={open} aria-controls={explanationId} onClick={toggleOpen}>
          {open ? 'Hide' : 'Why?'}
        </button>
      </div>
      <p className={`finding-fix${mitigation ? '' : ' finding-fix-none'}`}>
        {mitigation ? (
          <>
            <span className="fix-label">Fix:</span> {mitigation.summary}
            {single && <code>{patchLine(single)}</code>}
          </>
        ) : (
          'No safe automatic fix: this one needs a person to decide.'
        )}
      </p>
      {open && (
        <div className="finding-more" id={explanationId}>
          <p>{finding.explanation}</p>
          {mitigation && !single && (
            <ul className="finding-patches">
              {mitigation.patches.map((patch) => (
                <li key={patch.field}>
                  <code>{patchLine(patch)}</code>
                </li>
              ))}
            </ul>
          )}
        </div>
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
    return (
      <div className="preview">
        <p>
          <strong>The mitigated config appears here:</strong> every change applied, and a re-check of what is left.
        </p>
        <p className="hint">Select the fixes to try above, then apply them.</p>
      </div>
    );
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
