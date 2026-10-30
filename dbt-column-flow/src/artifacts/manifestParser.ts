import * as fs from 'fs/promises';

export interface ManifestColumn {
  name: string;
  description: string;
  dataType: string;
}

export interface ManifestNode {
  uniqueId: string;
  name: string;
  resourceType: 'model' | 'source' | 'seed' | 'snapshot' | 'test' | 'analysis';
  originalFilePath: string;
  rawSql: string;              // raw Jinja SQL
  dependsOnNodes: string[];    // upstream unique_ids
  columns: ManifestColumn[];
  database: string;
  schema: string;
  materialization: string;
  description: string;
  fqn: string[];
}

export interface ParsedManifest {
  nodes: ManifestNode[];
  dbtVersion: string;
  projectName: string;
  /** dbt adapter the project targets: snowflake, bigquery, databricks, postgres… */
  adapterType: string;
}

// Handles dbt manifest schema versions 6–12 (dbt 1.0–1.9)
export class ManifestParser {
  async parse(manifestPath: string): Promise<ParsedManifest | null> {
    try {
      const raw = await fs.readFile(manifestPath, 'utf-8');
      const json = JSON.parse(raw);
      return this.transform(json);
    } catch {
      return null;
    }
  }

  private transform(json: Record<string, unknown>): ParsedManifest {
    const meta = (json['metadata'] as Record<string, unknown>) ?? {};
    const dbtVersion = String(meta['dbt_version'] ?? 'unknown');
    const projectName = String(meta['project_name'] ?? 'unknown');
    const adapterType = String(meta['adapter_type'] ?? '').toLowerCase();

    const rawNodes = (json['nodes'] ?? {}) as Record<string, unknown>;
    const rawSources = (json['sources'] ?? {}) as Record<string, unknown>;

    const nodes: ManifestNode[] = [
      ...Object.values(rawNodes).map((n) => this.parseNode(n as Record<string, unknown>)),
      ...Object.values(rawSources).map((n) => this.parseNode(n as Record<string, unknown>)),
    ].filter((n): n is ManifestNode => n !== null);

    return { nodes, dbtVersion, projectName, adapterType };
  }

  private parseNode(raw: Record<string, unknown>): ManifestNode | null {
    const resourceType = String(raw['resource_type'] ?? '') as ManifestNode['resourceType'];
    if (!['model', 'source', 'seed', 'snapshot'].includes(resourceType)) return null;

    const dependsOn = raw['depends_on'] as Record<string, unknown> | undefined;
    const dependsOnNodes = (dependsOn?.['nodes'] as string[] | undefined) ?? [];

    // dbt 1.3+ uses raw_code/compiled_code; older uses raw_sql/compiled_sql
    const rawSql = String(
      raw['raw_code'] ?? raw['raw_sql'] ?? raw['compiled_code'] ?? raw['compiled_sql'] ?? '',
    );

    const rawCols = (raw['columns'] ?? {}) as Record<string, unknown>;
    const columns: ManifestColumn[] = Object.values(rawCols).map((c) => {
      const col = c as Record<string, unknown>;
      return {
        name: String(col['name'] ?? '').toLowerCase(),
        description: String(col['description'] ?? ''),
        dataType: String(col['data_type'] ?? col['dtype'] ?? ''),
      };
    });

    const config = (raw['config'] ?? {}) as Record<string, unknown>;
    const materialization = String(
      config['materialized'] ?? raw['materialized'] ?? 'view',
    );

    const fqn = (raw['fqn'] as string[] | undefined) ?? [String(raw['name'] ?? '')];

    return {
      uniqueId: String(raw['unique_id'] ?? ''),
      name: String(raw['name'] ?? ''),
      resourceType,
      originalFilePath: String(raw['original_file_path'] ?? ''),
      rawSql,
      dependsOnNodes,
      columns,
      database: String(raw['database'] ?? ''),
      schema: String(raw['schema'] ?? ''),
      materialization,
      description: String(raw['description'] ?? ''),
      fqn,
    };
  }
}
