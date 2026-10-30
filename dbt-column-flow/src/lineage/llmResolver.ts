/**
 * Optional AI fallback for column edges the SQL parser could not resolve.
 *
 * Deliberately provider-agnostic: the user supplies a base URL, an API
 * "shape" (openai, anthropic, or azure), and a model name of their choice.
 * 'openai' covers OpenAI itself plus OpenRouter, Groq, Mistral, DeepSeek,
 * Together, Ollama, LM Studio, and most self-hosted servers. 'azure' covers
 * Azure AI Foundry model-catalog/serverless deployments specifically (see
 * callAzureFoundry below) — not classic *.openai.azure.com resources, which
 * use a different auth header and URL shape and aren't implemented. Nothing
 * here is called unless the user explicitly enables it and clicks
 * "Resolve with AI" on a specific edge.
 */

import type { AiEdgeQuery, AiEdgeResult, TransformationType } from './graphTypes';

export type ApiFormat = 'openai' | 'anthropic' | 'azure';

export interface AiConfig {
  baseUrl: string;
  apiFormat: ApiFormat;
  model: string;
  apiKey: string;
  /** Only used when apiFormat === 'azure' (Azure AI Foundry model-catalog endpoints). */
  azureApiVersion: string;
}

const VALID_TRANSFORMS: TransformationType[] = ['passthrough', 'rename', 'transform', 'aggregate'];

function buildPrompt(q: AiEdgeQuery, targetSql: string | null): string {
  const sqlBlock = targetSql
    ? `SQL of "${q.targetModel}" (${q.dialect ?? 'unknown dialect'}):\n${targetSql.slice(0, 6000)}`
    : `SQL for "${q.targetModel}" was not available.`;

  return [
    'You are analyzing dbt column lineage. dbt knows these two models are connected,',
    'but the SQL parser could not resolve whether a specific column maps between them.',
    '',
    `Candidate source column: ${q.sourceModel}.${q.sourceColumn} (type: ${q.sourceType ?? 'unknown'})`,
    `Candidate target column: ${q.targetModel}.${q.targetColumn} (type: ${q.targetType ?? 'unknown'})`,
    '',
    sqlBlock,
    '',
    `Does "${q.sourceColumn}" from "${q.sourceModel}" actually feed "${q.targetColumn}" in "${q.targetModel}"?`,
    'Reply with ONLY a JSON object, no prose, no markdown fences:',
    '{"matches": boolean, "transformType": "passthrough"|"rename"|"transform"|"aggregate"|null, "confidence": "high"|"medium"|"low", "note": "one short sentence"}',
  ].join('\n');
}

function extractJson(text: string): unknown {
  const start = text.indexOf('{');
  const end = text.lastIndexOf('}');
  if (start === -1 || end === -1 || end < start) throw new Error('Model reply did not contain a JSON object.');
  return JSON.parse(text.slice(start, end + 1));
}

function toResult(raw: unknown): AiEdgeResult {
  if (typeof raw !== 'object' || raw === null) throw new Error('Model reply was not a JSON object.');
  const r = raw as Record<string, unknown>;
  const transformType = VALID_TRANSFORMS.includes(r.transformType as TransformationType)
    ? (r.transformType as TransformationType)
    : null;
  const confidence = r.confidence === 'high' || r.confidence === 'medium' || r.confidence === 'low'
    ? r.confidence
    : 'low';
  return {
    matches: r.matches === true,
    transformType,
    confidence,
    note: typeof r.note === 'string' ? r.note.slice(0, 300) : '',
  };
}

/** Shared by 'openai' and 'azure' — both return the same choices[0].message.content shape. */
async function postChatCompletions(
  url: string, headers: Record<string, string>, cfg: AiConfig, prompt: string, signal: AbortSignal,
): Promise<string> {
  const res = await fetch(url, {
    method: 'POST',
    signal,
    headers: { 'content-type': 'application/json', ...headers },
    body: JSON.stringify({
      model: cfg.model,
      messages: [{ role: 'user', content: prompt }],
      temperature: 0,
    }),
  });
  if (!res.ok) throw new Error(`${res.status} ${res.statusText}: ${(await res.text()).slice(0, 300)}`);
  const data = (await res.json()) as { choices?: { message?: { content?: string } }[] };
  const content = data.choices?.[0]?.message?.content;
  if (!content) throw new Error('No content in model response.');
  return content;
}

async function callOpenAiCompatible(cfg: AiConfig, prompt: string, signal: AbortSignal): Promise<string> {
  const url = cfg.baseUrl.replace(/\/+$/, '') + '/chat/completions';
  return postChatCompletions(url, { authorization: `Bearer ${cfg.apiKey}` }, cfg, prompt, signal);
}

/**
 * Azure AI Foundry model-catalog / serverless ("Models-as-a-Service") deployments —
 * the Azure AI Model Inference API. Same request/response body shape as OpenAI's
 * chat completions, but a different path and a required api-version query param.
 * Not the same as a classic *.openai.azure.com resource (which uses an 'api-key'
 * header and a /openai/deployments/<name>/... path) — that shape isn't implemented.
 */
async function callAzureFoundry(cfg: AiConfig, prompt: string, signal: AbortSignal): Promise<string> {
  const base = cfg.baseUrl.replace(/\/+$/, '');
  const url = `${base}/models/chat/completions?api-version=${encodeURIComponent(cfg.azureApiVersion)}`;
  return postChatCompletions(url, { authorization: `Bearer ${cfg.apiKey}` }, cfg, prompt, signal);
}

async function callAnthropic(cfg: AiConfig, prompt: string, signal: AbortSignal): Promise<string> {
  const url = cfg.baseUrl.replace(/\/+$/, '') + '/v1/messages';
  const res = await fetch(url, {
    method: 'POST',
    signal,
    headers: {
      'content-type': 'application/json',
      'x-api-key': cfg.apiKey,
      'anthropic-version': '2023-06-01',
    },
    body: JSON.stringify({
      model: cfg.model,
      max_tokens: 300,
      messages: [{ role: 'user', content: prompt }],
    }),
  });
  if (!res.ok) throw new Error(`${res.status} ${res.statusText}: ${(await res.text()).slice(0, 300)}`);
  const data = (await res.json()) as { content?: { type: string; text?: string }[] };
  const content = data.content?.find((b) => b.type === 'text')?.text;
  if (!content) throw new Error('No content in model response.');
  return content;
}

export async function resolveEdgeWithAI(cfg: AiConfig, query: AiEdgeQuery, targetSql: string | null): Promise<AiEdgeResult> {
  const prompt = buildPrompt(query, targetSql);
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 20_000);
  try {
    const text = cfg.apiFormat === 'anthropic' ? await callAnthropic(cfg, prompt, controller.signal)
      : cfg.apiFormat === 'azure' ? await callAzureFoundry(cfg, prompt, controller.signal)
      : await callOpenAiCompatible(cfg, prompt, controller.signal);
    return toResult(extractJson(text));
  } finally {
    clearTimeout(timeout);
  }
}
