// Shared frontend constants.

// The only models offered in Simple view. Complex view keeps the full model
// list. Kept as bare model ids (no effort suffix) — matched by prefix so a
// selected value like "claude-sonnet-4-5:medium" still counts as whitelisted.
export const SIMPLE_MODELS = ['claude-sonnet-4-5', 'gemini-3.5-flash'];
