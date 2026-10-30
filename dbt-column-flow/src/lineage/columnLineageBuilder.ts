import * as path from 'path';
import type { ParsedManifest, ManifestNode } from '../artifacts/manifestParser';
import type { ParsedCatalog } from '../artifacts/catalogParser';
import {
  classifyModelColumns,
  extractSqlOutputCols,
  resolveSourceNode,
  setAdapterDialect,
  type DBNode,
  type ParsedColumn,
} from './voroAnalyzer';
import { cleanJinja } from './jinjaCleaner';
import { SqlColumnParser } from './sqlParser';
import type {
  LineageGraph,
  ModelNode,
  ColumnNode,
  ColumnEdge,
  ModelEdge,
  TransformationType,
} from './graphTypes';

/**
 * Builds the column-level lineage graph from a parsed dbt manifest.
 *
 * Column classification is delegated to `voroAnalyzer.ts` — a verbatim port of
 * VORO's production analyzer. Edge construction below mirrors VORO's
 * `upsertColumnEdges`, minus the database writes.
 */
export class ColumnLineageBuilder {
  build(
    manifest: ParsedManifest,
    catalog: ParsedCatalog | null,
    projectRoot: string,
  ): LineageGraph {
    // Pick the SQL grammar from the project's own warehouse before parsing anything.
    setAdapterDialect(manifest.adapterType);
    const drop = newDropStats();

    const models: ModelNode[] = [];
    const columnEdges: ColumnEdge[] = [];
    const modelEdges: ModelEdge[] = [];

    const nodeById = new Map<string, ManifestNode>();
    for (const node of manifest.nodes) {
      if (node.resourceType === 'model' || node.resourceType === 'source') {
        nodeById.set(node.uniqueId, node);
      }
    }

    // ── Pass 1: Build ModelNode[] with columns ───────────────────────────────
    // Column list = schema.yml columns ∪ columns the SQL actually outputs.
    // VORO does the same union when validating edges; without it, models whose
    // schema.yml is sparse would get edges pointing at columns the node never
    // renders, and those edges would silently vanish from the canvas.
    const colsByModel = new Map<string, ColumnNode[]>();

    for (const node of nodeById.values()) {
      const catalogCols = catalog?.tables[node.uniqueId] ?? [];
      const catalogTypeMap = new Map(catalogCols.map((c) => [c.name.toLowerCase(), c.type]));

      const seen = new Set<string>();
      const columns: ColumnNode[] = [];

      const push = (name: string, dataType: string | null, description: string) => {
        const key = name.toLowerCase();
        if (!key || key === '*' || seen.has(key)) return;
        seen.add(key);
        columns.push({
          id: `${node.uniqueId}::${name}`,
          name,
          dataType: catalogTypeMap.get(key) ?? dataType,
          description,
        });
      };

      for (const c of node.columns) push(c.name, c.dataType || null, c.description);

      if (node.resourceType === 'model' && node.rawSql) {
        for (const name of extractSqlOutputCols(node.rawSql)) push(name, null, '');
      }
      // The catalog knows the real warehouse schema — fill in anything still missing.
      for (const c of catalogCols) push(c.name, c.type, '');

      colsByModel.set(node.uniqueId, columns);

      models.push({
        id: node.uniqueId,
        name: node.name,
        resourceType: node.resourceType === 'source' ? 'source' : 'model',
        database: node.database,
        schema: node.schema,
        filePath: node.originalFilePath
          ? path.join(projectRoot, node.originalFilePath)
          : null,
        materialization: node.materialization,
        columns,
        description: node.description,
        parseStatus: 'failed', // updated in pass 2
        layer: inferLayer(node),
      });
    }

    // ── Pass 2: Classify each model's columns ────────────────────────────────
    // Classification is the expensive step (~10 s on a 1000-model project), so it
    // runs exactly once and the results are held for the later edge-building pass.
    let parsedCount = 0;
    const modelMap = new Map(models.map((m) => [m.id, m]));
    const classified: Array<{
      node: ManifestNode;
      modelNode: ModelNode;
      upstreamNodes: DBNode[];
      parsedCols: ParsedColumn[];
    }> = [];
    const pendingCols = new Map<string, Set<string>>();
    const inferred = new Set<string>();

    // The same upstream is rebuilt for every consumer otherwise — pure waste on
    // hub models that dozens of others read from.
    const dbNodeCache = new Map<string, DBNode>();
    const toDbNodes = (ids: string[]): DBNode[] =>
      ids.map((id) => {
        let d = dbNodeCache.get(id);
        if (!d) { d = toDbNode(nodeById.get(id)!); dbNodeCache.set(id, d); }
        return d;
      });

    for (const node of nodeById.values()) {
      if (node.resourceType !== 'model' || !node.rawSql) continue;

      const upstreamIds = node.dependsOnNodes.filter((id) => nodeById.has(id));
      if (upstreamIds.length === 0) continue;

      // Model-level edges are emitted regardless of column-parse success.
      for (const upstreamId of upstreamIds) {
        modelEdges.push({ sourceModelId: upstreamId, targetModelId: node.uniqueId });
      }

      const modelNode = modelMap.get(node.uniqueId);
      if (!modelNode) continue;

      const upstreamNodes: DBNode[] = toDbNodes(upstreamIds);

      // One unparseable model must not take the whole graph down with it. Real
      // projects hit dialect edge cases the analyzer was never exercised against;
      // that model falls back to a model-level edge and the rest still renders.
      let parsedCols: ParsedColumn[];
      try {
        parsedCols = classifyModelColumns(node.rawSql, upstreamNodes);
      } catch {
        modelNode.parseStatus = 'failed';
        continue;
      }

      if (parsedCols.length === 0) {
        modelNode.parseStatus = 'fallback';
        continue;
      }

      classified.push({ node, modelNode, upstreamNodes, parsedCols });
    }

    // ── Pass 2.5: back-fill columns for upstreams with an unknown schema ──────
    // dbt `sources.yml` usually declares sources without listing their columns,
    // and `catalog.json` is optional — so most sources arrive with none. Every
    // edge pointing at such a node would be discarded for referencing a column
    // that "doesn't exist". Downstream SQL is itself evidence of what the source
    // exposes, so adopt the columns its consumers actually select from it.
    for (const { upstreamNodes, parsedCols } of classified) {
      for (const col of parsedCols) {
        const src = resolveSourceNode(col.sourceAlias, upstreamNodes);
        if (!src) continue;
        const list = colsByModel.get(src.id);
        // Only when nothing is known — never contradict a declared schema.
        if (!list || list.length > 0) continue;
        const name = col.sourceCol ?? col.outputCol;
        if (!name || name === '*') continue;
        inferred.add(src.id);
        pendingCols.set(src.id, (pendingCols.get(src.id) ?? new Set()).add(name));
      }
    }
    for (const [nodeId, names] of pendingCols) {
      const list = colsByModel.get(nodeId);
      if (!list || list.length > 0) continue;
      const seen = new Set<string>();
      for (const name of names) {
        const key = name.toLowerCase();
        if (seen.has(key)) continue;
        seen.add(key);
        // Same array instance the ModelNode holds, so the node updates with it.
        list.push({ id: `${nodeId}::${name}`, name, dataType: null, description: '' });
      }
      list.sort((a, b) => a.name.localeCompare(b.name));
    }

    // ── Pass 3: build edges now that upstream schemas are as complete as possible
    for (const { node, modelNode, upstreamNodes, parsedCols } of classified) {
      const before = columnEdges.length;
      try {
        columnEdges.push(
          ...this.buildEdges(
            node.uniqueId, parsedCols, upstreamNodes, colsByModel,
            buildExpressionMap(node.rawSql), drop,
          ),
        );
      } catch {
        modelNode.parseStatus = 'failed';
        continue;
      }

      if (columnEdges.length > before) {
        parsedCount++;
        modelNode.parseStatus = 'parsed';
      } else {
        modelNode.parseStatus = 'fallback';
      }
    }

    // Sources → their downstream consumers
    for (const node of nodeById.values()) {
      if (node.resourceType !== 'source') continue;
      for (const downNode of nodeById.values()) {
        if (downNode.dependsOnNodes.includes(node.uniqueId)) {
          modelEdges.push({ sourceModelId: node.uniqueId, targetModelId: downNode.uniqueId });
        }
      }
    }

    const totalColumns = models.reduce((s, m) => s + m.columns.length, 0);

    // Denominator = models we could even attempt, i.e. those with SQL and at least
    // one upstream. Counting "models with any columns" instead made the rate fall
    // when catalog.json was added, purely because more nodes then had columns.
    const analyzableModels = [...nodeById.values()].filter(
      (n) =>
        n.resourceType === 'model' &&
        !!n.rawSql &&
        n.dependsOnNodes.some((id) => nodeById.has(id)),
    ).length;
    const deduped = deduplicateEdges(columnEdges);

    return {
      models,
      columnEdges: deduped,
      modelEdges: deduplicateModelEdges(modelEdges),
      metadata: {
        totalModels: models.filter((m) => m.resourceType === 'model').length,
        totalSources: models.filter((m) => m.resourceType === 'source').length,
        totalColumns,
        totalEdges: deduped.length,
        parseSuccessRate:
          analyzableModels > 0 ? Math.round((parsedCount / analyzableModels) * 100) : 0,
        dropReasons: { ...drop },
        hasCatalog: catalog !== null,
        inferredSchemas: inferred.size,
      },
    };
  }

  /**
   * Turn classified columns into edges. Mirrors VORO's `upsertColumnEdges`:
   * resolve the source node, downgrade misclassified transforms, then validate
   * the source column exists — but only when the upstream's schema is rich
   * enough for a miss to actually mean something.
   */
  private buildEdges(
    targetModelId: string,
    parsedCols: ParsedColumn[],
    upstreamNodes: DBNode[],
    colsByModel: Map<string, ColumnNode[]>,
    expressions: Map<string, string>,
    drop: DropStats,
  ): ColumnEdge[] {
    const edges: ColumnEdge[] = [];

    const targetColList = colsByModel.get(targetModelId) ?? [];
    const targetByName = new Map(targetColList.map((c) => [c.name.toLowerCase(), c]));

    // Known columns per upstream: schema.yml ∪ SQL-derived output columns.
    const upstreamColSets = new Map<string, Set<string>>();
    const upstreamHasSql = new Map<string, boolean>();
    for (const n of upstreamNodes) {
      const yamlCols = (n.metadata?.columns as Array<{ name: string }> | undefined) ?? [];
      const sql = (n.metadata?.sql as string | undefined) ?? '';
      const sqlCols = extractSqlOutputCols(sql);
      upstreamColSets.set(
        n.id,
        new Set([
          ...yamlCols.map((c) => c.name.toLowerCase()),
          ...sqlCols.map((c) => c.toLowerCase()),
        ]),
      );
      upstreamHasSql.set(n.id, sqlCols.length > 0);
    }

    for (const col of parsedCols) {
      if (!col.outputCol || col.outputCol === '*') continue;
      drop.candidates++;

      const targetRendered = targetByName.get(col.outputCol.toLowerCase());
      if (!targetRendered) { drop.targetColNotRendered++; continue; }

      const aliasNode = resolveSourceNode(col.sourceAlias, upstreamNodes);
      if (!aliasNode) { drop.noSourceNode++; continue; }
      let sourceNode = aliasNode;

      // A 'transform' with no expression is almost always a misclassified bare
      // column reference — downgrade it when the name exists upstream verbatim.
      let type = col.type;
      let sourceCol = col.sourceCol;
      if (type === 'transform' && !col.expression) {
        const known = upstreamColSets.get(sourceNode.id);
        if (known?.has(col.outputCol.toLowerCase())) {
          type = 'passthrough';
          sourceCol = col.outputCol;
        }
      }

      // passthrough/rename must name a concrete source column; transform and
      // aggregate may not, so fall back to the output name to keep the edge.
      const isTraceable = type === 'passthrough' || type === 'rename';
      if (isTraceable && !sourceCol) { drop.noSourceCol++; continue; }
      const sourceColName = sourceCol ?? col.outputCol;

      // When a column is unqualified or read through a CTE, the analyzer cannot
      // always say which upstream it came from and settles for the first one.
      // Column names are better evidence than that guess: if the chosen upstream
      // does not expose this column and exactly one other does, believe the data.
      // Requires a known schema on both sides, so it stays quiet when we know
      // nothing — and never overrides an upstream that does have the column.
      {
        const key = sourceColName.toLowerCase();
        const exposes = (n: DBNode) =>
          (colsByModel.get(n.id) ?? []).some((c) => c.name.toLowerCase() === key);
        if (upstreamNodes.length > 1 && !exposes(sourceNode)) {
          const holders = upstreamNodes.filter(exposes);
          if (holders.length === 1) {
            sourceNode = holders[0];
            drop.reattributed++;
          }
        }
      }

      // Validate only when the upstream schema is rich enough for a miss to mean
      // something — sparse schemas would otherwise produce false negatives.
      if (isTraceable) {
        const known = upstreamColSets.get(sourceNode.id);
        const hasSql = upstreamHasSql.get(sourceNode.id) ?? false;
        if (
          known &&
          known.size >= 3 &&
          (hasSql || known.size >= 10) &&
          !known.has(sourceColName.toLowerCase())
        ) {
          drop.sourceColNotInUpstream++;
          continue;
        }
      }

      // The endpoint must be a column the source node actually renders, or the
      // edge would attach to a handle that does not exist.
      const sourceRendered = (colsByModel.get(sourceNode.id) ?? []).find(
        (c) => c.name.toLowerCase() === sourceColName.toLowerCase(),
      );
      if (!sourceRendered) {
        drop.sourceColNotRendered++;
        if ((colsByModel.get(sourceNode.id) ?? []).length === 0) drop.srcSchemaUnknown++;
        else drop.srcSchemaMismatch++;
        continue;
      }

      edges.push({
        id: `${sourceRendered.id}->${targetRendered.id}`,
        sourceModelId: sourceNode.id,
        sourceColumnId: sourceRendered.id,
        targetModelId,
        targetColumnId: targetRendered.id,
        transformationType: toGraphType(type),
        // A passthrough's "expression" is just the column name — not worth showing.
        transformExpression:
          type === 'passthrough'
            ? null
            : col.expression ?? expressions.get(col.outputCol.toLowerCase()) ?? null,
      });
    }

    return edges;
  }
}

// ── Helpers ────────────────────────────────────────────────────────────────────

const exprParser = new SqlColumnParser();

/** Counts why candidate column edges were discarded, for diagnosing parse rates. */
interface DropStats {
  candidates: number;
  targetColNotRendered: number;
  noSourceNode: number;
  noSourceCol: number;
  sourceColNotInUpstream: number;
  sourceColNotRendered: number;
  srcSchemaUnknown: number;
  srcSchemaMismatch: number;
  reattributed: number;
}
function newDropStats(): DropStats {
  return {
    candidates: 0, targetColNotRendered: 0, noSourceNode: 0,
    noSourceCol: 0, sourceColNotInUpstream: 0, sourceColNotRendered: 0,
    srcSchemaUnknown: 0, srcSchemaMismatch: 0, reattributed: 0,
  };
}

/**
 * Maps output column → its SELECT expression, e.g. `lifetime_value` → `SUM(amount)`.
 *
 * VORO's analyzer classifies transform types but only records the expression text on
 * two of its code paths, so most edges arrive with none. This second, AST-based pass
 * exists purely to populate the edge tooltip — it never affects classification, and a
 * parse failure just means the tooltip omits the expression.
 */
function buildExpressionMap(rawSql: string): Map<string, string> {
  const out = new Map<string, string>();
  try {
    const { cleanedSql } = cleanJinja(rawSql);
    for (const c of exprParser.parse(cleanedSql).columns) {
      if (c.expression) out.set(c.name.toLowerCase(), c.expression);
    }
  } catch {
    // Best-effort enrichment only.
  }
  return out;
}

/** Adapts a manifest node into the shape VORO's analyzer expects. */
function toDbNode(node: ManifestNode): DBNode {
  return {
    id: node.uniqueId,
    name: node.name,
    type: node.resourceType,
    metadata: {
      columns: node.columns.map((c) => ({ name: c.name })),
      sql: node.resourceType === 'model' ? node.rawSql : '',
    },
  };
}

/** VORO's 'unknown' has no place in the graph — treat it as a transform. */
function toGraphType(t: ParsedColumn['type']): TransformationType {
  return t === 'unknown' ? 'transform' : t;
}

function inferLayer(node: ManifestNode): string {
  if (node.resourceType === 'source') return 'source';
  const parts = node.originalFilePath.replace(/\\/g, '/').split('/');
  const modelsIdx = parts.indexOf('models');
  if (modelsIdx >= 0 && modelsIdx + 2 < parts.length) return parts[modelsIdx + 1];
  const name = node.name;
  if (name.startsWith('stg_')) return 'staging';
  if (name.startsWith('int_')) return 'intermediate';
  if (name.startsWith('dim_') || name.startsWith('fct_')) return 'marts';
  return 'model';
}

function deduplicateEdges(edges: ColumnEdge[]): ColumnEdge[] {
  const seen = new Set<string>();
  return edges.filter((e) => {
    if (seen.has(e.id)) return false;
    seen.add(e.id);
    return true;
  });
}

function deduplicateModelEdges(edges: ModelEdge[]): ModelEdge[] {
  const seen = new Set<string>();
  return edges.filter((e) => {
    const key = `${e.sourceModelId}->${e.targetModelId}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}
