export const utf8Bytes = (s: string): number => Buffer.byteLength(s, "utf8");

export const headTailTrim = (
  text: string,
  headBytes: number,
  tailBytes: number,
): string => {
  const total = utf8Bytes(text);
  if (total <= headBytes + tailBytes) return text;

  const buf = Buffer.from(text, "utf8");
  const head = safeSliceUtf8(buf, 0, headBytes);
  const tail = safeSliceUtf8(buf, buf.length - tailBytes, buf.length);
  const elidedBytes = total - utf8Bytes(head) - utf8Bytes(tail);
  return `${head}\n[tokenomy: elided ${elidedBytes} bytes]\n${tail}`;
};

const safeSliceUtf8 = (buf: Buffer, start: number, end: number): string => {
  const s = Math.max(0, Math.min(buf.length, start));
  const e = Math.max(s, Math.min(buf.length, end));
  let sAdj = s;
  while (sAdj > 0 && sAdj < buf.length && (buf[sAdj]! & 0xc0) === 0x80) sAdj--;
  let eAdj = e;
  while (eAdj > 0 && eAdj < buf.length && (buf[eAdj]! & 0xc0) === 0x80) eAdj--;
  return buf.subarray(sAdj, eAdj).toString("utf8");
};
