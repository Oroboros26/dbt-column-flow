import * as fs from 'fs/promises';

export interface CatalogColumn {
  name: string;
  type: string;
}

export interface ParsedCatalog {
  // unique_id → columns
  tables: Record<string, CatalogColumn[]>;
}

export class CatalogParser {
  async parse(catalogPath: string): Promise<ParsedCatalog | null> {
    try {
      const raw = await fs.readFile(catalogPath, 'utf-8');
      const json = JSON.parse(raw) as Record<string, unknown>;
      return this.transform(json);
    } catch {
      return null;
    }
  }

  private transform(json: Record<string, unknown>): ParsedCatalog {
    const tables: Record<string, CatalogColumn[]> = {};

    const processSection = (section: unknown): void => {
      if (!section || typeof section !== 'object') return;
      for (const [id, node] of Object.entries(section as Record<string, unknown>)) {
        const n = node as Record<string, unknown>;
        const rawCols = (n['columns'] ?? {}) as Record<string, unknown>;
        tables[id] = Object.values(rawCols).map((c) => {
          const col = c as Record<string, unknown>;
          return {
            name: String(col['name'] ?? '').toLowerCase(),
            type: String(col['type'] ?? ''),
          };
        });
      }
    };

    processSection(json['nodes']);
    processSection(json['sources']);
    return { tables };
  }
}
