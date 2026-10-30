/**
 * VORO column-lineage SQL analyzer.
 *
 * Ported verbatim from VORO's production analyzer (internal ai-governance service).
 *
 * This is the deterministic ('sql') path — the same code VORO's `voro-column-flow`
 * pg-boss job runs. VORO's own LLM path (workspace-owned key, internal service) is
 * NOT ported. The extension instead has its own, unrelated opt-in AI fallback for
 * edges this analyzer can't resolve — see ./llmResolver.ts — which is off by
 * default and uses a user-supplied endpoint/key, not VORO's.
 *
 * Handles: CTEs (transparent + non-transparent chains), JOINs, window functions,
 * aggregates (25+ functions), casts (::, CAST, TRY_CAST, SAFE_CAST, CONVERT),
 * UNION (first branch), SELECT *, SELECT t.*, literals, all major dialects.
 *
 * Keep this file in sync with VORO's copy — do not "improve" it locally.
 */

import _nspPkg from 'node-sql-parser';
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const { Parser: _CfSqlParser } = _nspPkg as unknown as { Parser: new () => any };
const cfParser = new _CfSqlParser();

// ── Types ──────────────────────────────────────────────────────────────────────

export type TransformType = 'passthrough' | 'rename' | 'transform' | 'aggregate' | 'unknown';

export interface ParsedColumn {
  outputCol: string;
  type: TransformType;
  sourceCol?: string;
  sourceAlias?: string;
  expression?: string;
}

/**
 * Upstream model as the analyzer sees it. In VORO this is a DB row; here it is
 * built straight from manifest.json. `metadata.columns` is the schema.yml column
 * list and `metadata.sql` is the model's raw SQL — both used for SELECT * expansion.
 */
export interface DBNode {
  id: string;
  name: string;
  type: string;
  metadata: Record<string, unknown>;
}

type SqlAstNode = Record<string, unknown>;

// ── SQL parser ─────────────────────────────────────────────────────────────────

const AGG_RE = /\b(SUM|COUNT|AVG|MIN|MAX|ARRAY_AGG|STRING_AGG|JSON_AGG|LISTAGG|GROUP_CONCAT|BOOL_AND|BOOL_OR|PERCENTILE_CONT|PERCENTILE_DISC|STDDEV|VARIANCE)\s*\(/i;

/** Split a string by top-level commas (respects parentheses and string literals). */
function splitByComma(str: string): string[] {
  const parts: string[] = [];
  let depth = 0;
  let inStr = false;
  let strChar = '';
  let current = '';

  for (let i = 0; i < str.length; i++) {
    const c = str[i];
    if (inStr) {
      current += c;
      if (c === strChar && str[i - 1] !== '\\') inStr = false;
    } else if (c === "'" || c === '"') {
      inStr = true;
      strChar = c;
      current += c;
    } else if (c === '(') {
      depth++;
      current += c;
    } else if (c === ')') {
      depth--;
      current += c;
    } else if (c === ',' && depth === 0) {
      if (current.trim()) parts.push(current.trim());
      current = '';
    } else {
      current += c;
    }
  }
  if (current.trim()) parts.push(current.trim());
  return parts;
}

/**
 * Extract the final (outermost) SELECT clause from SQL.
 * Handles WITH … AS (…) CTEs by tracking paren depth.
 */
function extractSelectClause(sql: string): string | null {
  const cleaned = sql
    .replace(/--[^\n]*/g, ' ')
    .replace(/\/\*[\s\S]*?\*\//g, ' ');

  let depth = 0;
  let lastSelectEnd = -1;
  let fromPos = -1;
  const up = cleaned.toUpperCase();

  for (let i = 0; i < cleaned.length; i++) {
    const c = cleaned[i];
    if (c === '(') { depth++; continue; }
    if (c === ')') { depth--; continue; }
    if (depth !== 0) continue;

    if (up.slice(i, i + 6) === 'SELECT' && !/[A-Z0-9_]/i.test(cleaned[i + 6] ?? ' ')) {
      lastSelectEnd = i + 6;
      fromPos = -1;
    }
    if (lastSelectEnd !== -1 && fromPos === -1 &&
        up.slice(i, i + 4) === 'FROM' && !/[A-Z0-9_]/i.test(cleaned[i + 4] ?? ' ')) {
      fromPos = i;
    }
  }

  if (lastSelectEnd === -1) return null;
  const end = fromPos !== -1 ? fromPos : cleaned.length;
  const clause = cleaned.slice(lastSelectEnd, end).trim();
  return clause.replace(/^(DISTINCT|ALL)\s+/i, '');
}

// SQL keywords that should never be treated as column references
const SQL_KEYWORDS = new Set([
  'AS','CASE','WHEN','THEN','ELSE','END','AND','OR','NOT','NULL','TRUE','FALSE',
  'IS','IN','LIKE','BETWEEN','DISTINCT','FROM','SELECT','WHERE','JOIN','ON',
  'GROUP','BY','ORDER','HAVING','LIMIT','OFFSET','UNION','INTERSECT','EXCEPT',
  'WITH','OVER','PARTITION','ROWS','RANGE','PRECEDING','FOLLOWING','CURRENT',
  'ROW','UNBOUNDED','ALL','ANY','EXISTS','SOME','INTO','SET','VALUES',
]);

/**
 * Walk an SQL expression left-to-right and return the first token that looks like
 * a real column reference (not a keyword, not a function name, not a number).
 */
function extractFirstColRef(expr: string): { sourceCol: string; sourceAlias?: string } | null {
  const re = /\b([a-z_][a-z0-9_]*)(?:\s*\.\s*([a-z_][a-z0-9_]*))?(\s*\()?/gi;
  let m: RegExpExecArray | null;
  while ((m = re.exec(expr)) !== null) {
    const first  = m[1];
    const second = m[2];
    const isFunc = !!m[3];
    if (isFunc) continue;
    if (SQL_KEYWORDS.has(first.toUpperCase())) continue;
    if (second) return { sourceCol: second, sourceAlias: first };
    return { sourceCol: first };
  }
  return null;
}

/** Parse a single column expression and return its transform classification. */
function parseColumnExpr(expr: string): ParsedColumn {
  const trimmed = expr.trim().replace(/\s+/g, ' ');

  const asMatch = trimmed.match(/^([\s\S]+?)\s+AS\s+([a-z_][a-z0-9_]*)$/i);
  const base  = asMatch ? asMatch[1].trim() : trimmed;
  const alias = asMatch ? asMatch[2] : null;

  const outputCol = alias ?? (base.includes('.') ? base.split('.').pop()! : base).replace(/[^a-z0-9_]/gi, '_');

  if (AGG_RE.test(base)) {
    const innerMatch = base.match(/\(\s*([\s\S]+?)\s*\)$/);
    const inner = innerMatch ? innerMatch[1].replace(/^DISTINCT\s+/i, '') : '';
    const ref = inner && inner !== '*' ? extractFirstColRef(inner) : null;
    return { outputCol, type: 'aggregate', expression: trimmed, sourceCol: ref?.sourceCol, sourceAlias: ref?.sourceAlias };
  }

  const dotMatch = base.match(/^([a-z_][a-z0-9_]*)\.([a-z_][a-z0-9_]*)$/i);
  if (dotMatch) {
    const sourceAlias = dotMatch[1];
    const sourceCol   = dotMatch[2];
    const type: TransformType = alias && alias.toLowerCase() !== sourceCol.toLowerCase() ? 'rename' : 'passthrough';
    return { outputCol, type, sourceCol, sourceAlias };
  }

  const bareMatch = base.match(/^([a-z_][a-z0-9_]*)$/i);
  if (bareMatch) {
    const sourceCol = base;
    const type: TransformType = alias && alias.toLowerCase() !== sourceCol.toLowerCase() ? 'rename' : 'passthrough';
    return { outputCol, type, sourceCol };
  }

  const ref = extractFirstColRef(base);
  return { outputCol, type: 'transform', expression: trimmed, sourceCol: ref?.sourceCol, sourceAlias: ref?.sourceAlias };
}

/** Parse all columns in a model's SQL (regex fallback when the AST fails). */
export function parseSqlColumns(sql: string): ParsedColumn[] {
  const clause = extractSelectClause(sql);
  if (!clause) return [];
  return splitByComma(clause)
    .filter(e => e && e !== '*' && !e.match(/^\d+$/))
    .map(parseColumnExpr);
}

/**
 * Extract the output column names from a model's SQL SELECT clause.
 * Used to supplement sparse YAML column lists with the real columns the model produces.
 */
export function extractSqlOutputCols(sql: string): string[] {
  if (!sql.trim()) return [];
  return parseSqlColumns(sql).map(c => c.outputCol).filter(Boolean);
}

// ══════════════════════════════════════════════════════════════════════════════
// Production SQL Classifier — classifyModelColumns()
// ══════════════════════════════════════════════════════════════════════════════

// ── CTE data structures ───────────────────────────────────────────────────────

interface CteColEntry {
  alias:       string;
  sourceModel: string | null;
  sourceCol:   string | null;
  type:        TransformType;
}

interface CteEntry {
  isTransparent: boolean;
  sourceModel:   string | null;
  columns:       Map<string, CteColEntry>;
}

// ── Jinja cleaner ─────────────────────────────────────────────────────────────

/**
 * ref()/source() are expanded to the REAL model/table name, not a placeholder.
 * Placeholders break the alias map: `FROM {{ ref('orders') }} AS o` would give
 * o → __ref__, which matches no upstream, so every column edge gets discarded.
 */
function cfCleanSql(sql: string): string {
  let s = sql
    .replace(/\{\{\s*ref\s*\(\s*['"]([^'"]+)['"]\s*\)\s*\}\}/g, '$1')
    .replace(/\{\{\s*ref\s*\(\s*['"][^'"]+['"]\s*,\s*['"]([^'"]+)['"]\s*\)\s*\}\}/g, '$1')
    .replace(/\{\{\s*source\s*\(\s*['"][^'"]+['"]\s*,\s*['"]([^'"]+)['"]\s*\)\s*\}\}/g, '$1')
    .replace(/\{\{.*?\}\}/gs, '__jinja__')
    .replace(/\{%-?.*?-?%\}/gs, '')
    .replace(/--[^\n]*/g, '')
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .trim();

  // Strip leading dbt config blocks
  s = s.replace(/^__jinja__\s*/i, '');

  // Remove WHERE / HAVING / QUALIFY clauses whose entire body is a Jinja macro
  s = s.replace(/\b(WHERE|HAVING|QUALIFY)\s+__jinja__\b/gi, '');

  return s.trim();
}

// ── AST parser (tries multiple dialects) ─────────────────────────────────────

/**
 * dbt records the warehouse in `manifest.metadata.adapter_type`, so the right
 * grammar can be chosen per project instead of guessing. Parsing Snowflake SQL
 * with the PostgreSQL grammar is a large source of silent failures.
 */
const ADAPTER_DIALECTS: Record<string, string> = {
  snowflake:  'Snowflake',
  bigquery:   'BigQuery',
  redshift:   'Redshift',
  postgres:   'PostgreSQL',
  duckdb:     'PostgreSQL',
  athena:     'Athena',
  trino:      'Trino',
  presto:     'Trino',
  databricks: 'Hive',
  spark:      'Hive',
  hive:       'Hive',
  mysql:      'MySQL',
  fabric:     'TransactSQL',
  synapse:    'TransactSQL',
  sqlserver:  'TransactSQL',
};

// Generic fallback chain, tried after the project's own dialect.
const FALLBACK_DIALECTS = ['PostgreSQL', 'BigQuery', 'Snowflake', 'MySQL'];
let cfDialects: string[] = FALLBACK_DIALECTS;

/** Called once per build with the manifest's adapter_type. */
export function setAdapterDialect(adapterType: string): void {
  const preferred = ADAPTER_DIALECTS[(adapterType ?? '').toLowerCase()];
  cfDialects = preferred
    ? [preferred, ...FALLBACK_DIALECTS.filter((d) => d !== preferred)]
    : FALLBACK_DIALECTS;
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function cfSafeParse(sql: string): any | null {
  const clean = cfCleanSql(sql);
  for (const db of cfDialects) {
    try {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const ast = (cfParser as any).astify(clean, { database: db });
      return Array.isArray(ast) ? ast[0] : ast;
    } catch { /* try next dialect */ }
  }
  return null;
}

// ── AST node utilities ────────────────────────────────────────────────────────

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function cfColName(col: any): string {
  if (typeof col === 'string') return col;
  if (col?.expr?.value) return String(col.expr.value);
  if (col?.value)       return String(col.value);
  return String(col ?? '');
}

function cfStripSchema(name: string): string {
  return (name.split('.').pop() ?? name).replace(/["`[\]]/g, '').toLowerCase();
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function cfFuncName(node: any): string {
  const n = node?.name;
  if (typeof n === 'string') return n.toLowerCase();
  if (n?.name) return String(n.name).toLowerCase();
  if (Array.isArray(n)) return n.map((p: unknown) => (p as Record<string, unknown>)?.value ?? p).join('.').toLowerCase();
  return '';
}

interface CfColRef { table: string | null; column: string }

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function cfCollectRefs(node: any, out: CfColRef[] = [], depth = 0): CfColRef[] {
  if (!node || typeof node !== 'object' || depth > 12) return out;
  if (node.type === 'column_ref') {
    // `table` has the same string-or-object shape as `column` in node-sql-parser v5
    // ({ type:'default', value:'t' }), so it must go through cfColName too — calling
    // .toLowerCase() on the object form throws and aborts the whole graph build.
    const tbl = node.table ? cfColName(node.table).toLowerCase() : null;
    out.push({ table: tbl || null, column: cfColName(node.column) });
    return out;
  }
  for (const v of Object.values(node)) {
    if (v && typeof v === 'object') cfCollectRefs(v, out, depth + 1);
  }
  return out;
}

// ── Aggregate detection ───────────────────────────────────────────────────────

const CF_AGG_NAMES = new Set([
  'count','sum','avg','average','min','max',
  'array_agg','string_agg','listagg','group_concat','json_agg','jsonb_agg',
  'bool_and','bool_or','bit_and','bit_or',
  'percentile_cont','percentile_disc',
  'approx_count_distinct','approx_quantiles',
  'median','mode','any_value',
  'var_pop','var_samp','variance',
  'stddev_pop','stddev_samp','stddev',
  'corr','covar_pop','covar_samp','covar',
  'regr_slope','regr_intercept','regr_r2',
  'kurtosis','skewness',
  'first','last','collect_list','collect_set','hll_count',
]);

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function cfIsAggNode(node: any): boolean {
  if (!node || typeof node !== 'object') return false;
  if (node.type === 'aggr_func') return true;
  if (node.type === 'function') {
    const n = cfFuncName(node);
    return CF_AGG_NAMES.has(n) || n.endsWith('_agg');
  }
  return false;
}

/** True if expression contains an aggregate function NOT wrapped by OVER (not a window). */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
function cfContainsAgg(node: any, depth = 0): boolean {
  if (!node || typeof node !== 'object' || depth > 10) return false;
  // DEVIATION from VORO: `== null` instead of `=== undefined`. See cfIsWindow.
  if (cfIsAggNode(node)) return node.over == null && node.type !== 'window_func';
  return Object.values(node).some(v => v && typeof v === 'object' && cfContainsAgg(v, depth + 1));
}

/**
 * DEVIATION from VORO: VORO tests `node.over !== undefined`, but node-sql-parser
 * v5 emits `over: null` on every non-window aggregate. Under `!== undefined`,
 * `null` passes — so plain SUM()/COUNT() take the window branch in
 * cfClassifyExpr and get classified 'transform'. The result is that the
 * 'aggregate' category is never produced at all. `!= null` is the intended test.
 *
 * Verified against node-sql-parser 5.4.0, the version both projects pin.
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
function cfIsWindow(node: any): boolean {
  return !!node && (node.type === 'window_func' || node.over != null);
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function cfIsLiteral(node: any): boolean {
  if (!node) return false;
  const t = node.type;
  if (['string','number','bool','boolean','null'].includes(t)) return true;
  if (t === 'function') {
    const n = cfFuncName(node);
    return /^(current_date|current_timestamp|now|getdate|sysdate|current_time)$/.test(n);
  }
  return false;
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function cfIsCast(node: any): boolean {
  if (!node) return false;
  if (node.type === 'cast') return true;
  if (node.type === 'function') {
    const n = cfFuncName(node);
    return /^(cast|try_cast|safe_cast|convert|try_convert|to_number|to_varchar|to_date|to_timestamp)$/.test(n);
  }
  return false;
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function cfCastInner(node: any): any {
  if (node.type === 'cast') return node.expr ?? node.from ?? null;
  if (node.type === 'function') {
    const args: unknown[] = Array.isArray(node.args?.value)
      ? node.args.value : (node.args?.value ? [node.args.value] : []);
    const n = cfFuncName(node);
    // CONVERT(type, col) → col is second arg; all others → col is first arg
    const idx = n === 'convert' && args.length >= 2 ? 1 : 0;
    const a = args[idx] as Record<string, unknown> | null | undefined;
    return (a as Record<string, unknown>)?.value ?? a ?? null;
  }
  return null;
}

// ── Upstream lookup (multi-key) ───────────────────────────────────────────────

function cfBuildUpstreamLookup(nodes: DBNode[]): Map<string, DBNode> {
  const map = new Map<string, DBNode>();
  for (const n of nodes) {
    const lower = n.name.toLowerCase();
    map.set(lower, n);
    // Source nodes stored as "schema.table" — also index by table part
    if (lower.includes('.')) {
      const tablePart = lower.slice(lower.indexOf('.') + 1);
      map.set(tablePart, n);
    }
    // Strip common dbt layer prefixes for fuzzy alias resolution
    const bare = lower.replace(/^(raw_|stg_|int_|core_|fct_|dim_|analytic_|analytics_|staging_|source_)/, '');
    if (bare !== lower && !map.has(bare)) map.set(bare, n);
  }
  return map;
}

// ── FROM / JOIN alias map for one SELECT statement ────────────────────────────

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function cfBuildAliasMap(stmt: any): Map<string, string> {
  const map = new Map<string, string>();
  const froms: unknown[] = Array.isArray(stmt.from)
    ? stmt.from : (stmt.from ? [stmt.from] : []);
  for (const f of froms) {
    if (!f || typeof f !== 'object') continue;
    const fr = f as Record<string, unknown>;
    if (fr.type === 'subquery') continue;
    const tname = cfStripSchema(cfColName(fr.table ?? fr.name ?? ''));
    const alias = String((fr.as ?? fr.alias) ?? tname).toLowerCase();
    if (tname) {
      map.set(alias, tname);
      if (alias !== tname) map.set(tname, tname);
    }
  }
  return map;
}

// ── CTE map construction ──────────────────────────────────────────────────────

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function cfBuildCteMap(ast: any, upstreamLookup: Map<string, DBNode>): Map<string, CteEntry> {
  const cteMap = new Map<string, CteEntry>();
  if (!Array.isArray(ast.with)) return cteMap;

  for (const cte of ast.with as unknown[]) {
    const c = cte as Record<string, unknown>;
    const rawName = c.name;
    const cteName = (
      typeof rawName === 'string' ? rawName
      : ((rawName as Record<string, unknown>)?.value ?? (rawName as Record<string, unknown>)?.name ?? '')
    ).toString().toLowerCase();
    if (!cteName) continue;

    const stmtWrapper = c.stmt as Record<string, unknown> | undefined;
    const stmt = (stmtWrapper?.ast ?? stmtWrapper) as Record<string, unknown> | undefined;
    if (!stmt || stmt.type !== 'select') continue;

    cteMap.set(cteName, cfParseCteBody(stmt, upstreamLookup, cteMap));
  }
  return cteMap;
}

function cfParseCteBody(
  stmt: SqlAstNode,
  upstreamLookup: Map<string, DBNode>,
  existingCtes: Map<string, CteEntry>,
): CteEntry {
  const cols: unknown[] = Array.isArray(stmt.columns) ? stmt.columns : [];
  const froms: unknown[] = Array.isArray(stmt.from)
    ? stmt.from : (stmt.from ? [stmt.from] : []);
  const mainFrom = froms.find(f => f && typeof f === 'object' && !(f as Record<string, unknown>).join) as
    Record<string, unknown> | undefined;

  // Transparent: SELECT * FROM single_source
  const isStarCols = cols.length === 1 &&
    (cols[0] === '*' ||
      ((cols[0] && typeof cols[0] === 'object'
        ? ((cols[0] as SqlAstNode).expr as SqlAstNode | undefined)
        : undefined)?.column === '*'));
  if (isStarCols && mainFrom && mainFrom.type !== 'subquery') {
    const fromName = cfStripSchema(cfColName(mainFrom.table ?? mainFrom.name ?? ''));
    if (fromName) {
      const upstream = upstreamLookup.get(fromName);
      if (upstream) return { isTransparent: true, sourceModel: upstream.name, columns: new Map() };
      const other = existingCtes.get(fromName);
      if (other?.isTransparent && other.sourceModel)
        return { isTransparent: true, sourceModel: other.sourceModel, columns: new Map() };
    }
  }

  // Non-transparent: classify each output column
  const aliasMap = cfBuildAliasMap(stmt);
  const columns = new Map<string, CteColEntry>();
  for (const col of cols) {
    if (col === '*') continue;
    const colRec = col as Record<string, unknown>;
    if ((colRec?.expr as Record<string, unknown>)?.column === '*') continue;

    const expr = colRec?.expr;
    const rawAs = colRec?.as;
    const inferredName = (expr as Record<string, unknown>)?.type === 'column_ref'
      ? cfColName((expr as Record<string, unknown>).column) : null;
    const alias = (typeof rawAs === 'string' ? rawAs : (inferredName ?? '')).toLowerCase();
    if (!alias) continue;

    const classified = cfClassifyExpr(expr, aliasMap, existingCtes, upstreamLookup);
    let type: TransformType = classified.type;
    if (type === 'passthrough' && classified.sourceCol && alias !== classified.sourceCol.toLowerCase())
      type = 'rename';

    columns.set(alias, {
      alias,
      sourceModel: classified.sourceAlias ?? null,
      sourceCol:   classified.sourceCol ?? null,
      type,
    });
  }
  return { isTransparent: false, sourceModel: null, columns };
}

// ── Alias → upstream resolver ─────────────────────────────────────────────────

function cfResolveAlias(
  tableAlias: string | null,
  colName:    string,
  aliasMap:   Map<string, string>,
  cteMap:     Map<string, CteEntry>,
  upstreamLookup: Map<string, DBNode>,
): { sourceModel: string | null; sourceCol: string; type: TransformType } {
  if (!tableAlias) return { sourceModel: null, sourceCol: colName, type: 'passthrough' };

  const realName = aliasMap.get(tableAlias) ?? tableAlias;
  const cteEntry = cteMap.get(realName);

  if (cteEntry) {
    if (cteEntry.isTransparent)
      return { sourceModel: cteEntry.sourceModel, sourceCol: colName, type: 'passthrough' };
    const cteCol = cteEntry.columns.get(colName.toLowerCase());
    if (cteCol) return { sourceModel: cteCol.sourceModel, sourceCol: cteCol.sourceCol ?? colName, type: cteCol.type };
    return { sourceModel: null, sourceCol: colName, type: 'transform' };
  }

  const upstream = upstreamLookup.get(realName);
  if (upstream) return { sourceModel: upstream.name, sourceCol: colName, type: 'passthrough' };

  return { sourceModel: null, sourceCol: colName, type: 'transform' };
}

// ── Expression classifier ─────────────────────────────────────────────────────

function cfClassifyExpr(
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  expr: any,
  aliasMap:  Map<string, string>,
  cteMap:    Map<string, CteEntry>,
  upstreamLookup: Map<string, DBNode>,
): Pick<ParsedColumn, 'type' | 'sourceCol' | 'sourceAlias'> {
  if (!expr) return { type: 'transform' };

  // Window function (OVER clause present) → always TRANSFORM
  if (cfIsWindow(expr)) {
    const args: unknown[] = Array.isArray(expr.args?.value) ? expr.args.value
                          : (expr.args?.value ? [expr.args.value] : []);
    const refs = cfCollectRefs(args[0] ?? expr.args ?? {});
    const first = refs[0];
    if (first) {
      const r = cfResolveAlias(first.table, first.column, aliasMap, cteMap, upstreamLookup);
      return { type: 'transform', sourceCol: r.sourceCol, sourceAlias: r.sourceModel ?? undefined };
    }
    return { type: 'transform' };
  }

  // Aggregate (no OVER) → AGGREGATE
  if (cfContainsAgg(expr)) {
    const refs = cfCollectRefs(expr);
    const first = refs[0];
    if (first) {
      const r = cfResolveAlias(first.table, first.column, aliasMap, cteMap, upstreamLookup);
      return { type: 'aggregate', sourceCol: r.sourceCol, sourceAlias: r.sourceModel ?? undefined };
    }
    return { type: 'aggregate' };
  }

  // CAST / TRY_CAST / SAFE_CAST / CONVERT → passthrough if inner is bare column ref
  if (cfIsCast(expr)) {
    const inner = cfCastInner(expr);
    if (inner && typeof inner === 'object' && (inner as Record<string, unknown>).type === 'column_ref') {
      const colName   = cfColName((inner as Record<string, unknown>).column);
      const tableAlias = ((inner as Record<string, unknown>).table as string | null)?.toLowerCase() ?? null;
      const r = cfResolveAlias(tableAlias, colName, aliasMap, cteMap, upstreamLookup);
      return { type: 'passthrough', sourceCol: r.sourceCol, sourceAlias: r.sourceModel ?? undefined };
    }
    return { type: 'transform' };
  }

  // Literal value → TRANSFORM, no source
  if (cfIsLiteral(expr)) return { type: 'transform' };

  // Direct column reference
  if (expr.type === 'column_ref') {
    const colName   = cfColName(expr.column);
    // `as string` is a lie here — v5 can hand back { type:'default', value:'t' }.
    const tableAlias = expr.table ? cfColName(expr.table).toLowerCase() || null : null;
    const r = cfResolveAlias(tableAlias, colName, aliasMap, cteMap, upstreamLookup);
    return { type: r.type, sourceCol: r.sourceCol, sourceAlias: r.sourceModel ?? undefined };
  }

  // Everything else (CASE, arithmetic, string functions, etc.) → TRANSFORM
  const refs = cfCollectRefs(expr);
  const first = refs[0];
  if (first) {
    const r = cfResolveAlias(first.table, first.column, aliasMap, cteMap, upstreamLookup);
    return { type: 'transform', sourceCol: r.sourceCol, sourceAlias: r.sourceModel ?? undefined };
  }
  return { type: 'transform' };
}

// ── SELECT * expansion ────────────────────────────────────────────────────────

function cfExpandStar(
  tableQualifier: string | null,
  aliasMap: Map<string, string>,
  cteMap:   Map<string, CteEntry>,
  upstreamLookup: Map<string, DBNode>,
  upstreamColSets: Map<string, Set<string>>,
): ParsedColumn[] {
  const result: ParsedColumn[] = [];

  const addFromNode = (node: DBNode) => {
    const colSet = upstreamColSets.get(node.id);
    if (colSet && colSet.size >= 3) {
      for (const c of colSet)
        result.push({ outputCol: c, type: 'passthrough', sourceCol: c, sourceAlias: node.name });
    } else {
      // Unknown schema — emit one wildcard sentinel edge
      result.push({ outputCol: '*', type: 'passthrough', sourceCol: '*', sourceAlias: node.name });
    }
  };

  if (tableQualifier) {
    const realName  = aliasMap.get(tableQualifier) ?? tableQualifier;
    const cteEntry  = cteMap.get(realName);
    if (cteEntry?.isTransparent && cteEntry.sourceModel) {
      const node = upstreamLookup.get(cteEntry.sourceModel);
      if (node) addFromNode(node);
    } else if (!cteEntry) {
      const node = upstreamLookup.get(realName);
      if (node) addFromNode(node);
    }
  } else {
    // Bare SELECT * — all upstreams
    const seen = new Set<string>();
    for (const node of upstreamLookup.values()) {
      if (!seen.has(node.id)) { seen.add(node.id); addFromNode(node); }
    }
  }
  return result;
}

// ── Post-processing ───────────────────────────────────────────────────────────

function cfPostProcess(
  cols: ParsedColumn[],
  upstreamLookup: Map<string, DBNode>,
  upstreamColSets: Map<string, Set<string>>,
): ParsedColumn[] {
  return cols.map(col => {
    // Resolve sourceAlias to canonical node name
    if (col.sourceAlias) {
      const node = upstreamLookup.get(col.sourceAlias.toLowerCase());
      if (node && node.name !== col.sourceAlias) col = { ...col, sourceAlias: node.name };
    }
    // Downgrade transform-with-no-expression → passthrough when output col exists upstream
    if (col.type === 'transform' && !col.expression && col.outputCol && col.sourceAlias) {
      const node = upstreamLookup.get(col.sourceAlias.toLowerCase());
      if (node) {
        const colSet = upstreamColSets.get(node.id);
        if (colSet && colSet.has(col.outputCol.toLowerCase()))
          return { ...col, type: 'passthrough' as TransformType };
      }
    }
    return col;
  });
}

// ── Source node resolution ────────────────────────────────────────────────────

/**
 * Resolve a table alias → upstream node.
 *
 * After Jinja cleanup, FROM clauses look like:
 *   FROM stg_orders AS o          → sourceAlias = 'o', table = 'stg_orders'
 *   FROM stg_orders               → sourceAlias = 'stg_orders' (no alias)
 *
 * Source nodes may be named "schema.table", while the alias in cleaned SQL is
 * just the table part — so both forms are checked.
 */
export function resolveSourceNode(
  sourceAlias: string | undefined,
  upstreamNodes: DBNode[],
): DBNode | undefined {
  if (!sourceAlias) return upstreamNodes[0]; // single upstream — assume it
  const lower = sourceAlias.toLowerCase();
  return upstreamNodes.find(n => {
    const name = n.name.toLowerCase();
    const tablePart = name.includes('.') ? name.slice(name.indexOf('.') + 1) : name;
    return name === lower
      || tablePart === lower
      || name.endsWith('_' + lower)
      || lower.endsWith('_' + name)
      || lower.endsWith('_' + tablePart)
      || name.startsWith(lower)
      || tablePart.startsWith(lower);
  }) ?? upstreamNodes[0];
}

// ── Main entry point ──────────────────────────────────────────────────────────

/**
 * Classify all output columns of a dbt model's compiled SQL.
 * Handles CTEs (transparent + non-transparent chains), JOINs, window functions,
 * 25+ aggregate functions, casts (::, CAST, TRY_CAST, SAFE_CAST, CONVERT),
 * UNION (first branch), SELECT *, SELECT t.*, literals, and all major SQL
 * dialects supported by dbt.
 */
export function classifyModelColumns(sql: string, upstreamNodes: DBNode[]): ParsedColumn[] {
  if (!sql.trim() || upstreamNodes.length === 0) return [];

  const upstreamLookup  = cfBuildUpstreamLookup(upstreamNodes);

  // Build upstream column sets (YAML + SQL output) for SELECT * expansion
  const upstreamColSets = new Map<string, Set<string>>();
  for (const n of upstreamNodes) {
    const yaml    = (n.metadata?.columns as Array<{ name: string }> | undefined) ?? [];
    const nsql    = (n.metadata?.sql as string | undefined) ?? '';
    const sqlCols = extractSqlOutputCols(nsql);
    upstreamColSets.set(n.id, new Set([
      ...yaml.map(c => c.name.toLowerCase()),
      ...sqlCols.map(c => c.toLowerCase()),
    ]));
  }

  const ast = cfSafeParse(sql);
  if (!ast || ast.type !== 'select') return parseSqlColumns(sql); // AST failed → regex

  const cteMap  = cfBuildCteMap(ast, upstreamLookup);
  const aliasMap = cfBuildAliasMap(ast);

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const columns: any[] = Array.isArray(ast.columns) ? ast.columns : [];

  // ── Handle SELECT * FROM final_cte (most common dbt tail pattern) ──────────
  const isBareStar = columns.length === 1 &&
    (columns[0] === '*' || (columns[0]?.expr?.column === '*' && !columns[0]?.expr?.table));

  if (isBareStar) {
    const froms: unknown[] = Array.isArray(ast.from) ? ast.from : (ast.from ? [ast.from] : []);
    const mf = froms.find(f => f && typeof f === 'object' && !(f as Record<string, unknown>).join) as
      Record<string, unknown> | undefined;
    if (mf) {
      const fromName = cfStripSchema(cfColName(mf.table ?? mf.name ?? ''));
      const cteEntry = cteMap.get(fromName);

      // Non-transparent final CTE with known columns → emit its column map
      if (cteEntry && !cteEntry.isTransparent && cteEntry.columns.size > 0) {
        const out: ParsedColumn[] = [];
        for (const [alias, cc] of cteEntry.columns) {
          out.push({ outputCol: alias, type: cc.type, sourceCol: cc.sourceCol ?? alias, sourceAlias: cc.sourceModel ?? undefined });
        }
        return cfPostProcess(out, upstreamLookup, upstreamColSets);
      }

      // Transparent final CTE → expand source's column list
      if (cteEntry?.isTransparent && cteEntry.sourceModel) {
        const srcNode = upstreamLookup.get(cteEntry.sourceModel);
        if (srcNode) {
          const colSet = upstreamColSets.get(srcNode.id);
          if (colSet && colSet.size >= 3) {
            return [...colSet].map(c => ({
              outputCol: c, type: 'passthrough' as TransformType, sourceCol: c, sourceAlias: srcNode.name,
            }));
          }
        }
      }

      // Direct upstream (no CTE layer) → expand its columns
      const directNode = upstreamLookup.get(fromName);
      if (directNode) {
        const colSet = upstreamColSets.get(directNode.id);
        if (colSet && colSet.size >= 3) {
          return [...colSet].map(c => ({
            outputCol: c, type: 'passthrough' as TransformType, sourceCol: c, sourceAlias: directNode.name,
          }));
        }
      }
    }
    return parseSqlColumns(sql); // can't expand * → regex fallback
  }

  // ── Classify each column in the final SELECT ───────────────────────────────
  const result: ParsedColumn[] = [];

  for (const col of columns) {
    // Bare SELECT *
    if (col === '*') {
      result.push(...cfExpandStar(null, aliasMap, cteMap, upstreamLookup, upstreamColSets));
      continue;
    }
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const expr = (col as any)?.expr;
    // Qualified SELECT t.*
    if (expr?.column === '*') {
      const tbl = expr.table ? cfColName(expr.table).toLowerCase() || null : null;
      result.push(...cfExpandStar(tbl, aliasMap, cteMap, upstreamLookup, upstreamColSets));
      continue;
    }

    // Output column name
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const rawAs = (col as any)?.as;
    const inferredName = expr?.type === 'column_ref' ? cfColName(expr.column) : null;
    const outputCol = (typeof rawAs === 'string' ? rawAs : (inferredName ?? '')).toLowerCase();
    if (!outputCol || outputCol === '*') continue;

    const classified = cfClassifyExpr(expr, aliasMap, cteMap, upstreamLookup);

    // passthrough + output name differs from source → rename
    let type = classified.type;
    if (type === 'passthrough' && classified.sourceCol &&
        outputCol !== classified.sourceCol.toLowerCase()) {
      type = 'rename';
    }

    result.push({ outputCol, type, sourceCol: classified.sourceCol, sourceAlias: classified.sourceAlias });
  }

  return cfPostProcess(result, upstreamLookup, upstreamColSets);
}
