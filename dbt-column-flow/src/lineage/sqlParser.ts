import { Parser } from 'node-sql-parser';
import type { TransformationType } from './graphTypes';

export interface Ref {
  table: string | null;
  column: string;
}

export interface ParsedColumn {
  name: string;
  sourceRefs: Ref[];
  transformationType: TransformationType;
  /** Human-readable form of the SELECT expression, e.g. "SUM(amount)". */
  expression: string | null;
}

/** Resolved output columns and real source tables for a single CTE. */
interface CteInfo {
  cols: Map<string, { refs: Ref[]; type: TransformationType; expr: string | null }>;
  tables: string[];
  hasStar: boolean;
}

/**
 * Renders an AST expression back to readable SQL. node-sql-parser's own sqlify()
 * only works on whole statements, and we want just the one SELECT expression to
 * show in the edge tooltip. Unknown node types degrade to null rather than throw.
 */
function printExpr(node: unknown, depth = 0): string | null {
  if (!node || typeof node !== 'object' || depth > 8) return null;
  const n = node as AstNode;

  switch (n['type']) {
    case 'column_ref': {
      const col = identName(n['column']);
      if (!col) return null;
      const tbl = identName(n['table']);
      return tbl ? `${tbl}.${col}` : col;
    }
    case 'number':
      return String(n['value']);
    case 'bool':
      return n['value'] ? 'true' : 'false';
    case 'null':
      return 'NULL';
    case 'single_quote_string':
    case 'string':
      return `'${n['value']}'`;
    case 'star':
      return '*';
    case 'aggr_func': {
      const inner = n['args'] ? printExpr((n['args'] as AstNode)['expr'], depth + 1) : null;
      return `${String(n['name']).toUpperCase()}(${inner ?? '*'})`;
    }
    case 'function': {
      const nameRaw = n['name'];
      const name = typeof nameRaw === 'string'
        ? nameRaw
        : (Array.isArray(nameRaw?.['name']) ? identName(nameRaw['name'][0]) : identName(nameRaw)) ?? '';
      const args = Array.isArray(n['args']?.['value'])
        ? n['args']['value'].map((a: unknown) => printExpr(a, depth + 1) ?? '?').join(', ')
        : '';
      return `${String(name).toUpperCase()}(${args})`;
    }
    case 'binary_expr': {
      const l = printExpr(n['left'], depth + 1);
      const r = printExpr(n['right'], depth + 1);
      if (l === null || r === null) return null;
      return `${l} ${n['operator']} ${r}`;
    }
    case 'case': {
      const parts = Array.isArray(n['args'])
        ? n['args'].map((a: AstNode) => {
            const res = printExpr(a['result'], depth + 1) ?? '?';
            if (a['type'] === 'else') return `ELSE ${res}`;
            const cond = printExpr(a['cond'], depth + 1) ?? '?';
            return `WHEN ${cond} THEN ${res}`;
          })
        : [];
      return `CASE ${parts.join(' ')} END`;
    }
    case 'cast': {
      const inner = printExpr(n['expr'], depth + 1);
      const target = identName(n['target']?.[0]?.['dataType']) ?? n['target']?.[0]?.['dataType'];
      return inner ? `CAST(${inner} AS ${target ?? '?'})` : null;
    }
    case 'expr_list':
      return Array.isArray(n['value'])
        ? n['value'].map((v: unknown) => printExpr(v, depth + 1) ?? '?').join(', ')
        : null;
    default:
      return null;
  }
}

/** Ordering used when a column inherits a stronger transform type through a CTE. */
const TYPE_RANK: Record<TransformationType, number> = {
  passthrough: 0,
  rename: 1,
  transform: 2,
  aggregate: 3,
};

export interface SqlParseResult {
  columns: ParsedColumn[];
  tableRefs: string[];   // placeholder identifiers found in FROM/JOIN
  success: boolean;
}

const AGG_FUNCS = new Set([
  'count', 'sum', 'avg', 'min', 'max', 'array_agg', 'string_agg', 'json_agg',
  'listagg', 'group_concat', 'median', 'percentile_cont', 'percentile_disc',
  'stddev', 'variance', 'var_pop', 'var_samp', 'bool_and', 'bool_or',
  'approx_count_distinct', 'count_if', 'sum_if', 'any_value',
]);

const SQL_KEYWORDS = new Set([
  'select', 'from', 'where', 'join', 'on', 'and', 'or', 'not', 'as',
  'case', 'when', 'then', 'else', 'end', 'in', 'is', 'null', 'true', 'false',
  'between', 'like', 'group', 'order', 'by', 'having', 'limit', 'offset',
  'union', 'all', 'distinct', 'left', 'right', 'inner', 'outer', 'cross',
  'full', 'exists', 'asc', 'desc', 'with', 'recursive', 'over', 'partition',
  'row', 'rows', 'range', 'unbounded', 'preceding', 'following', 'current',
  'coalesce', 'cast', 'extract', 'date_trunc', 'lag', 'lead', 'row_number',
  'rank', 'dense_rank', 'concat', 'trim', 'lower', 'upper', 'replace',
  'round', 'abs', 'ceil', 'floor', 'date', 'timestamp', 'interval',
  'integer', 'varchar', 'text', 'boolean', 'numeric', 'float', 'bigint',
]);

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type AstNode = Record<string, any>;

/**
 * Extracts an identifier name from a node-sql-parser AST field.
 * v4 emits plain strings (`column: "id"`); v5 emits an object
 * (`column: { expr: { type: 'default', value: 'id' } }`). Handle both.
 */
function identName(raw: unknown): string | null {
  if (raw == null) return null;
  if (typeof raw === 'string') return raw;
  if (typeof raw === 'object') {
    const o = raw as AstNode;
    const inner = o['expr'];
    if (inner && typeof inner === 'object' && typeof (inner as AstNode)['value'] === 'string') {
      return (inner as AstNode)['value'];
    }
    if (typeof o['value'] === 'string') return o['value'];
  }
  return null;
}

export class SqlColumnParser {
  private parser = new Parser();

  parse(cleanedSql: string): SqlParseResult {
    const astResult = this.parseWithAst(cleanedSql);
    if (astResult.success && astResult.columns.length > 0) return astResult;
    return this.parseWithRegex(cleanedSql);
  }

  // ── AST path ────────────────────────────────────────────────────────────────

  private parseWithAst(sql: string): SqlParseResult {
    try {
      const ast = this.parser.astify(sql, { database: 'PostgreSQL' }) as AstNode | AstNode[];
      const stmt = Array.isArray(ast) ? ast[0] : ast;
      if (!stmt || stmt['type'] !== 'select') {
        return { columns: [], tableRefs: [], success: false };
      }

      // CTEs first — the outer SELECT usually reads from them, not from real tables.
      const cteMap = this.buildCteMap(stmt);
      const aliasMap = this.buildAliasMap(stmt['from']);

      // Real (non-CTE) tables: outer FROM plus every table any CTE reaches.
      const allTables = new Set<string>();
      for (const t of this.extractTableRefs(stmt)) {
        const cte = cteMap.get(t);
        if (cte) cte.tables.forEach((x) => allTables.add(x));
        else allTables.add(t);
      }

      const columns = this.extractColumns(stmt).map((c) => ({
        name: c.name,
        sourceRefs: this.resolveRefs(c.sourceRefs, aliasMap, cteMap),
        transformationType: this.liftType(c, aliasMap, cteMap),
        // Prefer the CTE's own expression when the outer select just reads it
        // through — `coalesce(payments.amount, 0)` is less informative than `SUM(amount)`.
        expression: this.liftExpr(c, aliasMap, cteMap),
      }));

      return { columns, tableRefs: [...allTables], success: true };
    } catch {
      return { columns: [], tableRefs: [], success: false };
    }
  }

  /** Maps each CTE name to its resolved output columns and the real tables it reads. */
  private buildCteMap(stmt: AstNode): Map<string, CteInfo> {
    const map = new Map<string, CteInfo>();
    const withs = stmt['with'];
    if (!Array.isArray(withs)) return map;

    // Process in declaration order so a CTE can reference earlier ones.
    for (const cte of withs) {
      const name = identName(cte?.['name'])?.toLowerCase();
      const innerRaw = cte?.['stmt'];
      if (!name || !innerRaw || typeof innerRaw !== 'object') continue;
      const inner: AstNode = (innerRaw as AstNode)['ast'] ?? innerRaw;

      const innerAlias = this.buildAliasMap(inner['from']);
      const cols = new Map<string, { refs: Ref[]; type: TransformationType; expr: string | null }>();
      for (const c of this.extractColumns(inner)) {
        cols.set(c.name, {
          refs: this.resolveRefs(c.sourceRefs, innerAlias, map),
          type: this.liftType(c, innerAlias, map),
          expr: c.expression,
        });
      }

      // Flatten this CTE's sources through any CTEs it reads from.
      const tables = new Set<string>();
      for (const t of this.extractTableRefs(inner)) {
        const nested = map.get(t);
        if (nested) nested.tables.forEach((x) => tables.add(x));
        else tables.add(t);
      }

      map.set(name, { cols, tables: [...tables], hasStar: this.hasStar(inner) });
    }
    return map;
  }

  private hasStar(stmt: AstNode): boolean {
    const cols = stmt['columns'];
    if (cols === '*') return true;
    if (!Array.isArray(cols)) return false;
    return cols.some((c) => {
      const e = c?.['expr'];
      return !!e && (e['type'] === 'star' || identName(e['column']) === '*');
    });
  }

  /** alias → real table name (also maps each table to itself). */
  private buildAliasMap(from: unknown): Map<string, string> {
    const map = new Map<string, string>();
    if (!Array.isArray(from)) return map;
    for (const f of from) {
      if (!f || typeof f !== 'object') continue;
      const tbl = identName((f as AstNode)['table']);
      if (!tbl) continue;
      const lower = tbl.toLowerCase();
      const as = identName((f as AstNode)['as']);
      if (as) map.set(as.toLowerCase(), lower);
      map.set(lower, lower);
    }
    return map;
  }

  /** Rewrites refs that point at a CTE or alias into refs on real tables. */
  private resolveRefs(
    refs: Ref[],
    aliasMap: Map<string, string>,
    cteMap: Map<string, CteInfo>,
    depth = 0,
  ): Ref[] {
    if (depth > 5) return [];
    const out: Ref[] = [];

    for (const ref of refs) {
      let tbl = ref.table ? (aliasMap.get(ref.table) ?? ref.table) : null;

      // Unqualified column with exactly one source in scope — attribute it to that
      // source (a CTE gets read through below; a real table is used directly).
      // With multiple sources it stays ambiguous and is left unqualified.
      if (!tbl) {
        const uniq = [...new Set(aliasMap.values())];
        if (uniq.length === 1) tbl = uniq[0];
      }

      const cte = tbl ? cteMap.get(tbl) : undefined;
      if (cte) {
        const col = cte.cols.get(ref.column);
        if (col) { out.push(...col.refs); continue; }
        // `select *` CTE over a single table passes columns straight through.
        if (cte.hasStar && cte.tables.length === 1) {
          out.push({ table: cte.tables[0], column: ref.column });
        }
        continue;
      }

      out.push({ table: tbl, column: ref.column });
    }
    return out;
  }

  /**
   * A column that reads a CTE column inherits that CTE column's transform type when
   * it is stronger — e.g. `coalesce(orders.lifetime_value, 0)` over `sum(amount)`
   * is an aggregate, not merely a transform.
   */
  private liftType(
    col: ParsedColumn,
    aliasMap: Map<string, string>,
    cteMap: Map<string, CteInfo>,
  ): TransformationType {
    let type = col.transformationType;
    for (const ref of col.sourceRefs) {
      const tbl = ref.table ? (aliasMap.get(ref.table) ?? ref.table) : null;
      const inherited = tbl ? cteMap.get(tbl)?.cols.get(ref.column)?.type : undefined;
      if (inherited && TYPE_RANK[inherited] > TYPE_RANK[type]) type = inherited;
    }
    return type;
  }

  /** Surfaces the CTE's defining expression when it is the more informative one. */
  private liftExpr(
    col: ParsedColumn,
    aliasMap: Map<string, string>,
    cteMap: Map<string, CteInfo>,
  ): string | null {
    for (const ref of col.sourceRefs) {
      const tbl = ref.table ? (aliasMap.get(ref.table) ?? ref.table) : null;
      const inner = tbl ? cteMap.get(tbl)?.cols.get(ref.column) : undefined;
      if (inner?.expr && TYPE_RANK[inner.type] > TYPE_RANK[col.transformationType]) {
        return inner.expr;
      }
    }
    return col.expression;
  }

  private extractTableRefs(stmt: AstNode): string[] {
    const refs: string[] = [];
    const walk = (node: unknown): void => {
      if (!node || typeof node !== 'object') return;
      const n = node as AstNode;
      if (n['type'] === 'table' || n['table'] !== undefined) {
        const name = identName(n['table']) ?? identName(n['name']);
        if (name) refs.push(name.toLowerCase());
      }
      for (const val of Object.values(n)) {
        if (Array.isArray(val)) val.forEach(walk);
        else if (val && typeof val === 'object') walk(val);
      }
    };
    walk(stmt['from']);
    return [...new Set(refs)];
  }

  private extractColumns(stmt: AstNode): ParsedColumn[] {
    const columns: ParsedColumn[] = stmt['columns'];
    if (!Array.isArray(columns)) return [];

    return columns
      .map((col) => this.parseSelectColumn(col))
      .filter((c): c is ParsedColumn => c !== null);
  }

  private parseSelectColumn(col: AstNode): ParsedColumn | null {
    const alias: string | null = col['as'] ?? null;
    const expr: AstNode | null = col['expr'] ?? null;
    if (!expr) return null;

    // SELECT *  or  table.*
    if (identName(expr['column']) === '*' || expr['type'] === 'star') return null;

    const outputName = alias ?? this.inferOutputName(expr);
    if (!outputName) return null;

    const sourceRefs = this.collectRefs(expr);
    const transformationType = this.classifyExpr(expr, alias);

    return {
      name: outputName.toLowerCase(),
      sourceRefs,
      transformationType,
      expression: printExpr(expr),
    };
  }

  private inferOutputName(expr: AstNode): string | null {
    if (expr['type'] === 'column_ref') return identName(expr['column'])?.toLowerCase() || null;
    return null;
  }

  private collectRefs(node: unknown): Array<{ table: string | null; column: string }> {
    const refs: Array<{ table: string | null; column: string }> = [];
    const walk = (n: unknown): void => {
      if (!n || typeof n !== 'object') return;
      const obj = n as AstNode;
      if (obj['type'] === 'column_ref') {
        const colName = identName(obj['column']);
        if (colName && colName !== '*') {
          const tbl = identName(obj['table']);
          refs.push({
            table: tbl ? tbl.toLowerCase() : null,
            column: colName.toLowerCase(),
          });
        }
        return;
      }
      for (const val of Object.values(obj)) {
        if (Array.isArray(val)) val.forEach(walk);
        else if (val && typeof val === 'object') walk(val);
      }
    };
    walk(node);
    return refs;
  }

  private classifyExpr(expr: AstNode, alias: string | null): TransformationType {
    // Aggregate function at top level
    if (expr['type'] === 'aggr_func') return 'aggregate';

    // Nested aggregate anywhere
    if (this.containsAggregate(expr)) return 'aggregate';

    // Pure column ref
    if (expr['type'] === 'column_ref') {
      const src = identName(expr['column']);
      return alias && src && alias.toLowerCase() !== src.toLowerCase() ? 'rename' : 'passthrough';
    }

    // Binary expressions, functions, CASE → transform
    return 'transform';
  }

  private containsAggregate(node: unknown): boolean {
    if (!node || typeof node !== 'object') return false;
    const obj = node as AstNode;
    if (obj['type'] === 'aggr_func') return true;
    if (obj['type'] === 'function') {
      const name = String(obj['name'] ?? '').toLowerCase();
      if (AGG_FUNCS.has(name)) return true;
    }
    return Object.values(obj).some((v) =>
      Array.isArray(v) ? v.some(this.containsAggregate.bind(this)) : this.containsAggregate(v),
    );
  }

  // ── Regex fallback ───────────────────────────────────────────────────────────

  private parseWithRegex(sql: string): SqlParseResult {
    const selectBody = this.extractSelectBody(sql);
    if (!selectBody) return { columns: [], tableRefs: [], success: false };

    const tableRefs = this.regexTableRefs(sql);
    const rawCols = this.splitColumns(selectBody);
    const columns: ParsedColumn[] = [];

    for (const raw of rawCols) {
      const col = this.parseRegexColumn(raw.trim(), tableRefs);
      if (col) columns.push(col);
    }

    return { columns, tableRefs, success: columns.length > 0 };
  }

  private extractSelectBody(sql: string): string | null {
    const upper = sql.toUpperCase();
    const selectIdx = upper.search(/\bSELECT\b/);
    const fromIdx = upper.search(/\bFROM\b/);
    if (selectIdx === -1 || fromIdx === -1 || fromIdx <= selectIdx) return null;
    return sql.slice(selectIdx + 6, fromIdx);
  }

  private regexTableRefs(sql: string): string[] {
    const refs: string[] = [];
    const pattern = /\bFROM\s+(\w+)|\bJOIN\s+(\w+)/gi;
    let m: RegExpExecArray | null;
    while ((m = pattern.exec(sql)) !== null) {
      refs.push((m[1] ?? m[2]).toLowerCase());
    }
    return refs;
  }

  private splitColumns(selectBody: string): string[] {
    const parts: string[] = [];
    let depth = 0;
    let current = '';
    for (const ch of selectBody) {
      if (ch === '(') depth++;
      else if (ch === ')') depth--;
      else if (ch === ',' && depth === 0) {
        if (current.trim()) parts.push(current.trim());
        current = '';
        continue;
      }
      current += ch;
    }
    if (current.trim()) parts.push(current.trim());
    return parts;
  }

  private parseRegexColumn(raw: string, _tableRefs: string[]): ParsedColumn | null {
    if (raw === '*' || raw.endsWith('.*')) return null;

    const aggPattern = new RegExp(`\\b(${[...AGG_FUNCS].join('|')})\\s*\\(`, 'i');
    const hasAgg = aggPattern.test(raw);

    // Extract alias: "expr AS alias" or just "alias" at end
    const asMatch = raw.match(/\bAS\s+(\w+)\s*$/i);
    const alias = asMatch ? asMatch[1].toLowerCase() : null;

    // Simple column ref: maybe "table.col" or just "col"
    const colMatch = raw.match(/^(\w+)\.(\w+)$/) ?? raw.match(/^(\w+)$/);
    const outputName = alias ?? (colMatch ? colMatch[colMatch.length - 1].toLowerCase() : null);
    if (!outputName || SQL_KEYWORDS.has(outputName)) return null;

    const refs: Array<{ table: string | null; column: string }> = [];
    const tableColPattern = /\b(\w+)\.(\w+)\b/g;
    let m: RegExpExecArray | null;
    while ((m = tableColPattern.exec(raw)) !== null) {
      if (!SQL_KEYWORDS.has(m[2].toLowerCase()) && !AGG_FUNCS.has(m[1].toLowerCase())) {
        refs.push({ table: m[1].toLowerCase(), column: m[2].toLowerCase() });
      }
    }

    let transformationType: TransformationType = hasAgg
      ? 'aggregate'
      : refs.length === 0
        ? 'transform'
        : alias && refs.length === 1 && refs[0].column === alias
          ? 'rename'
          : alias
            ? 'rename'
            : 'passthrough';

    // Detect complex expressions that make it a real transform
    if (!hasAgg && raw.match(/\bCASE\b|\bCOALESCE\b|\bCAST\b|\bIF\b|\bIFF\b/i)) {
      transformationType = 'transform';
    }

    return { name: outputName, sourceRefs: refs, transformationType, expression: raw };
  }
}
