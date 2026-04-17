export const safeParse = <T = unknown>(s: string): T | undefined => {
  try {
    return JSON.parse(s) as T;
  } catch {
    return undefined;
  }
};

export const stableStringify = (v: unknown): string => JSON.stringify(v, null, 2);
