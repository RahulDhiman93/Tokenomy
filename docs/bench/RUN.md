# Tokenomy Bench

Added in `0.1.1-beta.2`.

Run all deterministic scenarios:

```bash
tokenomy bench run --json
```

Generate a README-ready table:

```bash
tokenomy bench report --md
```

The default harness uses synthetic or captured-shape inputs only. It does not
hit package registries or require large fixture repositories, so it is safe for
CI. Future `--live` scenarios can be added behind an explicit opt-in.
