import { useState, useCallback, useEffect, useContext, createContext, useRef, useMemo } from 'react';
import {
  ReactFlow, Background, MiniMap, Controls,
  useNodesState, useEdgesState, useReactFlow,
  type Node, type Edge,
  Position, BackgroundVariant, MarkerType,
  Handle,
  type NodeProps, type EdgeProps,
} from '@xyflow/react';
import dagre from 'dagre';
import { getLC } from './canvasTheme';
import { postMessage } from './vscode';
import type { LineageGraph, ModelNode, ColumnEdge as GColumnEdge, ModelEdge as GModelEdge, ExtensionMessage, AiEdgeQuery, AiEdgeResult } from '../../src/lineage/graphTypes';

// ── Theme (dark-only — VS Code webview) ───────────────────────────────────────

const T = {
  bg: '#0a0a0a', panel: '#111111', secondary: '#1a1a1a', hover: '#1a1a1a', border: '#1a1a1a',
  text: '#fafafa', muted: '#737373', faint: '#404040', rfBg: '#0a0a0a', rfDot: '#1a1a1a',
};

// ── Transform colors — exact match with VORO ──────────────────────────────────

const TRANSFORM_COLORS: Record<string, string> = {
  passthrough: '#0066ff',
  rename:      '#00cc66',
  transform:   '#ffaa00',
  aggregate:   '#9933ff',
  unknown:     '#6b7280',
};

/** Colours for edges that were not proven from SQL. Deliberately outside the
 *  transform palette so a guess can never be mistaken for a parsed fact. */
const TIER_COLORS: Record<Exclude<EdgeTier, 'parsed'>, string> = {
  likely:   '#94a3b8', // slate — plausible but unproven
  conflict: '#ef4444', // red   — same name, different type
  unknown:  '#52525b', // dim   — nothing established
};

const TRANSFORM_META: Record<string, { label: string; desc: string }> = {
  passthrough: { label: 'Passthrough', desc: 'Column unchanged from source' },
  rename:      { label: 'Rename',      desc: 'Same data, different name (old AS new)' },
  transform:   { label: 'Transform',   desc: 'Computed via CASE, COALESCE, functions' },
  aggregate:   { label: 'Aggregate',   desc: 'Computed via COUNT, SUM, AVG, etc.' },
};

// ── Internal API types (same shape as VORO) ───────────────────────────────────

interface ApiNode {
  id: string; name: string; type: string; layer: string;
  columns: string[]; is_analyzed: boolean; file_path: string | null;
  /** lowercased column name → data type, when the catalog provides one. */
  columnTypes: Record<string, string | null>;
}

/**
 * How much to trust an edge:
 *  parsed   — proven from SQL
 *  likely   — column names and data types match, but no mapping was parsed
 *  conflict — names match while types disagree; probably not the same data
 *  unknown  — models are connected, nothing else could be established
 */
type EdgeTier = 'parsed' | 'likely' | 'conflict' | 'unknown';

interface ApiColEdge {
  id: string;
  source_node_id: string; source_column: string;
  target_node_id: string; target_column: string;
  transform_type: string; transform_expression: string | null;
  analyzed_by: 'sql' | 'llm';
  tier?: EdgeTier;
  src_type?: string | null;
  tgt_type?: string | null;
}
interface ApiModelEdge { source_node_id: string; target_node_id: string; }

// ── Adapters: extension graph → VORO internal types ──────────────────────────

function toApiNode(m: ModelNode): ApiNode {
  const columnTypes: Record<string, string | null> = {};
  for (const c of m.columns) columnTypes[c.name.toLowerCase()] = c.dataType;
  return {
    id: m.id, name: m.name, type: m.resourceType, layer: m.layer,
    columns: m.columns.map(c => c.name),
    is_analyzed: m.parseStatus === 'parsed',
    file_path: m.filePath,
    columnTypes,
  };
}
function toApiColEdge(e: GColumnEdge): ApiColEdge {
  return {
    id: e.id,
    source_node_id: e.sourceModelId,
    source_column: e.sourceColumnId.split('::')[1] ?? e.sourceColumnId,
    target_node_id: e.targetModelId,
    target_column: e.targetColumnId.split('::')[1] ?? e.targetColumnId,
    transform_type: e.transformationType,
    transform_expression: e.transformExpression,
    analyzed_by: 'sql',
  };
}
function toApiModelEdge(e: GModelEdge): ApiModelEdge {
  return { source_node_id: e.sourceModelId, target_node_id: e.targetModelId };
}

// ── dbt selector parsing ──────────────────────────────────────────────────────
// [N+]name[+M]  e.g. "+orders", "orders+2", "+2orders+", "orders"

interface Selector { name: string; upstream: number; downstream: number }

function parseSelector(raw: string): Selector | null {
  let s = raw.trim();
  if (!s) return null;
  let upstream = 0, downstream = 0;

  // Upstream prefix: N+ (dbt standard, e.g. 2+model), +N (e.g. +2model), or bare +
  const preNumPlus  = s.match(/^(\d+)\+/);
  const prePlusNum  = s.match(/^\+(\d+)/);
  const prePlusOnly = !preNumPlus && !prePlusNum && s.startsWith('+');
  if (preNumPlus)       { upstream = parseInt(preNumPlus[1], 10); s = s.slice(preNumPlus[0].length); }
  else if (prePlusNum)  { upstream = parseInt(prePlusNum[1], 10); s = s.slice(prePlusNum[0].length); }
  else if (prePlusOnly) { upstream = Infinity; s = s.slice(1); }

  // Downstream suffix: +N or bare +
  const sufPlusNum  = s.match(/\+(\d+)$/);
  const sufPlusOnly = !sufPlusNum && s.endsWith('+');
  if (sufPlusNum)       { downstream = parseInt(sufPlusNum[1], 10); s = s.slice(0, s.length - sufPlusNum[0].length); }
  else if (sufPlusOnly) { downstream = Infinity; s = s.slice(0, s.length - 1); }

  const name = s.trim();
  if (!name || !/^[a-z_*][a-z0-9_*]*$/i.test(name)) return null;
  return { name, upstream, downstream };
}

interface Scoped { nodes: ApiNode[]; colEdges: ApiColEdge[]; modelEdges: ApiModelEdge[] }

/** Expands outward from explicit seed ids by the given depths. */
function expandFrom(
  allNodes: ApiNode[], allColEdges: ApiColEdge[], modelEdges: ApiModelEdge[],
  seedIds: string[], upstream: number, downstream: number,
  adjOut?: Map<string, string[]>, adjIn?: Map<string, string[]>,
): Scoped {
  if (seedIds.length === 0) return { nodes: [], colEdges: [], modelEdges: [] };
  const included = new Set<string>(seedIds);

  // Callers that expand repeatedly pass prebuilt adjacency; otherwise derive it.
  let out = adjOut, inc = adjIn;
  if (!out || !inc) {
    out = new Map<string, string[]>();
    inc = new Map<string, string[]>();
    for (const e of modelEdges) {
      let o = out.get(e.source_node_id);
      if (!o) out.set(e.source_node_id, (o = []));
      o.push(e.target_node_id);
      let i = inc.get(e.target_node_id);
      if (!i) inc.set(e.target_node_id, (i = []));
      i.push(e.source_node_id);
    }
  }

  const expand = (limit: number, adj: Map<string, string[]>) => {
    if (limit <= 0) return;
    const q = seedIds.map(id => ({ id, d: 0 }));
    const visited = new Set<string>();
    while (q.length > 0) {
      const { id, d } = q.shift()!;
      if (visited.has(id)) continue;
      visited.add(id);
      if (d >= limit) continue;
      for (const next of adj.get(id) ?? []) {
        included.add(next);
        q.push({ id: next, d: d + 1 });
      }
    }
  };
  expand(upstream, inc);
  expand(downstream, out);

  return {
    nodes:      allNodes.filter(n => included.has(n.id)),
    colEdges:   allColEdges.filter(e => included.has(e.source_node_id) && included.has(e.target_node_id)),
    modelEdges: modelEdges.filter(e => included.has(e.source_node_id) && included.has(e.target_node_id)),
  };
}

function applySelector(
  allNodes: ApiNode[], allColEdges: ApiColEdge[], modelEdges: ApiModelEdge[], sel: Selector | null,
): Scoped {
  if (!sel) return { nodes: [], colEdges: [], modelEdges: [] };
  const seeds = allNodes.filter(n => n.name.toLowerCase().includes(sel.name.toLowerCase()));
  return expandFrom(allNodes, allColEdges, modelEdges, seeds.map(n => n.id), sel.upstream, sel.downstream);
}

// ── Column selection context ──────────────────────────────────────────────────

interface ColSelCtx {
  selected: { nodeId: string; col: string } | null;
  trajColsByNode: Map<string, Set<string>>;
  onColClick: (nodeId: string, col: string) => void;
  collapsedNodes: Set<string>;
  onToggleCollapse: (nodeId: string) => void;
  rootId: string | null;
  onSetRoot: (nodeId: string) => void;
}
const ColSelCtx = createContext<ColSelCtx>({
  selected: null, trajColsByNode: new Map(),
  onColClick: () => {}, collapsedNodes: new Set(), onToggleCollapse: () => {},
  rootId: null, onSetRoot: () => {},
});

// ── Node dimensions — exact VORO values ──────────────────────────────────────

const HEADER_H = 44;
const ROW_H    = 28;
const MIN_W    = 200;
const MAX_W    = 900;

let _measureCtx: CanvasRenderingContext2D | null = null;
function measureText(text: string, font: string): number {
  if (!_measureCtx) {
    try { _measureCtx = document.createElement('canvas').getContext('2d'); } catch { /* noop */ }
  }
  if (!_measureCtx) return text.length * 8;
  _measureCtx.font = font;
  return _measureCtx.measureText(text).width;
}

function computeNodeWidth(modelName: string, columns: string[]): number {
  const HEADER_CHROME = 88;
  const COL_CHROME    = 52;
  const nameFont = '700 12px system-ui,-apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif';
  const rawNameW = Math.ceil(measureText(modelName.toUpperCase(), nameFont));
  const trackingExtra = Math.ceil(modelName.length * 0.025 * 12);
  const nameFloor = Math.ceil(modelName.length * 8.8);
  const nameW = Math.max(rawNameW + trackingExtra, nameFloor) + HEADER_CHROME;
  const colFont = '12px system-ui,-apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif';
  const maxColW = columns.reduce((m, c) => {
    const measured = Math.ceil(measureText(c, colFont)) + COL_CHROME;
    const floored  = Math.ceil(c.length * 7.5) + COL_CHROME;
    return Math.max(m, measured, floored);
  }, MIN_W);
  return Math.min(MAX_W, Math.max(MIN_W, nameW, maxColW));
}

// ── ModelColumnNode — directly from VORO ─────────────────────────────────────

interface ColNodeData {
  nodeId: string; modelName: string; layer: string; columns: string[];
  is_analyzed: boolean; nodeWidth: number; filePath: string | null;
}

function ModelColumnNode({ data }: NodeProps) {
  const { selected, trajColsByNode, onColClick, collapsedNodes, onToggleCollapse, rootId, onSetRoot } = useContext(ColSelCtx);
  const d = data as unknown as ColNodeData;
  const lc = getLC(d.layer);
  const collapsed = collapsedNodes.has(d.nodeId);
  const trajCols = trajColsByNode.get(d.nodeId) ?? new Set<string>();
  const hasTrajInNode = trajCols.size > 0;
  const hasTraj = trajColsByNode.size > 0;

  const glowStyle = hasTrajInNode
    ? { boxShadow: `0 0 0 2px ${lc.border}, 0 0 14px 3px ${lc.border}55` }
    : {};

  return (
    <div
      style={{
        width: d.nodeWidth,
        border: `2px solid ${lc.border}`,
        background: lc.bgDark,
        borderRadius: 12,
        overflow: 'hidden',
        boxShadow: '0 10px 15px -3px rgba(0,0,0,0.4), 0 4px 6px -4px rgba(0,0,0,0.4)',
        userSelect: 'none',
        fontFamily: 'system-ui,-apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif',
        ...glowStyle,
      }}
    >
      <div
        style={{
          height: HEADER_H, background: lc.border, cursor: 'pointer',
          display: 'flex', alignItems: 'center', gap: 8, padding: '4px 8px',
        }}
        onClick={() => onToggleCollapse(d.nodeId)}
        onDoubleClick={() => { if (d.filePath) postMessage({ type: 'openFile', filePath: d.filePath }); }}
        onMouseEnter={e => { e.currentTarget.style.filter = 'brightness(1.15)'; }}
        onMouseLeave={e => { e.currentTarget.style.filter = 'none'; }}
      >
        <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5"
          style={{ transform: collapsed ? 'rotate(0deg)' : 'rotate(90deg)', transition: 'transform 200ms ease', color: 'white', opacity: 0.8, flexShrink: 0 }}>
          <polyline points="9 6 15 12 9 18" />
        </svg>
        {d.is_analyzed && <span style={{ width: 6, height: 6, borderRadius: '50%', background: 'white', opacity: 0.8, flexShrink: 0 }} />}
        <span
          style={{
            color: 'white', fontSize: 12, fontWeight: 700, textTransform: 'uppercase',
            letterSpacing: '0.025em', flex: 1, minWidth: 0,
            whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis',
          }}
          title={d.modelName}>{d.modelName}</span>
        {collapsed && (
          <span style={{ color: 'white', opacity: 0.6, fontSize: 10, fontFamily: 'monospace', marginLeft: 4, flexShrink: 0 }}>
            {d.columns.length}c
          </span>
        )}
        {/* Re-root the canvas here — lets you walk outward one model at a time. */}
        {rootId !== d.nodeId && (
          <button
            title="Explore from this model"
            onClick={(e) => { e.stopPropagation(); onSetRoot(d.nodeId); }}
            style={{
              flexShrink: 0, background: 'rgba(255,255,255,0.16)', border: 'none', borderRadius: 4,
              color: 'white', cursor: 'pointer', fontSize: 10, lineHeight: 1, padding: '3px 5px', opacity: 0.85,
            }}
          >⌖</button>
        )}
        {rootId === d.nodeId && (
          <span title="Current root" style={{ flexShrink: 0, color: 'white', opacity: 0.85, fontSize: 10 }}>★</span>
        )}
        {collapsed && (
          <>
            <Handle type="target" position={Position.Left}
              style={{ left: -5, top: HEADER_H / 2, background: lc.border, width: 8, height: 8, border: '1.5px solid white' }} />
            <Handle type="source" position={Position.Right}
              style={{ right: -5, top: HEADER_H / 2, background: lc.border, width: 8, height: 8, border: '1.5px solid white' }} />
          </>
        )}
      </div>

      {!collapsed && (
        <>
          {d.columns.map((col) => {
            const isSelected = selected?.nodeId === d.nodeId && selected?.col === col;
            const inTraj = trajCols.has(col);
            const dimmed = hasTraj && hasTrajInNode && !inTraj;
            const handleBg = inTraj ? '#8b5cf6' : lc.border;
            const handleSize = inTraj ? 10 : 8;
            return (
              <div key={col}
                onClick={() => onColClick(d.nodeId, col)}
                style={{
                  height: ROW_H,
                  borderTop: `1px solid ${lc.border}40`,
                  background: isSelected ? '#8b5cf640' : inTraj ? '#3b82f615' : 'transparent',
                  opacity: dimmed ? 0.3 : 1,
                  cursor: 'pointer',
                  position: 'relative',
                  display: 'flex',
                  alignItems: 'center',
                  padding: '0 12px',
                  fontSize: 12,
                  transition: 'background 150ms, opacity 150ms',
                }}
              >
                <Handle type="target" position={Position.Left} id={col.toLowerCase()}
                  style={{ top: '50%', left: -5, transform: 'translateY(-50%)', background: handleBg, width: handleSize, height: handleSize, border: '1.5px solid white' }} />
                <span
                  style={{
                    color: isSelected ? '#a78bfa' : inTraj ? '#93c5fd' : '#d4d4d4',
                    fontWeight: isSelected ? 700 : inTraj ? 600 : 400,
                    overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap',
                  }}>
                  {col}
                </span>
                <Handle type="source" position={Position.Right} id={col.toLowerCase()}
                  style={{ top: '50%', right: -5, transform: 'translateY(-50%)', background: handleBg, width: handleSize, height: handleSize, border: '1.5px solid white' }} />
              </div>
            );
          })}
          {d.columns.length === 0 && (
            <div style={{
              height: ROW_H * 2, display: 'flex', alignItems: 'center', justifyContent: 'center',
              fontSize: 12, padding: '0 12px', opacity: 0.4, color: '#d4d4d4',
              borderTop: `1px solid ${lc.border}40`,
            }}>No columns defined</div>
          )}
        </>
      )}
    </div>
  );
}

const NODE_TYPES = { modelColumn: ModelColumnNode };

// ── ColumnEdge — directly from VORO ──────────────────────────────────────────

interface EdgeActions {
  onEnter: (edge: ApiColEdge, x: number, y: number) => void;
  onMove:  (x: number, y: number) => void;
  onLeave: () => void;
  onClick: (edge: ApiColEdge) => void;
}
const EdgeActionCtx = createContext<EdgeActions>({
  onEnter: () => {}, onMove: () => {}, onLeave: () => {}, onClick: () => {},
});

function ColumnEdge(props: EdgeProps) {
  const { id, sourceX, sourceY, targetX, targetY, style, markerEnd, data } = props;
  const actions = useContext(EdgeActionCtx);
  const apiEdge = (data as { apiEdge?: ApiColEdge } | undefined)?.apiEdge;

  const dx  = Math.abs(targetX - sourceX);
  const cpX = Math.max(80, dx * 0.5);
  const edgePath = `M ${sourceX} ${sourceY} C ${sourceX + cpX} ${sourceY} ${targetX - cpX} ${targetY} ${targetX} ${targetY}`;
  const stroke  = (style?.stroke  as string) ?? '#6b7280';
  const opacity = (style?.opacity as number) ?? 1;
  const sw      = (style?.strokeWidth as number) ?? 2.5;
  const dash    = (style?.strokeDasharray as string | undefined);

  return (
    <g style={{ opacity }}>
      {/* Wide invisible hit area — a 2.5px curve is near-impossible to hover. */}
      <path
        d={edgePath}
        style={{ stroke: 'transparent', strokeWidth: 18, fill: 'none', cursor: apiEdge ? 'pointer' : 'default' }}
        onMouseEnter={apiEdge ? (e) => actions.onEnter(apiEdge, e.clientX, e.clientY) : undefined}
        onMouseMove={apiEdge ? (e) => actions.onMove(e.clientX, e.clientY) : undefined}
        onMouseLeave={apiEdge ? actions.onLeave : undefined}
        onClick={apiEdge ? (e) => { e.stopPropagation(); actions.onClick(apiEdge); } : undefined}
      />
      <path id={id} className="react-flow__edge-path" d={edgePath}
        style={{ stroke, strokeWidth: sw, fill: 'none', strokeDasharray: dash, strokeLinecap: 'round', pointerEvents: 'none' }}
        markerEnd={markerEnd} />
    </g>
  );
}

// ── Edge tooltip + pinned detail panel ───────────────────────────────────────

/** Plain-language reason an edge is dashed rather than solid. */
function tierNote(edge: ApiColEdge): string | null {
  switch (edge.tier) {
    case 'likely':
      return `Not parsed from SQL. Inferred because both models have a column named "${edge.source_column}" with the same type (${edge.src_type}).`;
    case 'conflict':
      return `Names match but types differ — ${edge.src_type} → ${edge.tgt_type}. These may not be the same data.`;
    case 'unknown':
      return `Both models have a column named "${edge.source_column}", but no mapping was parsed and no data types are available to corroborate it.`;
    default:
      return null;
  }
}

const TIER_LABEL: Record<Exclude<EdgeTier, 'parsed'>, string> = {
  likely: 'Likely (inferred)',
  conflict: 'Type conflict',
  unknown: 'Unconfirmed',
};

function EdgeTooltip({ edge, x, y }: { edge: ApiColEdge; x: number; y: number }) {
  const note = tierNote(edge);
  const color = edge.tier && edge.tier !== 'parsed'
    ? TIER_COLORS[edge.tier]
    : TRANSFORM_COLORS[edge.transform_type] ?? TRANSFORM_COLORS.unknown;
  return (
    <div style={{
      position: 'fixed', left: x + 14, top: y - 10, zIndex: 50, pointerEvents: 'none',
      maxWidth: 300, borderRadius: 8, background: '#1a1a1a', border: '1px solid #2a2a2a',
      color: '#e5e5e5', fontSize: 11, boxShadow: '0 20px 25px -5px rgba(0,0,0,0.6)',
    }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '7px 11px', borderBottom: '1px solid #2a2a2a' }}>
        <span style={{ width: 8, height: 8, borderRadius: '50%', background: color, flexShrink: 0 }} />
        <span style={{ fontWeight: 600, textTransform: 'capitalize' }}>
          {edge.tier && edge.tier !== 'parsed' ? TIER_LABEL[edge.tier] : edge.transform_type}
        </span>
        <span style={{ marginLeft: 'auto', fontSize: 10, padding: '1px 6px', borderRadius: 4, background: '#111', color: '#737373' }}>
          {edge.tier && edge.tier !== 'parsed' ? 'GUESS' : edge.analyzed_by === 'llm' ? 'AI' : 'SQL'}
        </span>
      </div>
      <div style={{ padding: '7px 11px' }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 6, fontFamily: 'monospace', color: '#a3a3a3' }}>
          <span>{edge.source_column}</span>
          <span style={{ color: '#525252' }}>→</span>
          <span>{edge.target_column}</span>
        </div>
        {edge.transform_expression && (
          <div style={{
            fontFamily: 'monospace', fontSize: 10, marginTop: 6, padding: '5px 7px',
            borderRadius: 4, background: '#0a0a0a', color: '#a3e635', lineHeight: 1.5,
          }}>
            {edge.transform_expression.length > 90 ? edge.transform_expression.slice(0, 90) + '…' : edge.transform_expression}
          </div>
        )}
        {note && (
          <p style={{
            fontSize: 10, marginTop: 6, lineHeight: 1.5,
            color: edge.tier === 'conflict' ? '#fca5a5' : '#a3a3a3',
          }}>{note}</p>
        )}
        <p style={{ fontSize: 10, color: '#737373', marginTop: 6 }}>Click edge to pin details</p>
      </div>
    </div>
  );
}

type AiEdgeState =
  | { status: 'loading' }
  | { status: 'done'; result: AiEdgeResult }
  | { status: 'error'; message: string };

function AiResolveSection({ edge, aiEnabled, aiState, onResolve }: {
  edge: ApiColEdge; aiEnabled: boolean; aiState: AiEdgeState | undefined; onResolve: (edge: ApiColEdge) => void;
}) {
  if (!aiEnabled) return null;
  return (
    <div style={{ marginTop: 16, paddingTop: 14, borderTop: `1px solid ${T.border}` }}>
      <p style={{ fontSize: 10, textTransform: 'uppercase', letterSpacing: '0.08em', fontWeight: 600, color: T.faint, margin: '0 0 8px' }}>
        AI fallback (optional)
      </p>
      {(!aiState || aiState.status === 'error') && (
        <>
          <button
            onClick={() => onResolve(edge)}
            style={{
              background: '#1e1b4b', color: '#a78bfa', border: '1px solid #4c1d95', borderRadius: 6,
              padding: '5px 12px', fontSize: 11, cursor: 'pointer', fontWeight: 500,
            }}
          >Resolve with AI</button>
          <p style={{ fontSize: 10, color: T.faint, marginTop: 6, lineHeight: 1.5 }}>
            Sends this edge's model/column names and the target model's SQL to the endpoint configured in settings.
          </p>
          {aiState?.status === 'error' && (
            <p style={{ fontSize: 11, color: '#fca5a5', marginTop: 8 }}>{aiState.message}</p>
          )}
        </>
      )}
      {aiState?.status === 'loading' && (
        <p style={{ fontSize: 11, color: T.muted }}>Asking the model…</p>
      )}
      {aiState?.status === 'done' && (
        <div>
          <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 6 }}>
            <span style={{
              fontSize: 10, padding: '2px 8px', borderRadius: 999, fontWeight: 600,
              background: aiState.result.matches ? '#1e1b4b' : '#292524',
              color: aiState.result.matches ? '#a78bfa' : '#a8a29e',
            }}>
              {aiState.result.matches ? 'Likely a match' : 'Probably not a match'}
            </span>
            <span style={{ fontSize: 10, color: T.faint }}>confidence: {aiState.result.confidence}</span>
          </div>
          {aiState.result.transformType && (
            <p style={{ fontSize: 11, color: T.text, marginBottom: 4 }}>
              Guessed transform: <strong>{aiState.result.transformType}</strong>
            </p>
          )}
          <p style={{ fontSize: 11, color: T.muted, lineHeight: 1.5 }}>{aiState.result.note}</p>
          <p style={{ fontSize: 10, color: T.faint, marginTop: 8, fontStyle: 'italic' }}>
            AI guess — not verified against SQL.
          </p>
        </div>
      )}
    </div>
  );
}

function EdgeDetailPanel({ edge, onClose, aiEnabled, aiState, onResolveWithAI }: {
  edge: ApiColEdge; onClose: () => void;
  aiEnabled: boolean; aiState: AiEdgeState | undefined; onResolveWithAI: (edge: ApiColEdge) => void;
}) {
  const isGuess = !!edge.tier && edge.tier !== 'parsed';
  const note = tierNote(edge);
  const color = isGuess
    ? TIER_COLORS[edge.tier as Exclude<EdgeTier, 'parsed'>]
    : TRANSFORM_COLORS[edge.transform_type] ?? TRANSFORM_COLORS.unknown;
  return (
    <div style={{
      position: 'absolute', right: 0, top: 0, bottom: 0, zIndex: 20, width: 280,
      display: 'flex', flexDirection: 'column',
      background: T.panel, borderLeft: `1px solid ${T.border}`, boxShadow: '-8px 0 24px rgba(0,0,0,0.4)',
    }}>
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', padding: '11px 16px', borderBottom: `1px solid ${T.border}`, flexShrink: 0 }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
          <span style={{ width: 10, height: 10, borderRadius: '50%', background: color, flexShrink: 0 }} />
          <span style={{ fontSize: 13, fontWeight: 600, textTransform: 'capitalize', color: T.text }}>
            {isGuess ? TIER_LABEL[edge.tier as Exclude<EdgeTier, 'parsed'>] : edge.transform_type}
          </span>
        </div>
        <button onClick={onClose} style={{ background: 'none', border: 'none', color: T.muted, cursor: 'pointer', fontSize: 12, opacity: 0.6 }}>✕</button>
      </div>
      <div style={{ flex: 1, overflowY: 'auto', padding: 16 }}>
        <p style={{ fontSize: 10, textTransform: 'uppercase', letterSpacing: '0.08em', fontWeight: 600, color: T.faint, marginBottom: 6 }}>Column Path</p>
        <div style={{ display: 'flex', alignItems: 'center', gap: 8, fontSize: 11, fontFamily: 'monospace', padding: '8px 12px', borderRadius: 8, background: T.secondary, color: T.text }}>
          <span>{edge.source_column}</span>
          <span style={{ color: T.faint }}>→</span>
          <span>{edge.target_column}</span>
        </div>

        {isGuess && (
          <>
            <p style={{ fontSize: 10, textTransform: 'uppercase', letterSpacing: '0.08em', fontWeight: 600, color: T.faint, margin: '16px 0 6px' }}>Data Types</p>
            <div style={{ display: 'flex', alignItems: 'center', gap: 8, fontSize: 11, fontFamily: 'monospace', padding: '8px 12px', borderRadius: 8, background: T.secondary }}>
              <span style={{ color: edge.tier === 'conflict' ? '#fca5a5' : T.text }}>{edge.src_type ?? 'unknown'}</span>
              <span style={{ color: T.faint }}>→</span>
              <span style={{ color: edge.tier === 'conflict' ? '#fca5a5' : T.text }}>{edge.tgt_type ?? 'unknown'}</span>
            </div>
            <p style={{
              fontSize: 11, lineHeight: 1.6, marginTop: 10,
              color: edge.tier === 'conflict' ? '#fca5a5' : T.muted,
            }}>{note}</p>
          </>
        )}

        <p style={{ fontSize: 10, textTransform: 'uppercase', letterSpacing: '0.08em', fontWeight: 600, color: T.faint, margin: '16px 0 6px' }}>Analyzed By</p>
        <span style={{
          fontSize: 11, padding: '4px 10px', borderRadius: 999, fontWeight: 500,
          background: isGuess ? '#292524' : edge.analyzed_by === 'llm' ? '#1e1b4b' : '#022c22',
          color: isGuess ? '#a8a29e' : edge.analyzed_by === 'llm' ? '#8b5cf6' : '#10b981',
        }}>
          {isGuess ? 'Name match — not parsed' : edge.analyzed_by === 'llm' ? 'AI / LLM' : 'SQL Parser'}
        </span>

        {!isGuess && (
          <p style={{ fontSize: 10, textTransform: 'uppercase', letterSpacing: '0.08em', fontWeight: 600, color: T.faint, margin: '16px 0 6px' }}>Expression</p>
        )}
        {isGuess ? null : edge.transform_expression ? (
          <pre style={{
            fontSize: 11, fontFamily: 'monospace', lineHeight: 1.6, padding: 12, borderRadius: 8,
            background: '#0a0a0a', color: '#a3e635', border: `1px solid ${T.border}`,
            whiteSpace: 'pre-wrap', wordBreak: 'break-all', overflowX: 'auto',
          }}>{edge.transform_expression}</pre>
        ) : (
          <p style={{ fontSize: 11, fontStyle: 'italic', color: T.muted }}>
            {edge.transform_type === 'passthrough'
              ? 'Passthrough — no transformation applied'
              : 'No expression captured by the analyzer'}
          </p>
        )}

        {isGuess && (
          <AiResolveSection edge={edge} aiEnabled={aiEnabled} aiState={aiState} onResolve={onResolveWithAI} />
        )}
      </div>
    </div>
  );
}

function TraceRow({ hop, onJump }: { hop: TraceHop; onJump: (nodeId: string) => void }) {
  const lc = getLC(hop.layer);
  const color = TRANSFORM_COLORS[hop.transformType] ?? TRANSFORM_COLORS.unknown;
  return (
    <button
      onClick={() => onJump(hop.nodeId)}
      title={`Jump to ${hop.modelName}`}
      style={{
        display: 'flex', alignItems: 'center', gap: 8, width: '100%', textAlign: 'left',
        padding: '6px 8px', borderRadius: 6, border: 'none', cursor: 'pointer',
        background: 'transparent', color: T.text, font: 'inherit',
      }}
      onMouseEnter={e => { e.currentTarget.style.background = T.hover; }}
      onMouseLeave={e => { e.currentTarget.style.background = 'transparent'; }}
    >
      <span style={{ width: 6, height: 6, borderRadius: '50%', background: lc.border, flexShrink: 0 }} />
      <span style={{ fontSize: 11, color: T.muted, minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
        {hop.modelName}
      </span>
      <span style={{ fontSize: 11, fontFamily: 'monospace', color: T.text, minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', flexShrink: 0 }}>
        {hop.col}
      </span>
      <span style={{ marginLeft: 'auto', width: 8, height: 8, borderRadius: 2, background: color, flexShrink: 0 }} title={hop.transformType} />
    </button>
  );
}

/**
 * Ordered "where it came from / where it goes" list for the clicked column,
 * next to the graph rather than relying on the reader following crossing,
 * dimmed edges across a possibly large canvas.
 */
function TracePanel({
  startNode, startCol, upstream, downstream, showUp, showDown, onJump, onClose,
}: {
  startNode: ApiNode; startCol: string;
  upstream: TraceHop[][]; downstream: TraceHop[][];
  showUp: boolean; showDown: boolean;
  onJump: (nodeId: string) => void; onClose: () => void;
}) {
  const upCount = upstream.reduce((n, l) => n + l.length, 0);
  const downCount = downstream.reduce((n, l) => n + l.length, 0);
  return (
    <div style={{
      position: 'absolute', left: 0, top: 0, bottom: 0, zIndex: 20, width: 280,
      display: 'flex', flexDirection: 'column',
      background: T.panel, borderRight: `1px solid ${T.border}`, boxShadow: '8px 0 24px rgba(0,0,0,0.4)',
    }}>
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', padding: '11px 16px', borderBottom: `1px solid ${T.border}`, flexShrink: 0 }}>
        <div style={{ minWidth: 0 }}>
          <p style={{ fontSize: 10, textTransform: 'uppercase', letterSpacing: '0.08em', fontWeight: 600, color: T.faint, margin: 0 }}>Tracing</p>
          <p style={{
            fontSize: 13, fontWeight: 600, color: T.text, margin: '2px 0 0',
            overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap',
          }}>
            {startNode.name}.<span style={{ fontFamily: 'monospace' }}>{startCol}</span>
          </p>
        </div>
        <button onClick={onClose} style={{ background: 'none', border: 'none', color: T.muted, cursor: 'pointer', fontSize: 12, opacity: 0.6, flexShrink: 0 }}>✕</button>
      </div>
      <div style={{ flex: 1, overflowY: 'auto', padding: '8px 8px 16px' }}>
        {showUp && (
          <div style={{ marginBottom: 14 }}>
            <p style={{ fontSize: 10, textTransform: 'uppercase', letterSpacing: '0.08em', fontWeight: 600, color: T.faint, padding: '4px 8px', margin: 0 }}>
              ← Where it came from{upCount > 0 ? ` (${upCount})` : ''}
            </p>
            {upstream.length === 0 && (
              <p style={{ fontSize: 11, color: T.muted, padding: '2px 8px', fontStyle: 'italic' }}>Nothing further upstream.</p>
            )}
            {[...upstream].reverse().map((level, i) => (
              <div key={i}>
                {level.map(hop => <TraceRow key={hop.nodeId + '::' + hop.col} hop={hop} onJump={onJump} />)}
              </div>
            ))}
          </div>
        )}

        <div style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '4px 8px', margin: '4px 0' }}>
          <span style={{ width: 6, height: 6, borderRadius: '50%', background: '#fafafa', flexShrink: 0 }} />
          <span style={{ fontSize: 11, color: T.text, fontFamily: 'monospace', fontWeight: 600 }}>{startCol}</span>
          <span style={{ fontSize: 10, color: T.muted }}>selected</span>
        </div>

        {showDown && (
          <div>
            <p style={{ fontSize: 10, textTransform: 'uppercase', letterSpacing: '0.08em', fontWeight: 600, color: T.faint, padding: '4px 8px', margin: 0 }}>
              Where it goes →{downCount > 0 ? ` (${downCount})` : ''}
            </p>
            {downstream.length === 0 && (
              <p style={{ fontSize: 11, color: T.muted, padding: '2px 8px', fontStyle: 'italic' }}>Nothing further downstream.</p>
            )}
            {downstream.map((level, i) => (
              <div key={i}>
                {level.map(hop => <TraceRow key={hop.nodeId + '::' + hop.col} hop={hop} onJump={onJump} />)}
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}

const EDGE_TYPES = { columnEdge: ColumnEdge };

// ── Dagre layout — exact VORO ─────────────────────────────────────────────────

function layoutGraph(nodes: Node[], edges: Edge[], collapsedNodes: Set<string>): Node[] {
  const g = new dagre.graphlib.Graph();
  g.setGraph({ rankdir: 'LR', nodesep: 60, ranksep: 160, marginx: 30, marginy: 30 });
  g.setDefaultEdgeLabel(() => ({}));
  for (const n of nodes) {
    const d = n.data as unknown as ColNodeData;
    const isCollapsed = collapsedNodes.has(d.nodeId);
    const h = isCollapsed ? HEADER_H : HEADER_H + Math.max(d.columns.length, 1) * ROW_H;
    g.setNode(n.id, { width: d.nodeWidth, height: h });
  }
  for (const e of edges) g.setEdge(e.source, e.target);
  dagre.layout(g);
  return nodes.map(n => {
    const pos = g.node(n.id);
    const d = n.data as unknown as ColNodeData;
    const isCollapsed = collapsedNodes.has(d.nodeId);
    const h = isCollapsed ? HEADER_H : HEADER_H + Math.max(d.columns.length, 1) * ROW_H;
    return { ...n, position: { x: pos.x - d.nodeWidth / 2, y: pos.y - h / 2 } };
  });
}

// ── Column trajectory tracing — exact VORO ────────────────────────────────────

type TraceDir = 'up' | 'both' | 'down';

function traceColEdges(colEdges: ApiColEdge[], startNodeId: string, startCol: string, dir: TraceDir) {
  const edgeIds    = new Set<string>();
  const colsByNode = new Map<string, Set<string>>();
  function addCol(nodeId: string, col: string) {
    if (!colsByNode.has(nodeId)) colsByNode.set(nodeId, new Set());
    colsByNode.get(nodeId)!.add(col);
  }
  addCol(startNodeId, startCol);

  const walk = (forward: boolean) => {
    const queue = [{ nodeId: startNodeId, col: startCol }];
    const seen = new Set<string>();
    while (queue.length) {
      const { nodeId, col } = queue.shift()!;
      const k = `${nodeId}:${col}`;
      if (seen.has(k)) continue;
      seen.add(k);
      for (const e of colEdges) {
        const fromNode = forward ? e.source_node_id : e.target_node_id;
        const fromCol  = forward ? e.source_column  : e.target_column;
        const toNode   = forward ? e.target_node_id : e.source_node_id;
        const toCol    = forward ? e.target_column  : e.source_column;
        if (fromNode === nodeId && fromCol === col) {
          edgeIds.add(e.id);
          addCol(toNode, toCol);
          queue.push({ nodeId: toNode, col: toCol });
        }
      }
    }
  };

  if (dir === 'down' || dir === 'both') walk(true);
  if (dir === 'up'   || dir === 'both') walk(false);
  return { edgeIds, colsByNode };
}

/**
 * Fallback used alongside the exact trace: follows model-level edges and matches
 * columns by name. Bridges gaps where the SQL parser could not resolve a mapping,
 * so a click still shows a plausible path instead of a lone highlighted row.
 */
function traceByName(
  modelEdges: ApiModelEdge[], nodes: ApiNode[], startNodeId: string, startCol: string, dir: TraceDir,
): Map<string, Set<string>> {
  const colsByNode = new Map<string, Set<string>>();
  const colsOf = new Map(nodes.map(n => [n.id, n.columns]));
  const key = startCol.toLowerCase();
  const add = (nodeId: string, col: string) => {
    if (!colsByNode.has(nodeId)) colsByNode.set(nodeId, new Set());
    colsByNode.get(nodeId)!.add(col);
  };
  add(startNodeId, startCol);

  const walk = (forward: boolean) => {
    const queue = [startNodeId];
    const seen = new Set<string>();
    while (queue.length) {
      const id = queue.shift()!;
      if (seen.has(id)) continue;
      seen.add(id);
      for (const e of modelEdges) {
        const from = forward ? e.source_node_id : e.target_node_id;
        const to   = forward ? e.target_node_id : e.source_node_id;
        if (from !== id) continue;
        const match = colsOf.get(to)?.find(c => c.toLowerCase() === key);
        if (match) { add(to, match); queue.push(to); }
      }
    }
  };
  if (dir === 'down' || dir === 'both') walk(true);
  if (dir === 'up'   || dir === 'both') walk(false);
  return colsByNode;
}

/** One column, one hop away from the previous level, for the trace side panel. */
interface TraceHop {
  nodeId: string;
  modelName: string;
  layer: string;
  col: string;
  transformType: string;
}

/**
 * Same walk as traceColEdges, but keeps hops grouped by distance from the
 * clicked column instead of collapsing them into a single set — the side
 * panel reads top-to-bottom as "furthest upstream" → selected → "furthest
 * downstream", which a flat set can't express.
 */
function buildTraceLevels(
  colEdges: ApiColEdge[], nodeById: Map<string, ApiNode>,
  startNodeId: string, startCol: string, forward: boolean,
): TraceHop[][] {
  const levels: TraceHop[][] = [];
  let frontier: { nodeId: string; col: string }[] = [{ nodeId: startNodeId, col: startCol }];
  const seen = new Set([`${startNodeId}:${startCol}`]);
  while (frontier.length) {
    const hops: TraceHop[] = [];
    const nextFrontier: { nodeId: string; col: string }[] = [];
    for (const { nodeId, col } of frontier) {
      for (const e of colEdges) {
        const fromNode = forward ? e.source_node_id : e.target_node_id;
        const fromCol  = forward ? e.source_column  : e.target_column;
        const toNode   = forward ? e.target_node_id : e.source_node_id;
        const toCol    = forward ? e.target_column  : e.source_column;
        if (fromNode !== nodeId || fromCol !== col) continue;
        const key = `${toNode}:${toCol}`;
        if (seen.has(key)) continue;
        seen.add(key);
        hops.push({
          nodeId: toNode,
          modelName: nodeById.get(toNode)?.name ?? toNode,
          layer: nodeById.get(toNode)?.layer ?? '',
          col: toCol,
          transformType: e.transform_type,
        });
        nextFrontier.push({ nodeId: toNode, col: toCol });
      }
    }
    if (!hops.length) break;
    levels.push(hops);
    frontier = nextFrontier;
  }
  return levels;
}

// ── Build ReactFlow graph — adapted from VORO ─────────────────────────────────

function buildFlowGraph(
  nodes: ApiNode[], colEdges: ApiColEdge[], modelEdges: ApiModelEdge[],
  trajEdgeIds: Set<string>, trajNodeIds: Set<string>,
  hasTraj: boolean, collapsedNodes: Set<string>, showInferred: boolean,
): { nodes: Node[]; edges: Edge[] } {
  if (!nodes.length) return { nodes: [], edges: [] };

  const colEdgeSet = new Set(
    colEdges.map(e => `${e.source_node_id}|${e.source_column.toLowerCase()}|${e.target_node_id}|${e.target_column.toLowerCase()}`)
  );
  // Membership set instead of scanning every column edge per model edge — that
  // scan was O(modelEdges × colEdges) and dominated re-render on wide graphs.
  const pairsWithColEdges = new Set(
    colEdges.map(e => `${e.source_node_id}>${e.target_node_id}`)
  );
  const visibleIds = new Set(nodes.map(n => n.id));
  const nodeColMap = new Map(nodes.map(n => [n.id, n]));
  const nodeColSets = new Map(nodes.map(n => [n.id, new Set(n.columns.map(c => c.toLowerCase()))]));

  const rfNodes: Node[] = nodes.map(n => {
    const nodeWidth = computeNodeWidth(n.name, n.columns);
    const nodeDimmed = hasTraj && !trajNodeIds.has(n.id);
    return {
      id: n.id, type: 'modelColumn', position: { x: 0, y: 0 },
      style: nodeDimmed
        ? { opacity: 0.12, transition: 'opacity 200ms', pointerEvents: 'none' as const }
        : { opacity: 1,    transition: 'opacity 200ms' },
      data: { nodeId: n.id, modelName: n.name, layer: n.layer, columns: n.columns, is_analyzed: n.is_analyzed, nodeWidth, filePath: n.file_path } satisfies ColNodeData,
    };
  });

  // Column-level colored edges
  const rfColEdges: Edge[] = colEdges
    .filter(e => visibleIds.has(e.source_node_id) && visibleIds.has(e.target_node_id))
    .map(e => {
      const inTraj = trajEdgeIds.has(e.id);
      const dimmed = hasTraj && !inTraj;
      const color  = TRANSFORM_COLORS[e.transform_type] ?? TRANSFORM_COLORS.unknown;
      const isSourceCollapsed = collapsedNodes.has(e.source_node_id);
      const isTargetCollapsed = collapsedNodes.has(e.target_node_id);
      const srcCols = nodeColSets.get(e.source_node_id);
      const tgtCols = nodeColSets.get(e.target_node_id);
      const srcHandleId = (!isSourceCollapsed && srcCols?.has(e.source_column.toLowerCase())) ? e.source_column.toLowerCase() : undefined;
      const tgtHandleId = (!isTargetCollapsed && tgtCols?.has(e.target_column.toLowerCase())) ? e.target_column.toLowerCase() : undefined;
      return {
        id: e.id,
        source: e.source_node_id, target: e.target_node_id,
        sourceHandle: srcHandleId, targetHandle: tgtHandleId,
        type: 'columnEdge', data: { apiEdge: e },
        style: {
          stroke: dimmed ? '#2a2a2a' : color,
          strokeWidth: inTraj ? 4 : 2.5,
          opacity: dimmed ? 0.15 : 1,
        },
        markerEnd: { type: MarkerType.ArrowClosed, color: dimmed ? '#2a2a2a' : color, width: inTraj ? 16 : 13, height: inTraj ? 16 : 13 },
      };
    });

  // Model-level fallback dashed edges
  const rfModelEdges: Edge[] = [];
  for (const e of modelEdges) {
    if (!visibleIds.has(e.source_node_id) || !visibleIds.has(e.target_node_id)) continue;
    const inTraj = trajNodeIds.has(e.source_node_id) && trajNodeIds.has(e.target_node_id);
    const srcNode = nodeColMap.get(e.source_node_id);
    const tgtNode = nodeColMap.get(e.target_node_id);
    const srcCollapsed = collapsedNodes.has(e.source_node_id);
    const tgtCollapsed = collapsedNodes.has(e.target_node_id);
    const pairHasEdges = pairsWithColEdges.has(`${e.source_node_id}>${e.target_node_id}`);

    // Style carries confidence: dashed for an inference, dotted for a blank.
    const styleFor = (tier: Exclude<EdgeTier, 'parsed'>) => {
      const color = inTraj ? '#6366f1' : TIER_COLORS[tier];
      const solidish = tier !== 'unknown';
      return {
        style: {
          stroke: color,
          strokeWidth: inTraj ? 2.5 : solidish ? 2 : 1.5,
          strokeDasharray: solidish ? '6 4' : '2 4',
          opacity: hasTraj ? (inTraj ? 0.9 : 0.08) : tier === 'conflict' ? 0.9 : 0.6,
        },
        markerEnd: {
          type: MarkerType.ArrowClosed, color,
          width: inTraj ? 14 : 10, height: inTraj ? 14 : 10,
        },
      };
    };

    if (!srcCollapsed && !tgtCollapsed && srcNode && tgtNode && srcNode.columns.length > 0 && tgtNode.columns.length > 0) {
      const tgtColLower = new Map(tgtNode.columns.map(c => [c.toLowerCase(), c]));
      const uncovered = srcNode.columns
        .map(sc => ({ src: sc, tgt: tgtColLower.get(sc.toLowerCase()) }))
        .filter((p): p is { src: string; tgt: string } => {
          if (!p.tgt) return false;
          return !colEdgeSet.has(`${e.source_node_id}|${p.src.toLowerCase()}|${e.target_node_id}|${p.tgt.toLowerCase()}`);
        });

      if (uncovered.length > 0) {
        for (const { src, tgt } of uncovered) {
          const st = srcNode.columnTypes[src.toLowerCase()] ?? null;
          const tt = tgtNode.columnTypes[tgt.toLowerCase()] ?? null;
          // Types agree → a believable passthrough. Types disagree → same name
          // carrying different data, which is usually worth a second look.
          const tier: Exclude<EdgeTier, 'parsed'> =
            !st || !tt ? 'unknown' : st.toLowerCase() === tt.toLowerCase() ? 'likely' : 'conflict';
          if (!showInferred && tier !== 'conflict') continue;

          const id = `me-${e.source_node_id}-${e.target_node_id}-${src}`;
          rfModelEdges.push({
            id,
            source: e.source_node_id, target: e.target_node_id,
            sourceHandle: src.toLowerCase(), targetHandle: tgt.toLowerCase(),
            type: 'columnEdge',
            data: {
              apiEdge: {
                id,
                source_node_id: e.source_node_id, source_column: src,
                target_node_id: e.target_node_id, target_column: tgt,
                transform_type: tier, transform_expression: null,
                analyzed_by: 'sql', tier, src_type: st, tgt_type: tt,
              } satisfies ApiColEdge,
            },
            ...styleFor(tier),
          });
        }
        continue;
      }
      if (pairHasEdges) continue;
    }
    if (pairHasEdges) continue;
    if (!showInferred) continue;
    rfModelEdges.push({
      id: `me-${e.source_node_id}-${e.target_node_id}`,
      source: e.source_node_id, target: e.target_node_id,
      type: 'columnEdge',
      ...styleFor('unknown'),
    });
  }

  return { nodes: layoutGraph(rfNodes, [...rfColEdges, ...rfModelEdges], collapsedNodes), edges: [...rfColEdges, ...rfModelEdges] };
}

// ── Legend — from VORO ────────────────────────────────────────────────────────

function Legend() {
  const [collapsed, setCollapsed] = useState(false);
  return (
    <div style={{
      position: 'absolute', bottom: 20, right: 20, zIndex: 10,
      width: collapsed ? 'auto' : 300,
      background: 'rgba(17,17,17,0.97)', border: '1px solid #2a2a2a',
      borderRadius: 12, backdropFilter: 'blur(8px)', userSelect: 'none',
      boxShadow: '0 20px 25px -5px rgba(0,0,0,0.5), 0 8px 10px -6px rgba(0,0,0,0.5)',
    }}>
      <button
        onClick={() => setCollapsed(v => !v)}
        style={{
          width: '100%', display: 'flex', alignItems: 'center', justifyContent: 'space-between',
          padding: '10px 16px', textAlign: 'left',
          background: 'none', border: 'none', cursor: 'pointer', font: 'inherit',
        }}>
        <div>
          <p style={{ fontSize: 11, fontWeight: 700, letterSpacing: '0.1em', textTransform: 'uppercase', color: '#ffffff', margin: 0 }}>Legend of the Arrows</p>
          {!collapsed && <p style={{ fontSize: 11, marginTop: 2, color: T.muted }}>Transformation Classification</p>}
        </div>
        <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5"
          style={{ color: T.faint, transform: collapsed ? 'rotate(-90deg)' : 'rotate(0deg)', transition: 'transform 200ms', flexShrink: 0, marginLeft: 8 }}>
          <polyline points="6 9 12 15 18 9" />
        </svg>
      </button>
      {!collapsed && (
        <div style={{ padding: '0 16px 14px' }}>
          <p style={{ fontSize: 11, marginBottom: 12, lineHeight: 1.55, color: T.muted }}>Each column edge is color-coded by how the data changes:</p>
          <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
            {Object.entries(TRANSFORM_META).map(([key, { label, desc }]) => (
              <div key={key} style={{ display: 'flex', alignItems: 'flex-start', gap: 10 }}>
                <svg width="28" height="10" viewBox="0 0 28 10" style={{ flexShrink: 0, marginTop: 2 }}>
                  <line x1="0" y1="5" x2="20" y2="5" stroke={TRANSFORM_COLORS[key]} strokeWidth="2.5" strokeLinecap="round" />
                  <polygon points="20,2 28,5 20,8" fill={TRANSFORM_COLORS[key]} />
                </svg>
                <div>
                  <p style={{ fontSize: 11, fontWeight: 600, lineHeight: 1.25, color: '#ffffff', margin: 0 }}>{label}</p>
                  <p style={{ fontSize: 11, color: T.muted, marginTop: 1, lineHeight: 1.35 }}>{desc}</p>
                </div>
              </div>
            ))}
            <div style={{ borderTop: '1px solid #2a2a2a', margin: '2px 0' }} />
            <p style={{ fontSize: 10, color: T.faint, textTransform: 'uppercase', letterSpacing: '0.08em', fontWeight: 600 }}>
              Not proven from SQL
            </p>
            {([
              { tier: 'likely',   dash: '5 3', label: 'Likely',       desc: 'Same column name and data type — inferred, not parsed' },
              { tier: 'conflict', dash: '5 3', label: 'Type conflict', desc: 'Same name but different type — may not be the same data' },
              { tier: 'unknown',  dash: '2 3', label: 'Unconfirmed',   desc: 'Connected, but nothing could be established' },
            ] as const).map(({ tier, dash, label, desc }) => (
              <div key={tier} style={{ display: 'flex', alignItems: 'flex-start', gap: 10 }}>
                <svg width="28" height="10" viewBox="0 0 28 10" style={{ flexShrink: 0, marginTop: 2 }}>
                  <line x1="0" y1="5" x2="20" y2="5" stroke={TIER_COLORS[tier]} strokeWidth="2" strokeDasharray={dash} strokeLinecap="round" />
                  <polygon points="20,2 28,5 20,8" fill={TIER_COLORS[tier]} />
                </svg>
                <div>
                  <p style={{ fontSize: 11, fontWeight: 600, lineHeight: 1.25, color: '#ffffff', margin: 0 }}>{label}</p>
                  <p style={{ fontSize: 11, color: T.muted, marginTop: 1, lineHeight: 1.35 }}>{desc}</p>
                </div>
              </div>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}

// ── FlowInner — keyboard + minimap + fitView ──────────────────────────────────

function FlowInner({ onEscape, onFitViewReady, hasData, focusNodeId, onFocused }:
  { onEscape: () => void; onFitViewReady: (fn: () => void) => void; hasData: boolean; focusNodeId: string | null; onFocused: () => void }) {
  const { fitView } = useReactFlow();
  const doFit = useCallback(() => fitView({ padding: 0.2, duration: 400 }), [fitView]);
  useEffect(() => { onFitViewReady(doFit); }, [doFit, onFitViewReady]);

  useEffect(() => {
    if (!hasData) return;
    if (focusNodeId) {
      const t = setTimeout(() => { fitView({ nodes: [{ id: focusNodeId }], padding: 0.5, duration: 500 }); onFocused(); }, 120);
      return () => clearTimeout(t);
    }
    const t = setTimeout(() => fitView({ padding: 0.2, duration: 350 }), 60);
    return () => clearTimeout(t);
  }, [hasData, focusNodeId]);

  useEffect(() => {
    const h = (e: KeyboardEvent) => {
      if (e.target instanceof HTMLInputElement) return;
      if (e.key === 'Escape') { onEscape(); fitView({ padding: 0.2, duration: 400 }); }
      if (e.key === 'f' || e.key === 'F') fitView({ padding: 0.2, duration: 400 });
    };
    window.addEventListener('keydown', h);
    return () => window.removeEventListener('keydown', h);
  }, [fitView, onEscape]);

  return (
    <>
      <Background variant={BackgroundVariant.Dots} gap={20} size={1} color={T.rfDot} />
      <Controls
        position="bottom-left"
        showInteractive={false}
        style={{ background: '#111111', border: '1px solid #2a2a2a', borderRadius: 8 }}
      />
      <MiniMap position="top-right"
        nodeColor={n => getLC((n.data as unknown as ColNodeData)?.layer ?? '').border}
        nodeBorderRadius={3}
        maskColor="rgba(0,0,0,0.55)"
        style={{ background: '#111111', border: '1px solid #2a2a2a', borderRadius: 8 }} />
    </>
  );
}

// ── Depth stepper ─────────────────────────────────────────────────────────────

/**
 * Depth is picked directly rather than nudged with −/+.
 * The stepper this replaced had 10px hit targets and could not step back down
 * from ∞ (Infinity − 1 is still Infinity), so it read as broken.
 */
const DEPTH_CHOICES: { v: number; label: string }[] = [
  { v: 0, label: '0' },
  { v: 1, label: '1' },
  { v: 2, label: '2' },
  { v: 3, label: '3' },
  { v: Infinity, label: 'All' },
];

function DepthPicker({ label, value, onChange }:
  { label: string; value: number; onChange: (v: number) => void }) {
  return (
    <div style={{ display: 'flex', alignItems: 'center', gap: 4 }}>
      <span style={{ fontSize: 10, color: T.muted, whiteSpace: 'nowrap' }}>{label}</span>
      <div style={{ display: 'flex', border: '1px solid #333', borderRadius: 6, overflow: 'hidden' }}>
        {DEPTH_CHOICES.map(({ v, label: txt }) => {
          const active = value === v;
          return (
            <button key={txt} type="button" onClick={() => onChange(v)}
              style={{
                minWidth: 24, padding: '4px 7px', fontSize: 11, lineHeight: 1,
                border: 'none', cursor: 'pointer', fontFamily: 'monospace',
                background: active ? '#ffffff' : '#1a1a1a',
                color: active ? '#171717' : T.muted,
              }}>{txt}</button>
          );
        })}
      </div>
    </div>
  );
}

// ── Main App ──────────────────────────────────────────────────────────────────

export function App() {
  const [graph, setGraph] = useState<LineageGraph | null>(null);
  const [status, setStatus] = useState<'loading' | 'error' | 'ready'>('loading');
  const [errorMsg, setErrorMsg] = useState('');
  const [focusModelId, setFocusModelId] = useState<string | null>(null);
  const [search, setSearch] = useState('');
  const [rootModelId, setRootModelId] = useState<string | null>(null);
  const [upDepth, setUpDepth] = useState(0);
  const [downDepth, setDownDepth] = useState(0);
  const [pickerOpen, setPickerOpen] = useState(false);
  const [pickerQuery, setPickerQuery] = useState('');
  const [colPanelOpen, setColPanelOpen] = useState(false);
  const [colQuery, setColQuery] = useState('');
  const [catalogHintDismissed, setCatalogHintDismissed] = useState(false);
  const [showInferred, setShowInferred] = useState(true);
  const [selected, setSelected] = useState<{ nodeId: string; col: string } | null>(null);
  const [traceDir, setTraceDir] = useState<TraceDir>('both');
  const [collapsedNodes, setCollapsedNodes] = useState(new Set<string>());
  const [hoverEdge, setHoverEdge] = useState<{ edge: ApiColEdge; x: number; y: number } | null>(null);
  const [pinnedEdge, setPinnedEdge] = useState<ApiColEdge | null>(null);
  const [aiEnabled, setAiEnabled] = useState(false);
  const [aiResults, setAiResults] = useState<Map<string, AiEdgeState>>(new Map());
  const [rfNodes, setRfNodes, onNodesChange] = useNodesState([]);
  const [rfEdges, setRfEdges, onEdgesChange] = useEdgesState([]);
  const fitViewRef = useRef<(() => void) | null>(null);
  const focusDoneRef = useRef<string | null>(null);

  // Convert graph → API types
  // Converting the whole graph is O(models + edges) and was previously redone on
  // every click, depth change and keystroke — the cause of the lag when switching
  // models. It depends only on the manifest, so it is computed once per load.
  const base = useMemo(() => {
    if (!graph) return null;
    const allNodes = graph.models.map(toApiNode);
    const allColEdges = graph.columnEdges.map(toApiColEdge);
    const allModelEdges = graph.modelEdges.map(toApiModelEdge);

    // Adjacency for depth expansion, also built once rather than per interaction.
    const adjOut = new Map<string, string[]>();
    const adjIn = new Map<string, string[]>();
    for (const e of allModelEdges) {
      let o = adjOut.get(e.source_node_id);
      if (!o) adjOut.set(e.source_node_id, (o = []));
      o.push(e.target_node_id);
      let i = adjIn.get(e.target_node_id);
      if (!i) adjIn.set(e.target_node_id, (i = []));
      i.push(e.source_node_id);
    }
    return { allNodes, allColEdges, allModelEdges, adjOut, adjIn, nodeIds: new Set(allNodes.map(n => n.id)) };
  }, [graph]);

  const apiData = useMemo(() => {
    if (!base) return null;
    const { allNodes, allColEdges, allModelEdges, adjOut, adjIn } = base;
    const empty = { nodes: [], colEdges: [], modelEdges: [], ...base };

    // A raw selector in the box always wins — it is the power-user escape hatch.
    const typed = search.trim();
    if (typed) {
      const sel = parseSelector(typed);
      if (sel) return { ...applySelector(allNodes, allColEdges, allModelEdges, sel), ...base };
      const hits = allNodes.filter(n => n.name.toLowerCase().includes(typed.toLowerCase()));
      const ids = new Set(hits.map(n => n.id));
      return {
        nodes: hits,
        colEdges: allColEdges.filter(e => ids.has(e.source_node_id) && ids.has(e.target_node_id)),
        modelEdges: allModelEdges.filter(e => ids.has(e.source_node_id) && ids.has(e.target_node_id)),
        ...base,
      };
    }

    // Otherwise: render nothing until a model is chosen. Rendering 1000+ models
    // at once is unusable — you pick a root, then decide how far to expand.
    if (!rootModelId || !base.nodeIds.has(rootModelId)) return empty;
    return {
      ...expandFrom(allNodes, allColEdges, allModelEdges, [rootModelId], upDepth, downDepth, adjOut, adjIn),
      ...base,
    };
  }, [base, search, rootModelId, upDepth, downDepth]);

  // Trajectory is derived, so changing direction re-traces without a re-click.
  const trajectory = useMemo(() => {
    const empty = { edgeIds: new Set<string>(), colsByNode: new Map<string, Set<string>>(), nodeIds: new Set<string>() };
    if (!apiData || !selected) return empty;

    const { edgeIds, colsByNode } = traceColEdges(apiData.allColEdges, selected.nodeId, selected.col, traceDir);
    // Merge in the name-based path so unparsed hops still light up.
    const byName = traceByName(apiData.allModelEdges, apiData.allNodes, selected.nodeId, selected.col, traceDir);
    const merged = new Map(colsByNode);
    for (const [nid, cols] of byName) {
      if (!merged.has(nid)) merged.set(nid, new Set());
      for (const c of cols) merged.get(nid)!.add(c);
    }
    return { edgeIds, colsByNode: merged, nodeIds: new Set(merged.keys()) };
  }, [apiData, selected, traceDir]);

  const { edgeIds: trajEdgeIds, colsByNode: trajColsByNode, nodeIds: trajNodeIds } = trajectory;

  // Ordered hop-by-hop path for the trace side panel — walks the full,
  // unscoped graph like `trajectory` above, so it still lists models the
  // current depth/root has not pulled onto the canvas.
  const traceLevels = useMemo(() => {
    const empty = { upstream: [] as TraceHop[][], downstream: [] as TraceHop[][] };
    if (!apiData || !selected) return empty;
    const nodeById = new Map(apiData.allNodes.map(n => [n.id, n]));
    return {
      upstream: buildTraceLevels(apiData.allColEdges, nodeById, selected.nodeId, selected.col, false),
      downstream: buildTraceLevels(apiData.allColEdges, nodeById, selected.nodeId, selected.col, true),
    };
  }, [apiData, selected]);

  // Jumping from the trace panel may target a model outside the current
  // root/depth scope, so re-root the canvas there rather than just panning
  // (which would silently do nothing for a node that isn't rendered).
  const onJumpToNode = useCallback((nodeId: string) => {
    setRootModelId(nodeId);
    setSearch('');
    setFocusModelId(nodeId);
  }, []);

  // Rebuild ReactFlow graph when data/trajectory/collapse changes
  useEffect(() => {
    if (!apiData) return;
    const hasTraj = trajNodeIds.size > 0;
    const { nodes, edges } = buildFlowGraph(
      apiData.nodes, apiData.colEdges, apiData.modelEdges,
      trajEdgeIds, trajNodeIds, hasTraj, collapsedNodes, showInferred,
    );
    setRfNodes(nodes);
    setRfEdges(edges);
  }, [apiData, trajEdgeIds, trajNodeIds, collapsedNodes, showInferred]);

  // Handle messages from extension host
  useEffect(() => {
    const handler = (ev: MessageEvent<ExtensionMessage>) => {
      const msg = ev.data;
      if (msg.type === 'setLoading') { setStatus('loading'); setGraph(null); }
      else if (msg.type === 'setError') { setStatus('error'); setErrorMsg(msg.message); }
      else if (msg.type === 'setGraph') {
        setGraph(msg.graph);
        setStatus('ready');
        if (msg.focusModelId) { setFocusModelId(msg.focusModelId); setRootModelId(msg.focusModelId); }
        setSelected(null); setTraceDir('both'); setPinnedEdge(null); setHoverEdge(null);
      }
      else if (msg.type === 'focusModel') {
        // Clicking a model in the sidebar re-roots the canvas on it.
        setFocusModelId(msg.modelId);
        setRootModelId(msg.modelId);
        setSearch('');
        setSelected(null); setPinnedEdge(null); setHoverEdge(null);
      }
      else if (msg.type === 'aiStatus') { setAiEnabled(msg.enabled); }
      else if (msg.type === 'aiResolveResult') {
        setAiResults(prev => new Map(prev).set(msg.edgeId, { status: 'done', result: msg.result }));
      }
      else if (msg.type === 'aiResolveError') {
        setAiResults(prev => new Map(prev).set(msg.edgeId, { status: 'error', message: msg.message }));
      }
    };
    window.addEventListener('message', handler);
    return () => window.removeEventListener('message', handler);
  }, []);

  const onColClick = useCallback((nodeId: string, col: string) => {
    setSelected(prev => (prev?.nodeId === nodeId && prev?.col === col ? null : { nodeId, col }));
    setTraceDir('both');
  }, []);

  const onResolveWithAI = useCallback((edge: ApiColEdge) => {
    const sourceNode = apiData?.allNodes.find(n => n.id === edge.source_node_id);
    const targetNode = apiData?.allNodes.find(n => n.id === edge.target_node_id);
    if (!sourceNode || !targetNode) return;
    setAiResults(prev => new Map(prev).set(edge.id, { status: 'loading' }));
    const query: AiEdgeQuery = {
      edgeId: edge.id,
      sourceModel: sourceNode.name, sourceColumn: edge.source_column, sourceType: edge.src_type ?? null,
      targetModelId: targetNode.id, targetModel: targetNode.name, targetColumn: edge.target_column, targetType: edge.tgt_type ?? null,
      dialect: null,
    };
    postMessage({ type: 'resolveEdgeWithAI', query });
  }, [apiData]);

  const onToggleCollapse = useCallback((nodeId: string) => {
    setCollapsedNodes(prev => {
      const next = new Set(prev);
      if (next.has(nodeId)) next.delete(nodeId); else next.add(nodeId);
      return next;
    });
  }, []);

  const onEscape = useCallback(() => {
    setSelected(null); setTraceDir('both'); setPinnedEdge(null); setHoverEdge(null);
  }, []);

  const edgeActions = useMemo<EdgeActions>(() => ({
    onEnter: (edge, x, y) => setHoverEdge({ edge, x, y }),
    onMove:  (x, y) => setHoverEdge(prev => (prev ? { ...prev, x, y } : prev)),
    onLeave: () => setHoverEdge(null),
    onClick: (edge) => setPinnedEdge(edge),
  }), []);

  const onFitViewReady = useCallback((fn: () => void) => { fitViewRef.current = fn; }, []);

  const hasTraj = trajNodeIds.size > 0;
  const hasData = rfNodes.length > 0;

  const allModels = useMemo(
    () => (graph?.models ?? []).slice().sort((a, b) => a.name.localeCompare(b.name)),
    [graph],
  );
  const rootModel = allModels.find(m => m.id === rootModelId) ?? null;
  const pickerHits = useMemo(() => {
    const q = pickerQuery.trim().toLowerCase();
    const hits = q ? allModels.filter(m => m.name.toLowerCase().includes(q)) : allModels;
    return hits.slice(0, 200); // keep the dropdown responsive on large projects
  }, [allModels, pickerQuery]);

  // dbt selector syntax lives in the same box as the model search: a query with a
  // `+` is a selector, anything else is a name filter. Two separate inputs read as
  // two competing searches, and the selector one re-rendered the graph per keystroke.
  const typedSelector = useMemo(() => {
    const q = pickerQuery.trim();
    return q.includes('+') ? parseSelector(q) : null;
  }, [pickerQuery]);

  const applyTypedSelector = useCallback(() => {
    setSearch(pickerQuery.trim());
    setRootModelId(null);
    setPickerOpen(false);
    setSelected(null); setPinnedEdge(null); setHoverEdge(null);
  }, [pickerQuery]);

  const pickRoot = useCallback((id: string) => {
    setRootModelId(id);
    setSearch('');
    setPickerOpen(false);
    setPickerQuery('');
    setSelected(null); setPinnedEdge(null); setHoverEdge(null);
    setFocusModelId(id);
  }, []);

  // A dedicated column search, independent of the model picker above — it
  // searches every column on every model directly, rather than filtering
  // models by name and hoping a column happens to match.
  interface ColHit { modelId: string; modelName: string; layer: string; columnName: string }
  const colHits = useMemo<ColHit[]>(() => {
    const q = colQuery.trim().toLowerCase();
    if (!q) return [];
    const hits: ColHit[] = [];
    for (const m of allModels) {
      for (const c of m.columns) {
        if (c.name.toLowerCase().includes(q)) {
          hits.push({ modelId: m.id, modelName: m.name, layer: m.layer, columnName: c.name });
        }
      }
    }
    // Exact and prefix matches first, so the column you meant surfaces before
    // incidental substring matches on a large project.
    hits.sort((a, b) => {
      const rank = (n: string) => (n.toLowerCase() === q ? 0 : n.toLowerCase().startsWith(q) ? 1 : 2);
      const r = rank(a.columnName) - rank(b.columnName);
      return r !== 0 ? r : a.columnName.localeCompare(b.columnName);
    });
    return hits.slice(0, 200); // keep the dropdown responsive on large projects
  }, [allModels, colQuery]);

  const pickColumn = useCallback((hit: ColHit) => {
    pickRoot(hit.modelId);
    setSelected({ nodeId: hit.modelId, col: hit.columnName });
    setColPanelOpen(false);
    setColQuery('');
  }, [pickRoot]);

  const colSelCtxValue = useMemo(() => ({
    selected, trajColsByNode, onColClick, collapsedNodes, onToggleCollapse,
    rootId: rootModelId, onSetRoot: pickRoot,
  }), [selected, trajColsByNode, onColClick, collapsedNodes, onToggleCollapse, rootModelId, pickRoot]);

  return (
    <div style={{ display: 'flex', flexDirection: 'column', height: '100vh', background: T.bg, color: T.text, fontFamily: 'system-ui, sans-serif', fontSize: 13 }}>
      {/* Toolbar */}
      <div style={{ display: 'flex', flexWrap: 'wrap', alignItems: 'center', gap: 8, padding: '5px 12px', borderBottom: `1px solid ${T.border}`, flexShrink: 0 }}>
        <span style={{ fontSize: 11, fontWeight: 700, letterSpacing: '0.08em', color: '#3b82f6', marginRight: 4 }}>VORO</span>

        {/* Root model picker — nothing renders until one is chosen */}
        <div style={{ position: 'relative', flexShrink: 0 }}>
          <button
            onClick={() => { setPickerOpen(o => !o); setPickerQuery(''); }}
            style={{
              display: 'flex', alignItems: 'center', gap: 6, maxWidth: 260,
              background: rootModel ? '#1e3a5f' : '#1a1a1a',
              color: rootModel ? '#fafafa' : T.muted,
              border: `1px solid ${rootModel ? '#2563eb' : '#333'}`,
              borderRadius: 6, padding: '4px 9px', fontSize: 11, cursor: 'pointer',
            }}
          >
            <span style={{ fontFamily: 'monospace', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
              {rootModel ? rootModel.name : 'Choose a model…'}
            </span>
            <span style={{ opacity: 0.6, fontSize: 9 }}>▾</span>
          </button>

          {pickerOpen && (
            <div style={{
              position: 'absolute', top: '100%', left: 0, marginTop: 4, zIndex: 60,
              width: 320, maxHeight: 380, display: 'flex', flexDirection: 'column',
              background: '#111111', border: '1px solid #2a2a2a', borderRadius: 8,
              boxShadow: '0 20px 25px -5px rgba(0,0,0,0.6)',
            }}>
              <input
                autoFocus
                value={pickerQuery}
                onChange={e => setPickerQuery(e.target.value)}
                onKeyDown={e => {
                  if (e.key === 'Escape') setPickerOpen(false);
                  if (e.key !== 'Enter') return;
                  if (typedSelector) applyTypedSelector();
                  else if (pickerHits[0]) pickRoot(pickerHits[0].id);
                }}
                placeholder="Search models, or +model+"
                style={{
                  background: '#1a1a1a', color: T.text, border: 'none',
                  borderBottom: '1px solid #2a2a2a', padding: '7px 10px',
                  fontSize: 11, outline: 'none', fontFamily: 'monospace',
                }}
              />
              {typedSelector && (
                <button
                  onClick={applyTypedSelector}
                  style={{
                    display: 'flex', alignItems: 'center', gap: 8, width: '100%',
                    padding: '7px 10px', background: '#1e3a5f', border: 'none',
                    borderBottom: '1px solid #2a2a2a', cursor: 'pointer', textAlign: 'left',
                  }}
                >
                  <span style={{ fontSize: 10, color: '#93c5fd' }}>selector</span>
                  <span style={{ fontFamily: 'monospace', fontSize: 11, color: '#fafafa' }}>
                    {pickerQuery.trim()}
                  </span>
                  <span style={{ marginLeft: 'auto', fontSize: 9, color: '#93c5fd' }}>⏎</span>
                </button>
              )}
              <div style={{ overflowY: 'auto' }}>
                {pickerHits.map(m => {
                  const lc = getLC(m.layer);
                  return (
                    <button key={m.id} onClick={() => pickRoot(m.id)}
                      style={{
                        display: 'flex', alignItems: 'center', gap: 8, width: '100%',
                        padding: '5px 10px', background: m.id === rootModelId ? '#1e3a5f' : 'transparent',
                        border: 'none', cursor: 'pointer', textAlign: 'left',
                      }}
                      onMouseEnter={e => { if (m.id !== rootModelId) e.currentTarget.style.background = '#1a1a1a'; }}
                      onMouseLeave={e => { if (m.id !== rootModelId) e.currentTarget.style.background = 'transparent'; }}
                    >
                      <span style={{ width: 7, height: 7, borderRadius: 2, background: lc.border, flexShrink: 0 }} />
                      <span style={{ fontFamily: 'monospace', fontSize: 11, color: T.text, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{m.name}</span>
                      {m.resourceType === 'source' && (
                        <span style={{ fontSize: 8, color: '#93c5fd', border: '1px solid #1e40af', borderRadius: 3, padding: '0 3px', flexShrink: 0 }}>src</span>
                      )}
                      <span style={{ marginLeft: 'auto', fontSize: 9, color: T.faint, flexShrink: 0 }}>{m.layer}</span>
                    </button>
                  );
                })}
                {pickerHits.length === 0 && (
                  <p style={{ padding: '10px', fontSize: 11, color: T.muted }}>No match.</p>
                )}
              </div>
            </div>
          )}
        </div>

        {/* Column search — independent of the model picker; searches every
            column on every model, not model names. */}
        <div style={{ position: 'relative', flexShrink: 0 }}>
          <button
            onClick={() => { setColPanelOpen(o => !o); setColQuery(''); }}
            title="Search columns by name across all models"
            style={{
              display: 'flex', alignItems: 'center', gap: 6,
              background: colPanelOpen ? '#1e3a5f' : '#1a1a1a',
              color: colPanelOpen ? '#fafafa' : T.muted,
              border: `1px solid ${colPanelOpen ? '#2563eb' : '#333'}`,
              borderRadius: 6, padding: '4px 9px', fontSize: 11, cursor: 'pointer',
            }}
          >
            <span aria-hidden style={{ fontSize: 11 }}>⌕</span>
            <span>Columns</span>
          </button>

          {colPanelOpen && (
            <div style={{
              position: 'absolute', top: '100%', left: 0, marginTop: 4, zIndex: 60,
              width: 340, maxHeight: 420, display: 'flex', flexDirection: 'column',
              background: '#111111', border: '1px solid #2a2a2a', borderRadius: 8,
              boxShadow: '0 20px 25px -5px rgba(0,0,0,0.6)',
            }}>
              <input
                autoFocus
                value={colQuery}
                onChange={e => setColQuery(e.target.value)}
                onKeyDown={e => {
                  if (e.key === 'Escape') setColPanelOpen(false);
                  if (e.key === 'Enter' && colHits[0]) pickColumn(colHits[0]);
                }}
                placeholder="Search columns, e.g. customer_id"
                style={{
                  background: '#1a1a1a', color: T.text, border: 'none',
                  borderBottom: '1px solid #2a2a2a', padding: '7px 10px',
                  fontSize: 11, outline: 'none', fontFamily: 'monospace',
                }}
              />
              <div style={{ overflowY: 'auto' }}>
                {colHits.map(h => {
                  const lc = getLC(h.layer);
                  return (
                    <button key={`${h.modelId}::${h.columnName}`} onClick={() => pickColumn(h)}
                      style={{
                        display: 'flex', alignItems: 'center', gap: 8, width: '100%',
                        padding: '5px 10px', background: 'transparent',
                        border: 'none', cursor: 'pointer', textAlign: 'left',
                      }}
                      onMouseEnter={e => { e.currentTarget.style.background = '#1a1a1a'; }}
                      onMouseLeave={e => { e.currentTarget.style.background = 'transparent'; }}
                    >
                      <span style={{ width: 7, height: 7, borderRadius: 2, background: lc.border, flexShrink: 0 }} />
                      <span style={{ fontFamily: 'monospace', fontSize: 11, color: T.text, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{h.columnName}</span>
                      <span style={{ marginLeft: 'auto', fontSize: 10, color: T.faint, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', maxWidth: 140 }}>{h.modelName}</span>
                    </button>
                  );
                })}
                {colQuery.trim() && colHits.length === 0 && (
                  <p style={{ padding: '10px', fontSize: 11, color: T.muted }}>No column matches "{colQuery.trim()}".</p>
                )}
                {!colQuery.trim() && (
                  <p style={{ padding: '10px', fontSize: 11, color: T.muted }}>Type a column name to search across every model.</p>
                )}
              </div>
            </div>
          )}
        </div>

        {/* Depth steppers */}
        {rootModel && !search.trim() && (
          <div style={{ display: 'flex', alignItems: 'center', gap: 10, flexShrink: 0 }}>
            <DepthPicker label="↑ up"   value={upDepth}   onChange={setUpDepth} />
            <DepthPicker label="↓ down" value={downDepth} onChange={setDownDepth} />
          </div>
        )}

        {search.trim() && (
          <span
            title="dbt selector: +model (upstream), model+ (downstream), 2+model+1 (depth-limited)"
            style={{
              display: 'flex', alignItems: 'center', gap: 6, flexShrink: 0,
              background: '#1e3a5f', border: '1px solid #2563eb', borderRadius: 6,
              padding: '3px 8px', fontSize: 11, color: '#fafafa',
            }}
          >
            <span style={{ fontSize: 10, color: '#93c5fd' }}>selector</span>
            <span style={{ fontFamily: 'monospace' }}>{search.trim()}</span>
            <button onClick={() => setSearch('')}
              style={{ background: 'none', border: 'none', color: '#93c5fd', cursor: 'pointer', fontSize: 11, opacity: 0.8, lineHeight: 1 }}>✕</button>
          </span>
        )}
        {hasTraj && (
          <>
            <span style={{ display: 'flex', alignItems: 'center', gap: 6, padding: '3px 8px', borderRadius: 6, background: '#262626', fontSize: 11, color: T.text, flexShrink: 0 }}>
              <span style={{ fontFamily: 'monospace' }}>{selected?.col}</span>
              {trajNodeIds.size > 1 && <span style={{ opacity: 0.6, fontSize: 10 }}>· {trajNodeIds.size} models</span>}
              <button onClick={onEscape} style={{ background: 'none', border: 'none', color: T.muted, cursor: 'pointer', fontSize: 11, opacity: 0.6, lineHeight: 1 }}>✕</button>
            </span>
            <div style={{ display: 'flex', alignItems: 'center', borderRadius: 6, overflow: 'hidden', border: `1px solid ${T.border}`, flexShrink: 0 }}>
              {([
                { key: 'up',   label: '← Upstream' },
                { key: 'both', label: '↔ Both' },
                { key: 'down', label: 'Downstream →' },
              ] as { key: TraceDir; label: string }[]).map(({ key, label }) => (
                <button key={key} onClick={() => setTraceDir(key)}
                  style={{
                    padding: '3px 9px', fontSize: 11, fontWeight: 500, cursor: 'pointer', border: 'none',
                    background: traceDir === key ? '#ffffff' : 'transparent',
                    color: traceDir === key ? '#171717' : T.muted,
                  }}>{label}</button>
              ))}
            </div>
          </>
        )}
        <div style={{ flex: 1 }} />
        {graph && (
          <span style={{ fontSize: 11, color: T.muted }}>
            {hasData && <strong style={{ color: '#a1a1aa' }}>{rfNodes.length} shown</strong>}
            {hasData && ' · '}
            <span title="Sources are raw tables declared in sources.yml. They are not models — they are here so lineage can reach upstream of your project.">
              {graph.metadata.totalModels} models · {graph.metadata.totalSources} sources
            </span>
            {' · '}{graph.metadata.totalEdges} edges · {graph.metadata.parseSuccessRate}% parsed
          </span>
        )}
        {graph && graph.metadata.hasCatalog === false && !catalogHintDismissed && (
          <span
            title={
              `${graph.metadata.inferredSchemas ?? 0} upstream schemas were inferred from downstream SQL. ` +
              'Run `dbt docs generate` to produce target/catalog.json for exact columns and data types.'
            }
            style={{
              display: 'flex', alignItems: 'center', gap: 6, flexShrink: 0,
              background: '#422006', border: '1px solid #854d0e', borderRadius: 6,
              padding: '3px 8px', fontSize: 11, color: '#fbbf24',
            }}
          >
            No catalog — run <code style={{ fontFamily: 'monospace' }}>dbt docs generate</code>
            <button
              onClick={() => setCatalogHintDismissed(true)}
              style={{ background: 'none', border: 'none', color: '#fbbf24', cursor: 'pointer', fontSize: 11, opacity: 0.7, lineHeight: 1 }}
            >✕</button>
          </span>
        )}
        {graph && (
          <>
            <button
              onClick={() => postMessage({ type: 'openAiSettings' })}
              title={aiEnabled
                ? 'AI fallback is on. Click to change endpoint/model in Settings.'
                : 'AI fallback for unresolved edges is off. Click to enable it in Settings.'}
              style={{
                background: aiEnabled ? '#1e1b4b' : '#1a1a1a',
                color: aiEnabled ? '#a78bfa' : T.muted,
                border: `1px solid ${aiEnabled ? '#4c1d95' : '#333'}`,
                borderRadius: 4, padding: '3px 10px', cursor: 'pointer', fontSize: 11, flexShrink: 0,
              }}
            >
              AI: {aiEnabled ? 'On' : 'Off'}
            </button>
            {aiEnabled && (
              <>
                <button
                  onClick={() => postMessage({ type: 'setAiApiKey' })}
                  title="Set or replace the AI API key (stored in this machine's VS Code secret storage)"
                  style={{
                    background: '#1a1a1a', color: T.muted, border: '1px solid #333',
                    borderRadius: 4, padding: '3px 10px', cursor: 'pointer', fontSize: 11, flexShrink: 0,
                  }}
                >
                  Set AI Key
                </button>
                <button
                  onClick={() => postMessage({ type: 'clearAiApiKey' })}
                  title="Delete the stored AI API key from this machine — asks for confirmation first"
                  style={{
                    background: '#1a1a1a', color: T.muted, border: '1px solid #333',
                    borderRadius: 4, padding: '3px 10px', cursor: 'pointer', fontSize: 11, flexShrink: 0,
                  }}
                >
                  Clear AI Key
                </button>
              </>
            )}
          </>
        )}
        <button
          onClick={() => setShowInferred(v => !v)}
          title={showInferred
            ? 'Hide edges that were not proven from SQL (type conflicts stay visible)'
            : 'Show inferred and unconfirmed edges'}
          style={{
            background: showInferred ? '#1a1a1a' : '#0f2a1f',
            color: showInferred ? T.muted : '#4ade80',
            border: `1px solid ${showInferred ? '#333' : '#166534'}`,
            borderRadius: 4, padding: '3px 10px', cursor: 'pointer', fontSize: 11, flexShrink: 0,
          }}
        >
          {showInferred ? 'All edges' : 'Proven only'}
        </button>
        <button
          onClick={() => fitViewRef.current?.()}
          style={{ background: '#1a1a1a', color: T.muted, border: '1px solid #333', borderRadius: 4, padding: '3px 10px', cursor: 'pointer', fontSize: 12 }}
        >
          Fit  <kbd style={{ fontSize: 10, opacity: 0.6 }}>F</kbd>
        </button>
        {hasTraj && (
          <button onClick={onEscape}
            style={{ background: '#1a1a1a', color: '#a78bfa', border: '1px solid #4c1d95', borderRadius: 4, padding: '3px 10px', cursor: 'pointer', fontSize: 12 }}>
            Clear  <kbd style={{ fontSize: 10, opacity: 0.6 }}>Esc</kbd>
          </button>
        )}
      </div>

      {/* Canvas */}
      <div style={{ flex: 1, position: 'relative' }}>
        {/* State overlays */}
        {status === 'loading' && (
          <div style={{ position: 'absolute', inset: 0, display: 'flex', alignItems: 'center', justifyContent: 'center', zIndex: 10, background: T.bg }}>
            <p style={{ color: T.muted, fontSize: 13 }}>Loading lineage…</p>
          </div>
        )}
        {status === 'error' && (
          <div style={{ position: 'absolute', inset: 0, display: 'flex', alignItems: 'center', justifyContent: 'center', zIndex: 10, flexDirection: 'column', gap: 12 }}>
            <p style={{ color: T.muted, fontSize: 13, textAlign: 'center', maxWidth: 340 }}>{errorMsg}</p>
          </div>
        )}
        {status === 'ready' && !hasData && (
          <div style={{ position: 'absolute', inset: 0, display: 'flex', alignItems: 'center', justifyContent: 'center', zIndex: 10, flexDirection: 'column', gap: 10, padding: 24, textAlign: 'center' }}>
            {search.trim() || rootModelId ? (
              <>
                <p style={{ color: T.muted, fontSize: 13 }}>No models matched.</p>
                {search && <button onClick={() => setSearch('')} style={{ color: '#3b82f6', fontSize: 12, background: 'none', border: 'none', cursor: 'pointer' }}>Clear filter</button>}
              </>
            ) : (
              <>
                <p style={{ color: T.text, fontSize: 14, fontWeight: 600 }}>Pick a model to explore</p>
                <p style={{ color: T.muted, fontSize: 12, maxWidth: 380, lineHeight: 1.6 }}>
                  {graph ? `${graph.metadata.totalModels} models and ${graph.metadata.totalSources} sources loaded.` : ''} Choose one from the
                  {' '}<strong style={{ color: '#a1a1aa' }}>Choose a model…</strong> menu above, or click any model
                  in the VORO sidebar. Then use <strong style={{ color: '#a1a1aa' }}>↑ up</strong> /
                  {' '}<strong style={{ color: '#a1a1aa' }}>↓ down</strong> to pull in as much lineage as you want.
                </p>
                <button
                  onClick={() => { setPickerOpen(true); setPickerQuery(''); }}
                  style={{ marginTop: 4, background: '#1e3a5f', color: '#fafafa', border: '1px solid #2563eb', borderRadius: 6, padding: '6px 14px', fontSize: 12, cursor: 'pointer' }}
                >Choose a model</button>
              </>
            )}
          </div>
        )}

        <ColSelCtx.Provider value={colSelCtxValue}>
         <EdgeActionCtx.Provider value={edgeActions}>
          <ReactFlow
            nodes={rfNodes}
            edges={rfEdges}
            onNodesChange={onNodesChange}
            onEdgesChange={onEdgesChange}
            nodeTypes={NODE_TYPES}
            edgeTypes={EDGE_TYPES}
            fitView
            minZoom={0.05}
            maxZoom={2}
            proOptions={{ hideAttribution: true }}
            style={{ background: T.rfBg }}
            onPaneClick={onEscape}
          >
            <FlowInner
              onEscape={onEscape}
              onFitViewReady={onFitViewReady}
              hasData={hasData}
              focusNodeId={focusModelId !== focusDoneRef.current ? focusModelId : null}
              onFocused={() => { focusDoneRef.current = focusModelId; }}
            />
          </ReactFlow>
         </EdgeActionCtx.Provider>
        </ColSelCtx.Provider>

        {hoverEdge && !pinnedEdge && <EdgeTooltip edge={hoverEdge.edge} x={hoverEdge.x} y={hoverEdge.y} />}
        {pinnedEdge && (
          <EdgeDetailPanel
            edge={pinnedEdge}
            onClose={() => setPinnedEdge(null)}
            aiEnabled={aiEnabled}
            aiState={aiResults.get(pinnedEdge.id)}
            onResolveWithAI={onResolveWithAI}
          />
        )}
        {selected && apiData && (() => {
          const startNode = apiData.allNodes.find(n => n.id === selected.nodeId);
          return startNode ? (
            <TracePanel
              startNode={startNode}
              startCol={selected.col}
              upstream={traceLevels.upstream}
              downstream={traceLevels.downstream}
              showUp={traceDir === 'up' || traceDir === 'both'}
              showDown={traceDir === 'down' || traceDir === 'both'}
              onJump={onJumpToNode}
              onClose={onEscape}
            />
          ) : null;
        })()}

        {status === 'ready' && hasData && !pinnedEdge && <Legend />}
      </div>
    </div>
  );
}
