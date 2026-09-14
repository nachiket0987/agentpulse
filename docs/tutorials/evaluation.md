# Evaluating Traces

Define scorers (pure functions over `Trace`) to automatically grade quality, safety, cost-efficiency, etc. Scores are stored alongside traces.

## Define scorers

A scorer receives a full `Trace` and returns a number (higher is usually better; convention is 0-1 when possible).

### TypeScript

```typescript
import { init, trace, score } from '@agenttrace-io/sdk';

const agent = init();

const outputLength = score('output-length', (t) => {
  if (!t.output) return 0;
  const len = JSON.stringify(t.output).length;
  return Math.min(len / 2000, 1); // 0..1
});

const lowLatency = score('low-latency', (t) => {
  // invert: 2s -> 0, 0ms -> 1
  const ms = t.latencyMs || 0;
  return Math.max(0, 1 - ms / 2000);
});

const noError = score('no-error', (t) => (t.status === 'success' ? 1 : 0));

const hasCitations = score('has-citations', (t) => {
  const out = String(t.output || '');
  return /source|cite|ref/i.test(out) ? 1 : 0.2;
});
```

### Python

```python
from agenttrace import init, score

agent = init()

@score("output-length")
def output_length(trace):
    if not trace.output:
        return 0.0
    length = len(str(trace.output))
    return min(length / 2000.0, 1.0)

@score("low-latency")
def low_latency(trace):
    ms = trace.latency_ms or 0
    return max(0.0, 1.0 - ms / 2000.0)

@score("no-error")
def no_error(trace):
    return 1.0 if trace.status == "success" else 0.0

def has_citations(trace):
    out = str(trace.output or "")
    return 1.0 if any(k in out.lower() for k in ["source", "cite", "ref"]) else 0.2
```

You can also create `Scorer` objects manually:

```python
from agenttrace import Scorer

manual = Scorer(name="custom", fn=lambda t: 0.5)
```

## Run evaluation

### Over a whole run or all traces

#### TypeScript

```typescript
const results = await agent.evaluate({
  scorers: [outputLength, lowLatency, noError, hasCitations],
  runId: 'your-run-id', // omit to score everything
  concurrency: 4,
});

console.log(results);
// [
//   { traceId: '...', scores: { 'output-length': 0.73, 'low-latency': 0.91, ... }, errors: {} },
//   ...
// ]
```

#### Python

```python
results = agent.evaluate(
    scorers=[output_length, low_latency, no_error, has_citations],
    run_id=rid,
    concurrency=4,
)

for r in results:
    print(r.trace_id, r.scores, r.errors)
```

### Score a single trace

#### TypeScript

```typescript
const one = await agent.evaluateTrace('trace-uuid-123', [outputLength, noError]);
```

#### Python

```python
one = agent.evaluate_trace("trace-uuid-123", [output_length, no_error])
```

Top-level functions also work after `init()`:

```python
from agenttrace import evaluate, evaluate_trace, score
```

## Interpret the results

Scores live in the DB. Retrieve them:

```typescript
// via storage (or add a thin wrapper if desired)
import { TraceStorage } from '@agenttrace-io/sdk';
const storage = new TraceStorage('./agenttrace.db');
const all = storage.getScores();
const forTrace = storage.getScores('trace-id');
```

Python:

```python
scores = agent.get_scores()                 # all
t_scores = agent.get_scores(trace_id=some_id)
```

Combine with `getTraces` / `getStats` to answer questions:

- "Which runs have high quality + low cost?"
- Average score per model by joining on `tokens.model`
- Alert when average `no-error` drops below 0.95 (see alerting docs)

Example: find the best traces by composite score

#### TypeScript

```typescript
const traces = agent.getTraces({ runId });
const scored = await agent.evaluate({ scorers: [outputLength, lowLatency], runId });

const withComposite = scored
  .map((r) => {
    const composite = (r.scores['output-length'] || 0) * 0.6 + (r.scores['low-latency'] || 0) * 0.4;
    return { traceId: r.traceId, composite, ...r.scores };
  })
  .sort((a, b) => b.composite - a.composite);

console.log('Best traces:', withComposite.slice(0, 3));
```

#### Python

```python
traces = agent.get_traces({"run_id": rid})
scored = agent.evaluate(scorers=[output_length, low_latency], run_id=rid)

enriched = []
for r in scored:
    comp = (r.scores.get("output-length", 0) * 0.6 +
            r.scores.get("low-latency", 0) * 0.4)
    enriched.append({"trace_id": r.trace_id, "composite": comp, **r.scores})

enriched.sort(key=lambda x: x["composite"], reverse=True)
print("Top 3:", enriched[:3])
```

## Built-in ideas for scorers

- Faithfulness / citation coverage (check output mentions sources present in input)
- Cost efficiency: `output_quality / (costUsd + 0.0001)`
- Hallucination proxy (your own detector fn)
- JSON validity: try `JSON.parse` and return 1 or 0
- PII leakage: regex for emails, keys etc. → low score
- User feedback later: store thumbs up in metadata and score on it

## Persisted scores survive restarts

Scores are written to the `scores` table. Re-running the same scorers on the same traces appends more rows (use `getScores(traceId)` + latest or unique by name).

Re-evaluate after you improve a scorer — old scores stay for historical comparison.

## Next

- Use scores in your CI: `agenttrace export --json | jq` or call `evaluate` in a script and assert minimum averages.
- Combine with the [debugging tutorial](./debugging-agents.md) to focus scoring only on the slow or errored traces.
