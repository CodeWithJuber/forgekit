// Existing consumers may supply their own token filters. Unicode segmentation keeps
// ordinary word and adjacent-word matching available in every writing system.
export const INTENT_STOP = new Set();
export function intentGrams(text, stop = INTENT_STOP) {
  const tokens = (
    String(text)
      .normalize("NFKC")
      .toLowerCase()
      .match(/[\p{L}\p{M}\p{N}]+/gu) ?? []
  ).filter((word) => !stop.has(word));
  return new Set([...tokens, ...tokens.slice(1).map((word, i) => `${tokens[i]} ${word}`)]);
}
