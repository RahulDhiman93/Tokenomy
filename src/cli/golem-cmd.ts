import { configGet, configSet } from "./config-cmd.js";
import { loadConfig } from "../core/config.js";
import {
  buildGolemSessionContext,
  buildGolemTurnReminder,
} from "../rules/golem.js";

// `tokenomy golem enable|disable|status [--mode=lite|full|ultra|grunt|recon|auto]`
//
// Pure CLI wrapper over the existing `tokenomy config set` machinery. No
// settings.json patching here — the SessionStart + UserPromptSubmit hook
// registrations land during `tokenomy init`. This command only toggles the
// config flags that the live hooks read every invocation.

const MODES = new Set(["lite", "full", "ultra", "grunt", "recon", "auto"]);

const parseModeFlag = (argv: string[]): string | null => {
  for (const arg of argv) {
    if (arg.startsWith("--mode=")) return arg.slice("--mode=".length);
    if (arg === "--mode") {
      const idx = argv.indexOf(arg);
      const next = argv[idx + 1];
      if (typeof next === "string" && !next.startsWith("--")) return next;
    }
  }
  return null;
};

const writeStatus = (): number => {
  const cfg = loadConfig(process.cwd());
  const g = cfg.golem;
  const status = g.enabled ? "ENABLED" : "disabled";
  process.stdout.write(`Golem: ${status}\n`);
  process.stdout.write(`  mode:         ${g.mode}\n`);
  process.stdout.write(`  safety_gates: ${g.safety_gates}\n`);
  if (!g.enabled) {
    process.stdout.write(
      "\nRun `tokenomy golem enable [--mode=lite|full|ultra|grunt|recon]` to turn it on.\n",
    );
    return 0;
  }
  // When enabled, show the user exactly what gets injected. No surprises.
  const sessionCtx = buildGolemSessionContext(cfg);
  const turnReminder = buildGolemTurnReminder(cfg);
  if (sessionCtx) {
    process.stdout.write(
      "\nSessionStart injection (once per session):\n----------\n" +
        sessionCtx +
        "\n----------\n",
    );
  }
  if (turnReminder) {
    process.stdout.write(
      "\nUserPromptSubmit reminder (every turn):\n----------\n" +
        turnReminder +
        "\n----------\n",
    );
  }
  return 0;
};

export const runGolem = (argv: string[]): number => {
  const sub = argv[0];

  if (sub === "status" || sub === undefined) {
    return writeStatus();
  }

  if (sub === "enable") {
    const mode = parseModeFlag(argv);
    if (mode !== null) {
      if (!MODES.has(mode)) {
        process.stderr.write(
          `tokenomy golem: invalid mode "${mode}". Expected one of: lite, full, ultra, grunt, recon, auto.\n`,
        );
        return 1;
      }
      configSet("golem.mode", mode);
    }
    configSet("golem.enabled", "true");
    const cfg = loadConfig(process.cwd());
    process.stdout.write(
      `✓ Golem enabled in ${cfg.golem.mode.toUpperCase()} mode. ` +
        `Safety gates: ${cfg.golem.safety_gates ? "on" : "off"}.\n`,
    );
    process.stdout.write(
      "  → Start a new Claude Code session to load the output-style rules.\n",
    );
    process.stdout.write(
      "  → `tokenomy golem status` shows exactly what gets injected.\n",
    );
    return 0;
  }

  if (sub === "disable") {
    configSet("golem.enabled", "false");
    process.stdout.write(
      "✓ Golem disabled. Assistant replies will return to normal style on the next session.\n",
    );
    return 0;
  }

  if (sub === "get" && argv[1]) {
    const v = configGet(`golem.${argv[1]}`);
    process.stdout.write(v === undefined ? "" : `${JSON.stringify(v)}\n`);
    return 0;
  }

  process.stderr.write(
    "Usage:\n" +
      "  tokenomy golem enable [--mode=lite|full|ultra|grunt|recon|auto]\n" +
      "  tokenomy golem disable\n" +
      "  tokenomy golem status\n",
  );
  return 1;
};
