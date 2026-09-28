// Step 4: what the simulation showed. A one-sentence verdict, the numbers side by side, notes where the data
// could be misread, and four charts that overlay the original (solid red) and mitigated (dashed teal) runs.
import { useState } from 'react';
import {
  CartesianGrid,
  Line,
  LineChart,
  ReferenceArea,
  ReferenceLine,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from 'recharts';
import type { Scenario, SystemConfig } from '../engine/config/schema';
import type { Comparison, SummarizedRun } from '../engine/simulator/compare';
import type { Recovery } from '../engine/simulator/recovery';
import { goodputRows, serviceRows, successRatioRows, type ChartRow, type ServiceMetric } from './chartData';
import { formatNumber } from './format';

interface Props {
  readonly comparison: Comparison;
  readonly system: SystemConfig;
  readonly scenario: Scenario;
}

export function ResultsPanel({ comparison, system, scenario }: Props) {
  const { original, mitigated } = comparison;
  const truncated = [original.withFaults, original.withoutFaults, mitigated.withFaults, mitigated.withoutFaults].filter(
    (run) => run.result.truncated,
  );
  return (
    <div className="results" data-testid="results">
      <Verdict comparison={comparison} scenario={scenario} />
      {truncated.map((run, index) => (
        <div key={index} className="notice notice-error" role="alert">
          <p>
            A run stopped early after {run.result.eventCount.toLocaleString('en-US')} events, at{' '}
            {formatNumber(run.result.endedAtMs / 1000)} s. Results after that point are missing, and its recovery is
            unknown. Shorten the scenario or lower the request rate to simulate it fully.
          </p>
        </div>
      ))}
      <SummaryTable comparison={comparison} scenario={scenario} />
      <DuringFaultNote comparison={comparison} scenario={scenario} />
      <Charts comparison={comparison} system={system} scenario={scenario} />
    </div>
  );
}

// ---------------------------------------------------------------------------
// Verdict and summary
// ---------------------------------------------------------------------------

function Verdict({ comparison, scenario }: { readonly comparison: Comparison; readonly scenario: Scenario }) {
  if (scenario.faults.length === 0) {
    return <p className="verdict">The scenario has no fault, so there is nothing to recover from. Add a fault to compare recovery.</p>;
  }
  const phrase = (recovery: Recovery) => {
    switch (recovery.status) {
      case 'recovered':
        return recovery.recoveryTimeMs === 0
          ? 'recovered as soon as it ended'
          : `recovered ${formatNumber((recovery.recoveryTimeMs ?? 0) / 1000)} s after it ended`;
      case 'not-recovered':
        return 'never recovered';
      case 'unknown':
        return 'did not show whether it recovers, because the run stopped early';
      case 'not-applicable':
        return 'was already failing before it';
    }
  };
  return (
    <p className="verdict">
      After {describeFaults(scenario)}, the <span className="swatch swatch-original">original config</span>{' '}
      {phrase(comparison.original.withFaults.summary.recovery)}; the{' '}
      <span className="swatch swatch-mitigated">mitigated config</span> {phrase(comparison.mitigated.withFaults.summary.recovery)}.
    </p>
  );
}

function SummaryTable({ comparison, scenario }: { readonly comparison: Comparison; readonly scenario: Scenario }) {
  const hasFaults = scenario.faults.length > 0;
  const percent = (value: number | null) => (value === null ? 'n/a' : `${formatNumber(value * 100)}%`);
  const perSecond = (value: number | null) => (value === null ? 'n/a' : `${formatNumber(value)}/s`);
  const rows: { label: string; value: (run: { withFaults: SummarizedRun; withoutFaults: SummarizedRun }) => string }[] = [
    ...(hasFaults
      ? [
          { label: 'Success before the fault', value: (r: RunPair) => percent(r.withFaults.summary.successRatio.before) },
          { label: 'Success during the fault', value: (r: RunPair) => percent(r.withFaults.summary.successRatio.during) },
          { label: 'Success after the fault', value: (r: RunPair) => percent(r.withFaults.summary.successRatio.after) },
          { label: 'Goodput after the fault', value: (r: RunPair) => perSecond(r.withFaults.summary.goodputPerSec.after) },
          { label: 'Recovery', value: (r: RunPair) => recoveryText(r.withFaults.summary.recovery) },
        ]
      : [{ label: 'Success', value: (r: RunPair) => percent(r.withFaults.summary.successRatio.before) }]),
    {
      label: 'Timeouts without the fault',
      value: (r: RunPair) =>
        `${r.withoutFaults.summary.timeouts.toLocaleString('en-US')} (${formatNumber(r.withoutFaults.summary.timeoutFraction * 100)}% of attempts)`,
    },
    { label: 'Most wasted work', value: (r: RunPair) => mostWasted(r.withFaults) },
  ];
  return (
    <table className="summary">
      <caption>Measured on the same traffic{hasFaults ? ', with the fault' : ''}; timeouts come from a second run without it.</caption>
      <thead>
        <tr>
          <th scope="col" />
          <th scope="col">
            <span className="swatch swatch-original">Original</span>
          </th>
          <th scope="col">
            <span className="swatch swatch-mitigated">Mitigated</span>
          </th>
        </tr>
      </thead>
      <tbody>
        {rows.map((row) => (
          <tr key={row.label}>
            <th scope="row">{row.label}</th>
            <td>{row.value(comparison.original)}</td>
            <td>{row.value(comparison.mitigated)}</td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}

type RunPair = { readonly withFaults: SummarizedRun; readonly withoutFaults: SummarizedRun };

function recoveryText(recovery: Recovery): string {
  switch (recovery.status) {
    case 'recovered':
      return `after ${formatNumber((recovery.recoveryTimeMs ?? 0) / 1000)} s`;
    case 'not-recovered':
      return 'did not recover';
    case 'unknown':
      return 'unknown (run stopped early)';
    case 'not-applicable':
      return 'not applicable';
  }
}

function mostWasted(run: SummarizedRun): string {
  const [service, fraction] = Object.entries(run.summary.wastedFraction).sort((a, b) => b[1] - a[1])[0] ?? ['', 0];
  return fraction < 0.005 ? 'none' : `${service}: ${formatNumber(fraction * 100)}% of its work`;
}

/**
 * Shown when the mitigated run also serves almost nothing during the fault but recovers afterwards, so that
 * a near-zero stretch on the mitigated line is not read as the mitigations failing.
 */
function DuringFaultNote({ comparison, scenario }: { readonly comparison: Comparison; readonly scenario: Scenario }) {
  const { summary } = comparison.mitigated.withFaults;
  if ((summary.successRatio.during ?? 1) >= 0.1 || summary.recovery.status !== 'recovered') return null;
  const lastEnd = Math.max(...scenario.faults.map((fault) => fault.endMs)) / 1000;
  return (
    <div className="notice notice-explain" data-testid="during-fault-note">
      <p>
        <strong>Both lines drop to near zero during the fault. That is expected.</strong> The slowed service can serve
        only a fraction of the traffic, and the mitigated queues are sized for normal speed, so requests that could not
        finish in time are dropped at once instead of being served after their caller gave up. The mitigations do not
        make a service faster; what they change is what happens after the fault. Compare the lines after {formatNumber(lastEnd)} s.
      </p>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Charts
// ---------------------------------------------------------------------------

function Charts({ comparison, system, scenario }: Props) {
  const services = Object.keys(system.services);
  const faulted = scenario.faults[0]?.service;
  const [service, setService] = useState(faulted && services.includes(faulted) ? faulted : (services[0] ?? ''));
  const [headline, setHeadline] = useState<'goodput' | 'ratio'>('goodput');
  const withFaults = { original: comparison.original.withFaults, mitigated: comparison.mitigated.withFaults };
  const { bucketMs } = scenario;
  const threshold = withFaults.mitigated.summary.recovery.thresholdRatio;
  const recoveredAt = withFaults.mitigated.summary.recovery.recoveredAtMs;

  const serviceChart = (metric: ServiceMetric) =>
    serviceRows(withFaults.original.result, withFaults.mitigated.result, service, metric, bucketMs);

  return (
    <div className="charts">
      <Legend hasFaults={scenario.faults.length > 0} />
      <figure className="chart chart-headline">
        <div className="chart-head">
          <figcaption>{headline === 'goodput' ? 'Successful requests per second' : 'Share of requests that succeed'}</figcaption>
          <div className="toggle" role="group" aria-label="Headline measure">
            <button type="button" aria-pressed={headline === 'goodput'} onClick={() => setHeadline('goodput')}>
              Goodput
            </button>
            <button type="button" aria-pressed={headline === 'ratio'} onClick={() => setHeadline('ratio')}>
              Success ratio
            </button>
          </div>
        </div>
        <p className="hint">
          {headline === 'goodput'
            ? 'Requests answered within the user deadline, per second. The shaded band is the fault.'
            : 'Of the requests that arrived in each 1 s window, the share answered in time. Recovery is measured on this: the mitigated run recovers once it stays above the dotted threshold.'}
        </p>
        {headline === 'goodput' ? (
          <TimeChart rows={goodputRows(withFaults.original.result, withFaults.mitigated.result, bucketMs)} scenario={scenario} unit="/s" height={280} />
        ) : (
          <TimeChart
            rows={successRatioRows(withFaults.original, withFaults.mitigated, system.entry.deadlineMs, scenario.recovery.windowMs, bucketMs)}
            scenario={scenario}
            unit="%"
            height={280}
            yMax={100}
            threshold={threshold === null ? undefined : threshold * 100}
            recoveredAtS={recoveredAt === null ? undefined : recoveredAt / 1000}
          />
        )}
      </figure>

      <div className="service-picker">
        <label htmlFor="service-picker">Service for the charts below</label>
        <select id="service-picker" value={service} onChange={(event) => setService(event.target.value)}>
          {services.map((name) => (
            <option key={name} value={name}>
              {name}
            </option>
          ))}
        </select>
      </div>
      <div className="chart-grid">
        <SmallChart title={`${service} queue depth`} hint="The most requests waiting at once. A queue that stays full after the fault is stuck." rows={serviceChart('maxQueueDepth')} scenario={scenario} unit="" />
        <SmallChart title={`Retries arriving at ${service}, per second`} hint="Extra attempts from callers that timed out or were rejected: the amplification." rows={serviceChart('retryArrivals')} scenario={scenario} unit="/s" />
        <SmallChart title={`${service} work wasted`} hint="The share of its busy time spent on requests whose caller had already given up." rows={serviceChart('wastedFraction')} scenario={scenario} unit="%" yMax={100} />
      </div>
    </div>
  );
}

function Legend({ hasFaults }: { readonly hasFaults: boolean }) {
  return (
    <ul className="legend" aria-label="Legend">
      <li>
        <svg width="28" height="10" aria-hidden="true">
          <line x1="0" y1="5" x2="28" y2="5" className="legend-original" />
        </svg>
        Original config (solid)
      </li>
      <li>
        <svg width="28" height="10" aria-hidden="true">
          <line x1="0" y1="5" x2="28" y2="5" className="legend-mitigated" />
        </svg>
        Mitigated config (dashed)
      </li>
      {hasFaults && (
        <li>
          <span className="legend-fault" aria-hidden="true" />
          Fault
        </li>
      )}
    </ul>
  );
}

interface TimeChartProps {
  readonly rows: readonly ChartRow[];
  readonly scenario: Scenario;
  readonly unit: string;
  readonly height: number;
  readonly yMax?: number;
  readonly threshold?: number;
  readonly recoveredAtS?: number;
}

function SmallChart({ title, hint, ...chart }: Omit<TimeChartProps, 'height'> & { readonly title: string; readonly hint: string }) {
  return (
    <figure className="chart">
      <figcaption>{title}</figcaption>
      <p className="hint">{hint}</p>
      <TimeChart {...chart} height={180} />
    </figure>
  );
}

function TimeChart({ rows, scenario, unit, height, yMax, threshold, recoveredAtS }: TimeChartProps) {
  const format = (value: unknown) => (typeof value === 'number' ? `${formatNumber(value)}${unit}` : 'n/a');
  return (
    <ResponsiveContainer width="100%" height={height}>
      <LineChart data={[...rows]} margin={{ top: 8, right: 16, bottom: 4, left: 0 }}>
        <CartesianGrid vertical={false} className="chart-grid-lines" />
        {scenario.faults.map((fault, index) => (
          <ReferenceArea key={index} x1={fault.startMs / 1000} x2={fault.endMs / 1000} fill="var(--fault)" fillOpacity={0.8} ifOverflow="extendDomain" />
        ))}
        <XAxis
          dataKey="t"
          type="number"
          domain={[0, scenario.durationMs / 1000]}
          tickFormatter={(value: number) => `${value} s`}
          tickLine={false}
          className="chart-axis"
        />
        <YAxis
          domain={[0, yMax ?? 'auto']}
          tickFormatter={(value: number) => `${formatNumber(value)}${unit}`}
          tickLine={false}
          axisLine={false}
          width={56}
          className="chart-axis"
        />
        {threshold !== undefined && (
          <ReferenceLine y={threshold} className="chart-threshold" strokeDasharray="2 4" label={{ value: 'Recovery threshold', position: 'insideBottomLeft' }} />
        )}
        {recoveredAtS !== undefined && (
          <ReferenceLine x={recoveredAtS} className="chart-recovered" label={{ value: 'Mitigated recovers', position: 'insideTopRight' }} />
        )}
        <Tooltip
          formatter={(value, name) => [format(value), name === 'original' ? 'Original' : 'Mitigated']}
          labelFormatter={(label) => `${formatNumber(Number(label))} s`}
        />
        <Line type="linear" dataKey="original" className="line-original" stroke="var(--original)" strokeWidth={2} dot={false} isAnimationActive={false} connectNulls={false} />
        <Line
          type="linear"
          dataKey="mitigated"
          className="line-mitigated"
          stroke="var(--mitigated)"
          strokeWidth={2}
          strokeDasharray="6 4"
          dot={false}
          isAnimationActive={false}
          connectNulls={false}
        />
      </LineChart>
    </ResponsiveContainer>
  );
}

/** "the fault on db (10–20 s)", or several joined. */
function describeFaults(scenario: Scenario): string {
  const parts = scenario.faults.map((fault) => {
    const effect =
      fault.latencyMultiplier !== undefined && fault.latencyMultiplier !== 1
        ? `slowed ${formatNumber(fault.latencyMultiplier)}×`
        : `failing ${formatNumber((fault.errorRate ?? 0) * 100)}% of requests`;
    return `${fault.service} was ${effect} from ${formatNumber(fault.startMs / 1000)} to ${formatNumber(fault.endMs / 1000)} s`;
  });
  return parts.length === 1 ? `${parts[0]}` : parts.join(', and ');
}
