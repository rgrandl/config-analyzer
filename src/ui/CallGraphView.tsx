// Step 2, top: the call graph. Services are laid out by depth from the entry: left to right on wide screens,
// top to bottom on narrow ones. Each edge lists the calls over it with their timeout and attempts. Badges
// count a service's findings, including those on the calls it makes; the selected finding is highlighted.
import { useEffect, useState } from 'react';
import type { Analysis } from '../engine/analyzer/analyze';
import type { Finding, Severity } from '../engine/analyzer/finding';
import type { CallGraph } from '../engine/config/callGraph';
import type { SystemConfig } from '../engine/config/schema';
import { formatNumber } from './format';

interface Props {
  readonly system: SystemConfig;
  readonly analysis: Analysis;
  readonly highlighted: Finding | undefined;
}

type Orientation = 'horizontal' | 'vertical';

const NODE_WIDTH = 168;
const NODE_HEIGHT = 62;
const PADDING = 20;
/** Space between depth levels: room for the edge labels. */
const LEVEL_GAP = { horizontal: 200, vertical: 92 } as const;
/** Space between services at the same depth. */
const SIBLING_GAP = { horizontal: 40, vertical: 24 } as const;
const LABEL_LINE = 16;
/** In the vertical layout, labels sit to the right of the edges and need room there. */
const LABEL_ROOM_VERTICAL = 190;

export function CallGraphView({ system, analysis, highlighted }: Props) {
  const orientation = useOrientation();
  const { graph, findings } = analysis;
  const positions = layout(graph, system.entry.service, orientation);
  const labelRoom = orientation === 'vertical' ? LABEL_ROOM_VERTICAL : 0;
  const width = Math.max(...[...positions.values()].map((p) => p.x)) + NODE_WIDTH + PADDING + labelRoom;
  const height = Math.max(...[...positions.values()].map((p) => p.y)) + NODE_HEIGHT + PADDING;
  const at = (service: string) => positions.get(service) ?? { x: 0, y: 0 };

  // One drawn edge per caller → callee pair; its label lists each call made over it.
  const pairs = new Map<string, { caller: string; callee: string; calls: string[]; lines: string[] }>();
  for (const edge of graph.calls) {
    const key = `${edge.caller}→${edge.callee}`;
    const pair = pairs.get(key) ?? { caller: edge.caller, callee: edge.callee, calls: [], lines: [] };
    pair.calls.push(edge.config.name);
    pair.lines.push(`${edge.config.name}: ${formatNumber(edge.config.timeoutMs)} ms × ${edge.config.maxAttempts}`);
    pairs.set(key, pair);
  }

  return (
    <svg
      className={`graph graph-${orientation}`}
      viewBox={`0 0 ${width} ${height}`}
      role="img"
      aria-label={`Call graph: ${graph.calls.map((edge) => `${edge.caller} calls ${edge.callee}`).join(', ')}`}
    >
      <defs>
        <marker id="arrow" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="9" markerHeight="9" markerUnits="userSpaceOnUse" orient="auto">
          <path d="M0 0L10 5L0 10z" className="graph-arrow" />
        </marker>
      </defs>
      {[...pairs.values()].map((pair) => {
        const from = at(pair.caller);
        const to = at(pair.callee);
        const horizontal = orientation === 'horizontal';
        const [x1, y1] = horizontal ? [from.x + NODE_WIDTH, from.y + NODE_HEIGHT / 2] : [from.x + NODE_WIDTH / 2, from.y + NODE_HEIGHT];
        const [x2, y2] = horizontal ? [to.x - 3, to.y + NODE_HEIGHT / 2] : [to.x + NODE_WIDTH / 2, to.y - 3];
        const active =
          highlighted?.target.call !== undefined &&
          highlighted.target.service === pair.caller &&
          pair.calls.includes(highlighted.target.call);
        // Labels sit above a horizontal edge and to the right of a vertical one, clear of the line.
        const labelX = horizontal ? (x1 + x2) / 2 : x1 + 10;
        const firstLabelY = horizontal
          ? (y1 + y2) / 2 - 10 - (pair.lines.length - 1) * LABEL_LINE
          : (y1 + y2) / 2 - ((pair.lines.length - 1) * LABEL_LINE) / 2 + 4;
        return (
          <g key={`${pair.caller}→${pair.callee}`} className={active ? 'graph-edge graph-active' : 'graph-edge'}>
            <line x1={x1} y1={y1} x2={x2} y2={y2} markerEnd="url(#arrow)" />
            {pair.lines.map((line, index) => (
              <text
                key={line}
                x={labelX}
                y={firstLabelY + index * LABEL_LINE}
                textAnchor={horizontal ? 'middle' : 'start'}
                className="graph-label"
              >
                {line}
              </text>
            ))}
          </g>
        );
      })}
      {graph.services.map((service) => {
        const { x, y } = at(service);
        const config = system.services[service];
        const own = findings.filter((finding) => finding.target.service === service);
        const active = highlighted?.target.service === service && highlighted.target.call === undefined;
        const queue = config?.queueCapacity === 'unbounded' ? 'unbounded queue' : `queue ${config?.queueCapacity}`;
        return (
          <g key={service} className={active ? 'graph-node graph-active' : 'graph-node'}>
            <rect x={x} y={y} width={NODE_WIDTH} height={NODE_HEIGHT} rx="6" />
            <text x={x + 14} y={y + 25} className="graph-name">
              {service}
            </text>
            <text x={x + 14} y={y + 45} className="graph-meta">
              {config?.workers} workers, {queue}
            </text>
            {own.length > 0 && (
              <g className={`graph-badge badge-${worst(own)}`}>
                <circle cx={x + NODE_WIDTH - 2} cy={y + 2} r="12" />
                <text x={x + NODE_WIDTH - 2} y={y + 6} textAnchor="middle">
                  {own.length}
                </text>
              </g>
            )}
          </g>
        );
      })}
    </svg>
  );
}

/** Depth = longest call path from the entry; services at the same depth keep declaration order. */
function layout(graph: CallGraph, entry: string, orientation: Orientation): Map<string, { x: number; y: number }> {
  const depth = new Map<string, number>([[entry, 0]]);
  for (const service of graph.topologicalOrder()) {
    for (const edge of graph.callsOf(service)) {
      depth.set(edge.callee, Math.max(depth.get(edge.callee) ?? 0, (depth.get(service) ?? 0) + 1));
    }
  }
  const siblings = new Map<number, number>();
  const positions = new Map<string, { x: number; y: number }>();
  for (const service of graph.services) {
    const level = depth.get(service) ?? 0;
    const index = siblings.get(level) ?? 0;
    siblings.set(level, index + 1);
    const along = level * ((orientation === 'horizontal' ? NODE_WIDTH : NODE_HEIGHT) + LEVEL_GAP[orientation]);
    const across = index * ((orientation === 'horizontal' ? NODE_HEIGHT : NODE_WIDTH) + SIBLING_GAP[orientation]);
    positions.set(
      service,
      orientation === 'horizontal'
        ? { x: PADDING + along, y: PADDING + 14 + across }
        : { x: PADDING + across, y: PADDING + 14 + along },
    );
  }
  return positions;
}

/** Top-to-bottom on narrow screens, where a left-to-right graph would shrink its text below reading size. */
function useOrientation(): Orientation {
  const query = '(max-width: 700px)';
  const matches = () => typeof window !== 'undefined' && typeof window.matchMedia === 'function' && window.matchMedia(query).matches;
  const [narrow, setNarrow] = useState(matches);
  useEffect(() => {
    if (typeof window.matchMedia !== 'function') return;
    const list = window.matchMedia(query);
    const update = () => setNarrow(list.matches);
    list.addEventListener('change', update);
    return () => list.removeEventListener('change', update);
  }, []);
  return narrow ? 'vertical' : 'horizontal';
}

function worst(findings: readonly Finding[]): Severity {
  return findings.some((finding) => finding.severity === 'high') ? 'high' : 'medium';
}
