// 0.1.10+ P10i: respect NO_COLOR, --no-color CLI flag, and TTY
// detection. Callers consult colorsEnabled() before emitting ANSI
// escape sequences; when disabled the emitter must return the bare
// string. Standard contract from https://no-color.org.

export const colorsEnabled = (): boolean => {
  if (process.env["NO_COLOR"] !== undefined) return false;
  if (process.argv.includes("--no-color")) return false;
  return process.stdout.isTTY === true;
};
