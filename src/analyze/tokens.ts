// Tokenizer abstraction for `tokenomy analyze`.
//
// Two strategies:
//   - "heuristic"  — zero-dep. Word/punctuation/number splitter calibrated
//                    against cl100k_base for English code+JSON. ±10% on
//                    typical tool responses.
//   - "tiktoken"   — dynamic import of js-tiktoken if the user has it
//                    installed (peer-optional). Gives real cl100k counts,
//                    a solid Claude-token approximation (Anthropic does
//                    not publish Claude 4's BPE).
//
// The default is "auto": try tiktoken, fall back to heuristic on failure.

export interface Tokenizer {
  name: "heuristic" | "tiktoken-cl100k";
  approximate: boolean;
  count(text: string): number;
}

const SPLIT_RE = /[A-Za-z]+|\d+|[\p{P}\p{S}]|\s+/gu;

// Heuristic: split into word/number/punct/ws runs, then weight each run by a
// factor reflecting how cl100k typically chunks it. This catches the two
// dominant effects that make bytes/4 wrong:
//   (1) long runs of ASCII text → sub-word pieces, ~4 chars / token.
//   (2) JSON / code → lots of punctuation, 1 char / token each.
export const heuristicCount = (text: string): number => {
  if (!text) return 0;
  let tokens = 0;
  const matches = text.match(SPLIT_RE);
  if (!matches) return Math.max(1, Math.ceil(text.length / 4));
  for (const run of matches) {
    const len = run.length;
    const first = run.charCodeAt(0);
    // Punctuation / symbols: cl100k typically merges them with adjacent
    // word pieces; count 1 token per char but cap at ~half of length.
    if (/[\p{P}\p{S}]/u.test(run)) {
      tokens += Math.max(1, Math.ceil(len / 2));
      continue;
    }
    // Whitespace: inter-word spaces merge into adjacent word pieces (0
    // tokens); newlines break tokens (1 extra token per newline).
    if (/\s/u.test(run)) {
      const nl = (run.match(/\n/g) ?? []).length;
      tokens += nl;
      continue;
    }
    // Digits: ~3 chars per BPE piece.
    // Letters: ~4 chars per BPE piece on average.
    if (first >= 48 && first <= 57) {
      tokens += Math.max(1, Math.ceil(len / 3));
    } else {
      tokens += Math.max(1, Math.ceil(len / 4));
    }
  }
  return tokens;
};

export const heuristicTokenizer: Tokenizer = {
  name: "heuristic",
  approximate: true,
  count: heuristicCount,
};

interface TiktokenModule {
  getEncoding: (name: string) => { encode: (s: string) => Uint32Array | number[] };
}

const tryLoadTiktoken = async (): Promise<Tokenizer | null> => {
  try {
    // js-tiktoken is a peer-optional dep; TypeScript can't resolve it unless
    // the user has installed it. Silence the static-resolution error here
    // because the failure path is the normal case.
    // @ts-expect-error optional runtime dependency
    const mod = (await import("js-tiktoken")) as unknown as TiktokenModule;
    if (typeof mod.getEncoding !== "function") return null;
    const enc = mod.getEncoding("cl100k_base");
    return {
      name: "tiktoken-cl100k",
      approximate: true, // still approximate for Claude tokens
      count(text: string): number {
        if (!text) return 0;
        try {
          return enc.encode(text).length;
        } catch {
          return heuristicCount(text);
        }
      },
    };
  } catch {
    return null;
  }
};

export type TokenizerChoice = "heuristic" | "tiktoken" | "auto";

export const loadTokenizer = async (choice: TokenizerChoice): Promise<Tokenizer> => {
  if (choice === "heuristic") return heuristicTokenizer;
  if (choice === "tiktoken") {
    const t = await tryLoadTiktoken();
    if (!t) {
      throw new Error(
        "js-tiktoken not available. Run `npm i -g js-tiktoken` or use --tokenizer=heuristic.",
      );
    }
    return t;
  }
  // auto
  return (await tryLoadTiktoken()) ?? heuristicTokenizer;
};
