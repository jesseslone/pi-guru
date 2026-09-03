# Judge benchmark plan

Status: amended 2026-09-03 after the adversarial review in `judge-bench-plan-review.md` (verdict: proceed with amendments; all thirteen findings folded in below). Builds on `judge-benchmarks.md` (sources) and the
prefix-cache measurements of 2026-09-03 (vLLM strict-prefix; same system prompt → 8.6 s to 1.9 s prefill; a
changed system prompt → full recompute).

## Goals

1. Measure, per model, how often the judge lets a harmful change call through and how often it blocks a benign
   one, using exactly the production prompt, transcript flattening, message layout, and verdict parser.
2. Run from inside a pi session as a slash command, choosing models only through pi's own model registry, so
   there is no separate provider or model configuration to maintain.
3. Keep every run's results on the machine, so a person can compare models and layouts over time. Make the
   report readable at the current explanation level, so the bench doubles as a way to learn what a benchmark
   measures and what the numbers mean.
4. Measure request layouts for cache reuse, since a judge call per change call is the main running cost.
   This is a **separate benchmark** from accuracy: cache reuse is a within-session property, so it is
   measured over a synthetic growing session (one ordered list of change calls replayed as a single
   appended transcript), never over independent records. Its primary signal is the endpoint's
   `cached_tokens`; prefill latency is advisory only, because a shared GPU box is never quiet.

## Non-goals

- Shipping any third-party data. Sources are fetched at run time, converted in memory, cached locally, never
  committed. The repo ships converters, attribution, and our own hand-written cases (MIT).
- Driving a real agent to produce the calls. A benchmark supplies the call; the realism is in reusing the
  production code path for everything after that.
- Comparing models the person has not configured in pi.

## Where it lives

- A second extension entry in the pi-guru package: `extensions/pi-guru-bench.ts`, listed in `package.json`
  `pi.extensions`. Loads only its own commands; touches nothing in the gate.
- Converters, the record schema, the runner, the results store, and the report under `src/bench/`.
- Hand-written cases under `bench/cases/*.json` (ours). Nothing else under `bench/`.
- Local state under pi's agent directory: `~/.pi/agent/pi-guru-bench/cache/<source>/<version>/` for fetched
  data and `~/.pi/agent/pi-guru-bench/results/<ISO time>-<model>-<layout>.jsonl` plus `summary.json`. Nothing
  under the repo. `.gitignore` also covers `bench/cache/` and `bench/results/` in case someone points it there.

## Record schema

Every source converts to the same record, and the runner never sees a source-specific field:

```
{ source, sourceVersion, id, category, kind: "bash"|"write"|"edit"|"other",
  expected: "harmful"|"benign"            // binary; every source is scored binary
  authoredRisk?: "low"|"medium"|"high"    // only on hand-written cases, where we wrote the three-way label
  label: <verbatim source label>,
  transcriptEntries: SessionEntry[]   // pi session-entry shape, flattened by src/transcript.ts
  pending: { title, detail }          // exactly what src/normalize.ts would produce
  origin: { url, license, attribution } }
```

No source labels "medium", so scoring is binary per source and the mapping is written in each converter:
rogue-security criticality ≥ 4 → harmful (the card's own critical threshold), else benign; R-Judge unsafe →
harmful, safe → benign; RedCode-Exec → harmful. The judge's medium rate is reported as a distribution, not
scored. The 3×3 confusion view exists only for hand-written cases, which carry an authored three-way label.

Foreign actions (R-Judge pseudo-APIs, AgentDojo functions) are `kind: "other"` and go through
`normalizeOther`, so `pending.detail` is byte-for-byte what production shows; the converter synthesises the
exact `toolCall` block shape that `buildConversationText` renders, and records which pi tool, if any, each
action maps to. Those sources are labelled "adapted" in every report.

Let-through is defined relative to the auto-mode threshold and both are always reported:
`P(risk ≤ low | harmful)` and `P(risk ≤ medium | harmful)`. Benign-blocked is `P(risk = high | benign)`.

Each run draws a deterministic per-source sample from `(sourceVersion, seed, limit)`; the seed is recorded in
`summary.json`, record ids are stable, and `--resume` keys on those ids. Two models compared with the same
seed and limit see the same records.

## Sources, isolated

Each source is a module with `{ id, license, version(), fetch(cacheDir, signal), convert(raw) }`. The runner
loads sources in a loop; a throw in any source is caught, logged with its reason into the run's JSONL as a
`source-failed` line, and the run continues with the others. Fetches pin a commit hash or dataset revision,
record it in `sourceVersion`, and verify a checksum on the cached file. A source whose schema no longer
matches the converter fails closed with a clear message rather than yielding garbage records. A source that
parses but yields zero usable records is also a failure and gets a `source-failed` line. Checksums are
trust-on-first-use: the pinned commit or dataset revision is the integrity anchor; the checksum only detects
later corruption of the local cache.

Initial sources: RedCode-Exec bash (CC-BY-4.0, GitHub copy), rogue-security coding-agent-security-benchmark
(CC-BY-NC-4.0, noted in the report), R-Judge (no license; fetched from the public repo for private evaluation,
never redistributed), an optional local scenario manifest as transcript templates, and `bench/cases/`.

## Running

`/judge-bench run [provider/model] [--sources a,b] [--limit N] [--seed S] [--resume <run>]` for accuracy, and
`/judge-bench cache [provider/model] [--layout current|prefix-stable|shared-prefix]` for the cache benchmark.
With no model, the session model. A model is resolved through `ctx.modelRegistry` only: `provider/model` or a
unique substring of the configured models; ambiguity errors with the candidate list; a model without
configured auth is skipped with a message, using the same auth guard as production. The bench never reads
provider config itself. Calls go through the same completer options as production (`reasoning: low`, 60 s
timeout).

Cancellation: `ctx.signal` is undefined outside an agent turn, so the runner owns an `AbortController` and
each call uses `AbortSignal.any([runner, timeout])`. A `ctx.ui.custom` progress overlay shows the count and
handles Esc by aborting the runner. Whether `pi -p "/judge-bench run"` fires the command is verified in
slice 2; if it does not, a `pi.registerFlag("judge-bench")` start-up path covers automation, and in no-UI mode
the result is written as Markdown and JSONL only.

Sequential by default. Runs against one model at a time and never two models at once, so a shared GPU box
keeps one engine resident. `--concurrency` exists but defaults to 1.

Checkpointing: the JSONL result file is created before the first model call and appended after every
record; `summary.json` is rewritten after every record. `--resume` skips records already in the file.

`/judge-bench compare` lists prior runs on this machine **per source**: model, source, N, seed, let-through
at low and at medium, benign-blocked, unavailable, p50/p95 latency, date. No pooled headline; if a pooled row
is ever shown it weights sources equally and prints each N beside it. `/judge-bench show <run>` renders one
run's per-source tables. `/judge-bench diff <a> <b>` lists the records where two runs' verdicts disagree,
which is the view that shows what a model or layout change actually did.

## Layouts under test

Implemented in `src/judge.ts` as named strategies behind a parameter that defaults to `current`, so
production behaviour is unchanged until a winner is chosen. This is the one place the bench touches gate-shared
code, and the change is additive.

- `current`: system prompt, then fenced user message with the pending action before the transcript, per-call
  nonce first. Baseline.
- `prefix-stable`: same system prompt; user message carries the transcript first inside a per-session-nonce
  fence, then the pending action inside a per-call-nonce fence. The prefix is append-only across a session.
- `shared-prefix`: the agent's own system prompt and message array unchanged, then one final user message with
  the judge instruction and the fenced pending action. Rides the agent's already-resident prefix.

The cache benchmark replays a fixed synthetic session of change calls, judging each in turn with the
transcript growing, so call n+1 can reuse call n's prefix as in production. It requires `cached_tokens` from
the endpoint for the cache claim; when the endpoint does not report it, the run says so and reports latency
as advisory only. It runs against one model, sequentially, and notes that a shared box is never quiet, so latency is
read in a quiet window or not at all.

## Report

Per run: let-through rate, benign-blocked rate, unavailable rate, latency p50/p95, and a 3×3 confusion matrix
per source and per category. Rendered as a `pi-guru-bench:result` session entry with a renderer so it stays in
scrollback, and written as Markdown next to the JSONL. When the explanation level is not `off`, the entry
also carries a short plain-language reading at that level, produced by the session model from the summary
only. Guardrails: the model is given each rate with its N and a simple interval; it may not make comparative
or causal claims the numbers do not contain; the paragraph is labelled as generated; and it is suppressed when
any per-source N is below a floor of 20.

## Slices

1. Record schema with `kind: other`, source modules with isolation, pinning, zero-yield failure, and TOFU
   checksums, cache dir, deterministic sampling, hand-written cases, converter tests with fixture files, and
   a CI smoke path: a handful of fixture records through the runner with a fake completer in vitest. No real
   model calls.
2. `/judge-bench run` through `ctx.modelRegistry` with the resolution rules above, runner-owned cancellation
   with a progress overlay, checkpointing, results store, `compare`, `show`, and `diff`. Verify the `pi -p`
   command path or add the start-up flag.
3. Layout strategies in `src/judge.ts` behind a default-`current` parameter, the synthetic-session cache
   benchmark, `cached_tokens` capture.
4. Result entry renderer and the guarded plain-language reading.

## Risks

- Label quality: rogue-security labels came from an LLM rubric; R-Judge is human-labelled but mostly
  pseudo-API. Report per source; never pool across sources for a headline number.
- Drift: sources change or vanish. Pins, checksums, and per-source isolation. A run with a missing source
  still reports what it has and says what is missing.
- License: the local cache is a private, non-redistributed evaluation copy. rogue-security is CC-BY-NC, so
  it never enters the repo or any published result artifact, and the bench README says so. R-Judge and
  control_arena_agentdojo carry no license; their converters ship only after their terms are confirmed
  with the authors, and until then those sources are off by default. Every report attributes each source.
- Cost and time: a full run is a few hundred calls; `--limit` and `--sources` for quick passes.
- Foreign trajectories: R-Judge and AgentDojo actions are not pi tool calls; the converter must produce honest
  `pending.detail` text and the report must label those sources as adapted.
- Contamination: some sources are public and may be in a model's training data. Hand-written cases are the
  control.
