// 0.1.10+ P10h: Windows reserves a fixed set of basenames regardless
// of extension. Opening `CON.ts` on Windows talks to the console
// device, not a file. The graph builder must skip these to avoid
// surprising parser failures.
//
// Match case-insensitively. The basename may carry an extension
// (`con.ts`, `COM1.json`) but the reserved word is the part before
// the first dot.
const RESERVED = /^(CON|PRN|AUX|NUL|COM[1-9]|LPT[1-9])(\.[^.]*)?$/i;

export const isWindowsReservedName = (basename: string): boolean =>
  RESERVED.test(basename);
