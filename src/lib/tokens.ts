/**
 * Rough token counting, for budgeting prompt sections without a tokenizer.
 *
 * Every real tokenizer is model-specific and ships megabytes of vocabulary;
 * this app talks to whatever local model the user has installed, so there is
 * no single correct answer and no dependency worth adding for one. What
 * matters is that a budget is not wildly wrong for the text it is given.
 *
 * Counting characters instead — the previous approach — is fine for English
 * and badly wrong elsewhere. Latin script averages ~4 characters per token,
 * but CJK is close to one token *per character*, so a 6,000-character budget
 * is ~1,500 tokens of English and ~6,000 of Chinese. On a local model that
 * silently truncates an over-long prompt, that difference costs the user
 * their conversation rather than their memories.
 */

/**
 * Scripts where a character is worth roughly a whole token: CJK ideographs
 * and their extension A, kana, Hangul, CJK punctuation, and full-width forms.
 */
const DENSE_SCRIPT =
  /[\u3000-\u303f\u3040-\u30ff\u3400-\u4dbf\u4e00-\u9fff\uac00-\ud7af\uff00-\uffef]/gu;

/** Characters per token for everything else, the usual English approximation. */
const CHARS_PER_TOKEN = 4;

/**
 * Estimate the tokens `text` will cost.
 *
 * Deliberately rounds up: a budget that overshoots trims one fact too many,
 * while one that undershoots overruns the context window.
 */
export function estimateTokens(text: string): number {
  if (text === "") {
    return 0;
  }
  const dense = text.match(DENSE_SCRIPT)?.length ?? 0;
  const rest = text.length - dense;
  return dense + Math.ceil(rest / CHARS_PER_TOKEN);
}
