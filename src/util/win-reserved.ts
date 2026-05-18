// 0.1.10+ P10h: Windows reserves a fixed set of basenames regardless
// of extension. Opening `CON.ts` on Windows talks to the console
// device, not a file. The graph builder must skip these to avoid
// surprising parser failures.
//
// codex round 6 P2: Windows treats the reserved word as the portion
// BEFORE THE FIRST DOT, so `CON.foo.ts`, `NUL.test.js`, `LPT1.spec.ts`
// are all still device paths and equally hang the FS API. The regex
// must match any tail starting with a dot, not just one segment.
const RESERVED = /^(CON|PRN|AUX|NUL|COM[1-9]|LPT[1-9])(\..*)?$/i;

export const isWindowsReservedName = (basename: string): boolean =>
  RESERVED.test(basename);
