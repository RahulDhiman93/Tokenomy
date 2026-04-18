// Secret redaction: replace well-known credential formats with a stub marker.
// Runs before trim so that trimmed head/tail snippets can't leak keys either.
//
// Patterns are intentionally conservative: false positives risk mangling
// legitimate payloads. When in doubt we prefer to leave a token alone.

export interface RedactorPattern {
  name: string;
  re: RegExp;
}

export const BUILTIN_PATTERNS: RedactorPattern[] = [
  // AWS Access Key ID — exactly 20 chars matching AKIA/AGPA/etc prefixes.
  { name: "aws-access-key", re: /\b(?:AKIA|AGPA|AIDA|AROA|AIPA|ANPA|ANVA|ASIA)[A-Z0-9]{16}\b/g },
  // GitHub tokens: ghp_/gho_/ghu_/ghs_/ghr_ + base62 payload.
  { name: "github-token", re: /\bgh[pousr]_[A-Za-z0-9]{36,255}\b/g },
  // Anthropic API keys — must come before OpenAI since sk-ant-… also matches sk-…
  { name: "anthropic-key", re: /\bsk-ant-[A-Za-z0-9_-]{20,}\b/g },
  // OpenAI API keys (explicitly exclude sk-ant- prefix to avoid overlap).
  { name: "openai-key", re: /\bsk-(?!ant-)(?:proj-)?[A-Za-z0-9_-]{20,}\b/g },
  // Slack tokens: xox[bpaos]-...
  { name: "slack-token", re: /\bxox[bpaos]-[A-Za-z0-9-]{10,}\b/g },
  // Google API key.
  { name: "google-api-key", re: /\bAIza[0-9A-Za-z_-]{35}\b/g },
  // Stripe secret keys.
  { name: "stripe-key", re: /\b(?:sk|rk)_(?:live|test)_[0-9A-Za-z]{24,}\b/g },
  // JWT: three base64url segments separated by dots — require a sane length to
  // avoid matching random "a.b.c" strings.
  {
    name: "jwt",
    re: /\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\b/g,
  },
  // Generic "Bearer <token>" (min 20 chars of payload).
  {
    name: "bearer-token",
    re: /\bBearer\s+[A-Za-z0-9_\-./+=]{20,}\b/g,
  },
  // PEM private keys (header-only match; we stub the whole block downstream).
  {
    name: "pem-private-key",
    re: /-----BEGIN (?:RSA |EC |DSA |OPENSSH |PGP )?PRIVATE KEY-----[\s\S]+?-----END (?:RSA |EC |DSA |OPENSSH |PGP )?PRIVATE KEY-----/g,
  },
];

export interface RedactResult {
  redacted: string;
  counts: Record<string, number>;
  total: number;
}

export const redactSecrets = (
  text: string,
  patterns: RedactorPattern[] = BUILTIN_PATTERNS,
): RedactResult => {
  const counts: Record<string, number> = {};
  let total = 0;
  let out = text;
  for (const p of patterns) {
    out = out.replace(p.re, () => {
      counts[p.name] = (counts[p.name] ?? 0) + 1;
      total++;
      return `[tokenomy: redacted ${p.name}]`;
    });
  }
  return { redacted: out, counts, total };
};
