// Copied from VORO's apps/web/src/lib/canvasTheme.ts — single source of truth for layer colors.

export interface LayerColor {
  border: string;
  bgDark: string;
  bgLight: string;
}

export const LAYER_COLORS: Record<string, LayerColor> = {
  source:       { border: '#3b82f6', bgDark: '#172554', bgLight: '#dbeafe' },
  src:          { border: '#3b82f6', bgDark: '#172554', bgLight: '#dbeafe' },
  raw:          { border: '#6b7280', bgDark: '#1f2937', bgLight: '#f3f4f6' },
  core:         { border: '#7c3aed', bgDark: '#2e1065', bgLight: '#ede9fe' },
  analytics:    { border: '#10b981', bgDark: '#022c22', bgLight: '#d1fae5' },
  analytic:     { border: '#10b981', bgDark: '#022c22', bgLight: '#d1fae5' },
  mart:         { border: '#f59e0b', bgDark: '#451a03', bgLight: '#fef3c7' },
  marts:        { border: '#f59e0b', bgDark: '#451a03', bgLight: '#fef3c7' },
  staging:      { border: '#06b6d4', bgDark: '#083344', bgLight: '#cffafe' },
  stg:          { border: '#06b6d4', bgDark: '#083344', bgLight: '#cffafe' },
  intermediate: { border: '#f97316', bgDark: '#431407', bgLight: '#ffedd5' },
  int:          { border: '#f97316', bgDark: '#431407', bgLight: '#ffedd5' },
  fact:         { border: '#ef4444', bgDark: '#450a0a', bgLight: '#fee2e2' },
  fct:          { border: '#ef4444', bgDark: '#450a0a', bgLight: '#fee2e2' },
  dimension:    { border: '#ec4899', bgDark: '#500724', bgLight: '#fce7f3' },
  dim:          { border: '#ec4899', bgDark: '#500724', bgLight: '#fce7f3' },
  model:        { border: '#71717a', bgDark: '#18181b', bgLight: '#f4f4f5' },
};

export const LAYER_FALLBACK: LayerColor = {
  border: '#71717a', bgDark: '#18181b', bgLight: '#f4f4f5',
};

/**
 * Many dbt projects prefix layer folders to force an ordering — `00_RAW`,
 * `10_SOURCE`, `30_ANALYTIC`. Strip that prefix (and any trailing plural) before
 * lookup, otherwise every such model silently falls back to gray.
 */
function normalizeLayer(layer: string): string {
  return (layer ?? '')
    .toLowerCase()
    .replace(/^[0-9]+[_\-.]*/, '')
    .replace(/[_-]?layer$/, '')
    .trim();
}

export function getLC(layer: string): LayerColor {
  const key = normalizeLayer(layer);
  return LAYER_COLORS[key] ?? LAYER_COLORS[key.replace(/s$/, '')] ?? LAYER_FALLBACK;
}
