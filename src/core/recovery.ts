export const buildRecoveryHint = (
  toolName: string,
  textBytesIn: number,
  textBytesOut: number,
): string =>
  `[tokenomy: response trimmed — ~${textBytesIn} → ~${textBytesOut} bytes. ` +
  `Re-invoke ${toolName} with narrower parameters if full output needed.]`;
