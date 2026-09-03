---
status: accepted
date: 2026-09-02
---

# Standalone extension, not built on pi-permission-system

Several MIT-licensed pi extensions already gate tool calls, and @gotgenes/pi-permission-system exposes an authorizer seam we could have plugged a judge into (see `docs/research/existing-extensions.md`). We chose to build one standalone package instead, because the whole point of this project is the dialog: Explain, narration, and the judge's rationale all have to live in one prompt the person sees, and pi-permission-system's inline keybind prompt would have to be fought rather than extended. A learner also installs one package with one config, not two. Since our gate covers every change call, the deterministic rule engine that is pi-permission-system's main value buys little here.

## Considered options

- **Authorizer on pi-permission-system**: less code, but the dialog is theirs and the judge runs only on its `ask` path.
- **Fork pi-permission-system**: the most engine for the least design, but a 30-release codebase to learn and carry.
- **Standalone** (chosen): own the dialog; copy specific pieces under MIT with attribution: bash wrapper detection (`bash -c`, `eval`, `sudo`, `xargs`) from pi-permission-system and the hard-deny list from czottmann/pi-automode.

## Consequences

We own bash parsing safety. Anything the wrapper detection misses is our bug, so the gate must fail closed on commands it cannot parse.
