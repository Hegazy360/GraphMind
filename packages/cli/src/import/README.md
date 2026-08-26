# Trace import (`graphmind import <file>`)

Best-effort, post-hoc conversion of exported trace files into a GraphMind
run. The run is inserted through the normal storage interface with
`source: 'import'` (so `RunInfo.source` triggers the viewer's "imported"
treatment) and a `meta: { source: 'import', format, file }` block on
`run.started`. No live features apply — an imported run is history only.

Pipeline: **container parsing** (`otlp.ts`, `flat.ts`) → **per-span dialect
classification** (`classify.ts`) → **envelope synthesis** (`convert.ts`).
Container and dialect are deliberately orthogonal: an OTLP file can carry AI
SDK, GenAI-semconv, or OpenInference attributes, and so can a flat span list.

## Supported containers

1. **OTLP/JSON** — `{ resourceSpans: [{ resource, scopeSpans: [{ spans }] }] }`
   as written by the OTel collector `file` exporter / SDK JSON exporters.
   - Both camelCase (the proto3 JSON norm) and snake_case keys are accepted;
     `instrumentationLibrarySpans` is accepted as a legacy alias of `scopeSpans`.
   - Attributes are OTLP `AnyValue`s; `intValue` may be a string (int64 JSON
     encoding). kvlist/array values are converted recursively.
   - `startTimeUnixNano`/`endTimeUnixNano` may be strings or numbers; they are
     converted to epoch **milliseconds** (nanosecond precision is dropped —
     GraphMind envelopes use ms timestamps).
   - Span status is an error when `status.code` is `2`, `"2"`, or
     `"STATUS_CODE_ERROR"` (plus `"ERROR"`, seen in some exporters). Error
     name/message/stack come from the span's first OTel `exception` event
     (`exception.type` / `exception.message` / `exception.stacktrace`),
     falling back to `status.message`.
   - `service.name` from the first resource becomes the run's app name.
2. **Flat span lists** (OpenInference/Arize Phoenix-style) — a JSON array of
   span objects, `{ "spans": [...] }`, `{ "data": [...] }`, or JSONL (one
   span object per line).
   - Ids: `context.span_id` / `span_id` / `spanId` / `id`; parent:
     `parent_id` / `parentId` / `parent_span_id`. Spans without an id get a
     synthetic one (their children cannot reference them, which is fine).
   - Timestamps: `start_time` / `end_time` as ISO 8601 strings, or numeric
     epoch values whose unit is guessed by magnitude
     (`>=1e17` ns, `>=1e14` µs, `>=1e11` ms, else seconds).
   - `attributes` may be a nested object (flattened to dotted keys — the
     OpenInference attribute names ARE dotted strings) and/or pandas
     dataframe records with top-level `attributes.*` columns.
   - `span_kind` / `spanKind` / `kind` is normalized into
     `openinference.span.kind`.
   - `status_code` `"ERROR"` (or `2`) marks an error; `status_message` and
     `exception` events (dict- or kvlist-shaped attributes) fill the error.

Everything else fails with an `ImportError` that names the top-level shape
that was found.

## Dialect classification (first match wins per span)

### 1. AI SDK legacy telemetry (`experimental_telemetry` / `LegacyOpenTelemetry`)

Recognized by `ai.operationId`, or an `operation.name` whose first token
starts with `ai.` (the AI SDK sets `operation.name` to
`"<operationId> <functionId>"`). Attribute names verified against the
installed `ai@7.0.79` package docs (`docs/03-ai-sdk-core/60-telemetry.mdx`).

| span                                   | GraphMind node |
| -------------------------------------- | -------------- |
| `ai.generateText` / `ai.streamText` / `ai.generateObject` / `ai.streamObject` | `agent:<runName>`, kind `agent`. `runName` = `ai.telemetry.functionId` ?? `resource.name` ?? the operation minus its `ai.` prefix. |
| `*.doGenerate` / `*.doStream`          | `llm:step`, kind `llm` (one logical LLM node; `instanceId` = span id — decisions.md #1) |
| `ai.toolCall`                          | `tool:<ai.toolCall.name>`, kind `tool`, `instanceId` = `ai.toolCall.id` ?? span id |
| other `ai.*` ops (embed, rerank, ...)  | `custom:<op>`, kind `custom` |

- Usage: `ai.usage.promptTokens` / `ai.usage.completionTokens` first (the
  documented legacy names), then `ai.usage.inputTokens`/`outputTokens`, then
  the `gen_ai.usage.input_tokens`/`output_tokens` the SDK also sets on
  doGenerate spans.
- Input: `ai.prompt.messages` (doGenerate) or `ai.prompt` (root); output:
  `ai.response.text` ?? `ai.response.object` ?? `ai.response.toolCalls`;
  tool input/output: `ai.toolCall.args` / `ai.toolCall.result`. All of these
  are stringified JSON on the wire — strings that look like JSON
  objects/arrays are parsed, everything else is kept verbatim.
- Model: `ai.response.model` ?? `ai.model.id` ?? `gen_ai.request.model`,
  recorded as a `model` extra field on `node.started` (the schema is loose).

### 2. OTel GenAI semantic conventions (`@ai-sdk/otel` `OpenTelemetry`, and others)

Recognized by `gen_ai.operation.name`:
`invoke_agent` → agent (`gen_ai.agent.name` ?? span name);
`chat` / `generate_content` / `text_completion` → `llm:step`;
`execute_tool` → `tool:<gen_ai.tool.name>` (`instanceId` =
`gen_ai.tool.call.id` ?? span id, input/output from
`gen_ai.tool.call.arguments`/`.result`); any other operation → `custom:<op>`.
Usage from `gen_ai.usage.input_tokens`/`output_tokens`; input/output from
`gen_ai.input.messages`/`gen_ai.output.messages` (stringified JSON).

### 3. OpenInference (`openinference.span.kind`, case-insensitive)

`LLM` → `llm:step` (usage `llm.token_count.prompt`/`completion`, model
`llm.model_name`); `TOOL` → `tool:<tool.name ?? span name>`; `AGENT` →
`agent:<span name>`; `CHAIN` and all other kinds (RETRIEVER, EMBEDDING,
RERANKER, GUARDRAIL, EVALUATOR, ...) → `custom:<span name>`, kind `custom`.
Input/output: `input.value` / `output.value` (JSON-parsed when they look like
JSON — `*.mime_type` is not consulted), falling back to re-assembled
flattened `llm.input_messages.*` / `llm.output_messages.*` lists.

Spans matching no dialect are **skipped** (counted and listed in the CLI
summary — e.g. HTTP client spans inside an OTLP export). A file with zero
recognized spans fails with a message listing what WAS seen.

## Envelope synthesis

- One imported file becomes **one run**, even if it contains several traces
  (root spans simply become sibling top-level nodes).
- Sequence: `run.started` (ts = earliest span start) → per span
  `node.started` at its start time and `node.finished` at its end time —
  preceded by `node.error` when the span failed, mirroring the live adapter —
  → `run.finished` (ts = latest span end). `seq` is 0..n-1 in that order;
  envelope `ts` keeps the original trace timeline.
- Tie-breaks at equal timestamps: starts before finishes, outer (shallower)
  spans start first, inner (deeper) spans finish first. End times are clamped
  to `>= start`; `durationMs = end - start`.
- `parentId` on `node.started` is the **logical nodeId** of the nearest
  *mapped* ancestor span (skipped ancestors are climbed through; cycles are
  guarded).
- Run status: with exactly one root span, the root decides (`error` iff it
  errored — a recovered child error leaves the run `ok`); with several roots,
  any errored span marks the run `error`. Aborted runs cannot be detected
  from OTel status codes, so `aborted` is never produced.
- `node.finished` carries an `instanceId` extra field (like the live
  adapter); usage is attached when either token count was present (a missing
  side defaults to 0, since the schema requires both).
- App name: explicit override → OTLP `service.name` → root agent node's
  name → the file's basename.
- Duplicate span ids: first occurrence wins. Spans with identical `(runId,
  seq)` cannot occur (seq is assigned here).
- Every import generates a fresh `imp_<12 hex>` run id — importing the same
  file twice creates two runs (no content-based dedup, by design: an import
  is an explicit user action).

## Known limitations

- No `node.token` events are synthesized (no streaming data in span exports).
- No `graph.hint` is emitted; the graph is built from execution alone.
- Provider-executed tools, pause/step, and injection do not apply to
  imported runs.
- The importer writes to the SQLite DB directly (WAL). A running server
  sees the run on its next read (refresh the run list); it does not push a
  live `run.update` for it.
