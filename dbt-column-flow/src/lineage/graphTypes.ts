export type TransformationType = 'passthrough' | 'rename' | 'transform' | 'aggregate';

export interface ColumnNode {
  id: string;         // "model.proj.orders::order_id"
  name: string;
  dataType: string | null;   // from catalog.json if available
  description: string;
}

export interface ModelNode {
  id: string;         // "model.proj.orders"
  name: string;
  resourceType: 'model' | 'source';
  database: string;
  schema: string;
  filePath: string | null;   // absolute path to .sql file
  materialization: string;
  columns: ColumnNode[];
  description: string;
  parseStatus: 'parsed' | 'fallback' | 'failed';
  layer: string;      // inferred from folder path: staging / intermediate / marts / source
}

export interface ColumnEdge {
  id: string;         // deterministic: "sourceColId->targetColId"
  sourceModelId: string;
  sourceColumnId: string;
  targetModelId: string;
  targetColumnId: string;
  transformationType: TransformationType;
  /** Reconstructed SELECT expression, e.g. "SUM(amount)". Null when unavailable. */
  transformExpression: string | null;
}

export interface ModelEdge {
  sourceModelId: string;
  targetModelId: string;
}

export interface LineageGraph {
  models: ModelNode[];
  columnEdges: ColumnEdge[];
  modelEdges: ModelEdge[];
  metadata: {
    /** dbt models only — `.sql` files under models/. */
    totalModels: number;
    /** Raw tables declared in sources.yml. Not models; they exist for upstream lineage. */
    totalSources: number;
    totalColumns: number;
    totalEdges: number;
    parseSuccessRate: number;  // 0-100
    /** Why candidate column edges were discarded — for diagnosing low parse rates. */
    dropReasons?: Record<string, number>;
    /** False when catalog.json is absent, so the UI can suggest `dbt docs generate`. */
    hasCatalog?: boolean;
    /** Upstream nodes whose column list had to be inferred from downstream SQL. */
    inferredSchemas?: number;
  };
}

// ── Optional AI fallback for edges SQL parsing could not resolve ───────────────
// Off by default. When the user opts in, only the specific edge they click
// "Resolve with AI" on is ever sent anywhere — no bulk or background calls.

export interface AiEdgeQuery {
  edgeId: string;
  sourceModel: string;
  sourceColumn: string;
  sourceType: string | null;
  targetModelId: string;
  targetModel: string;
  targetColumn: string;
  targetType: string | null;
  dialect: string | null;
}

export interface AiEdgeResult {
  matches: boolean;
  transformType: TransformationType | null;
  confidence: 'high' | 'medium' | 'low';
  note: string;
}

// ── Messages between extension host and webview ────────────────────────────────

export type ExtensionMessage =
  | { type: 'setGraph'; graph: LineageGraph; focusModelId?: string }
  | { type: 'setLoading' }
  | { type: 'setError'; message: string }
  | { type: 'focusModel'; modelId: string }
  | { type: 'aiStatus'; enabled: boolean }
  | { type: 'aiResolveResult'; edgeId: string; result: AiEdgeResult }
  | { type: 'aiResolveError'; edgeId: string; message: string };

export type WebviewMessage =
  | { type: 'ready' }
  | { type: 'openFile'; filePath: string }
  | { type: 'exportPng'; dataUrl: string }
  | { type: 'resolveEdgeWithAI'; query: AiEdgeQuery }
  | { type: 'openAiSettings' }
  | { type: 'setAiApiKey' }
  | { type: 'clearAiApiKey' };
