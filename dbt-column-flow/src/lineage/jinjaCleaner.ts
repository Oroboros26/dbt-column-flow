export interface RefMapping {
  placeholder: string;
  modelName: string;
}

export interface JinjaCleanResult {
  cleanedSql: string;
  refMappings: RefMapping[];
}

/**
 * Strips Jinja from dbt SQL so node-sql-parser can handle it.
 *
 * ref('model')   → __ref__model    (identifier, tracked in refMappings)
 * source('s','t')→ __source__s__t  (identifier, tracked in refMappings)
 * config(...)    → removed
 * {% ... %}      → removed
 * {{ other }}    → __jinja__
 */
export function cleanJinja(rawSql: string): JinjaCleanResult {
  let sql = rawSql;
  const refMappings: RefMapping[] = [];

  // Remove {# comments #}
  sql = sql.replace(/\{#[\s\S]*?#\}/g, '');

  // Remove {{ config(...) }}
  sql = sql.replace(/\{\{\s*config\s*\([\s\S]*?\)\s*\}\}/g, '');

  // {{ ref('model') }} → __ref__model
  sql = sql.replace(
    /\{\{\s*ref\s*\(\s*['"](\w+)['"]\s*\)\s*\}\}/g,
    (_m, model: string) => {
      const placeholder = `__ref__${model}`;
      refMappings.push({ placeholder, modelName: model });
      return placeholder;
    },
  );

  // {{ ref('pkg', 'model') }} → __ref__pkg__model
  sql = sql.replace(
    /\{\{\s*ref\s*\(\s*['"](\w+)['"]\s*,\s*['"](\w+)['"]\s*\)\s*\}\}/g,
    (_m, pkg: string, model: string) => {
      const placeholder = `__ref__${pkg}__${model}`;
      refMappings.push({ placeholder, modelName: model });
      return placeholder;
    },
  );

  // {{ source('src', 'table') }} → __source__src__table
  sql = sql.replace(
    /\{\{\s*source\s*\(\s*['"](\w+)['"]\s*,\s*['"](\w+)['"]\s*\)\s*\}\}/g,
    (_m, src: string, table: string) => {
      const placeholder = `__source__${src}__${table}`;
      refMappings.push({ placeholder, modelName: table });
      return placeholder;
    },
  );

  // Remove {% block tags %}
  sql = sql.replace(/\{%-?\s*[\s\S]*?-?%\}/g, '');

  // Replace remaining {{ expr }} with a safe placeholder
  sql = sql.replace(/\{\{[\s\S]*?\}\}/g, '__jinja__');

  return { cleanedSql: sql.trim(), refMappings };
}
