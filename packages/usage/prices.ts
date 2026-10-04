/**
 * Estimated list prices per model, in US dollars per million tokens. **These are estimates**, used only to put a rough dollar
 * figure beside token counts in the Usage view: they are first-party API list prices as Kiln last recorded them (see
 * `pricesChecked`), not what anyone was billed. Claude Code and Codex on a subscription (Pro, Max, Plus, Team…) pay a flat fee,
 * so for them the figure is what the same tokens would have cost on the API, not money spent.
 *
 * Edit this table to change the defaults for everyone; the Usage view also lets each user override a row on their machine
 * (saved machine-private next to the usage cache, see service.ts). A model with no row here and no override has no estimate.
 *
 * `cacheWrite` is Anthropic's 5-minute cache write (1.25 × input), `cacheWrite1h` the 1-hour write (2 × input), `cached` a cache
 * read. OpenAI models have no separate write price; their rows leave the write columns equal to input.
 */
export type Price = { input: number; cached: number; cacheWrite: number; cacheWrite1h: number; output: number };
export type PriceTable = Record<string, Price>;
export const pricesChecked = '2026-09-30';

const anthropic = (input: number, output: number, cached = input / 10): Price => ({ input, cached, cacheWrite: input * 1.25, cacheWrite1h: input * 2, output });
/**
 * Keys are model-id prefixes, matched longest first after `normaliseModel` (so `claude-opus-4` covers every Opus 4.x without its
 * own row). OpenAI's Codex models are left out: their prices were not verified when this table was written, so add a row (or an
 * override in the app) to see an estimate for them.
 */
export const defaultPrices: PriceTable = {
  'claude-fable-5-1': anthropic(10, 50, 0.25),
  'claude-fable-5': anthropic(10, 50),
  'claude-mythos-5': anthropic(10, 50),
  'claude-opus-5-5': anthropic(4, 20, 0.2),
  'claude-opus-5': anthropic(5, 25),
  'claude-opus-4-8': anthropic(5, 25),
  'claude-opus-4-7': anthropic(5, 25),
  'claude-opus-4-6': anthropic(5, 25),
  'claude-sonnet-5': anthropic(2, 10),
  'claude-sonnet-4': anthropic(3, 15),
  'claude-haiku-4-5': anthropic(1, 5),
};

/** `claude-opus-5-5[1m]`, `anthropic.claude-opus-5-5`, `claude-opus-4-8-20260101` and `models/claude-…` all read as the bare id. */
export function normaliseModel(model: string) {
  return model.trim().toLowerCase().replace(/\[[^\]]*\]$/, '').replace(/^(?:anthropic\.|models\/|us\.anthropic\.|eu\.anthropic\.)/, '').replace(/-\d{8}$/, '').replace(/@.*$/, '');
}
/** The row that prices `model`: the longest key that is the whole id or a `-`-separated prefix of it. */
export function priceFor(model: string, table: PriceTable): { key: string; price: Price } | null {
  const id = normaliseModel(model);
  const key = Object.keys(table).filter(k => id === k || id.startsWith(k + '-')).sort((a, b) => b.length - a.length)[0];
  return key ? { key, price: table[key] } : null;
}
/** Token counts in one place. `reasoning` is part of `output` (both vendors bill it as output); it is shown, never priced twice. */
export type TokenCounts = { input: number; cached: number; cacheWrite: number; cacheWrite1h: number; output: number; reasoning: number };
export const noTokens = (): TokenCounts => ({ input: 0, cached: 0, cacheWrite: 0, cacheWrite1h: 0, output: 0, reasoning: 0 });
export function addTokens(into: TokenCounts, value: Partial<TokenCounts>, scale = 1) {
  for (const key of Object.keys(into) as (keyof TokenCounts)[]) into[key] += (value[key] ?? 0) * scale;
  return into;
}
export const totalTokens = (t: TokenCounts) => t.input + t.cached + t.cacheWrite + t.cacheWrite1h + t.output;
/** Estimated dollars for `tokens` on `model`, or null when the table has no price for it. */
export function estimateCost(model: string, tokens: TokenCounts, table: PriceTable) { return costAt(priceFor(model, table)?.price, tokens); }
/** `estimateCost` at a price already looked up (the report looks each model up once); null without a price. */
export function costAt(p: Price | undefined, tokens: TokenCounts) {
  if (!p) return null;
  return (tokens.input * p.input + tokens.cached * p.cached + tokens.cacheWrite * p.cacheWrite + tokens.cacheWrite1h * p.cacheWrite1h + tokens.output * p.output) / 1_000_000;
}
