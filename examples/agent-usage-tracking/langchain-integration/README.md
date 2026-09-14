# LangChain Integration - AgentTrace

Shows how to instrument LangChain (or LangGraph) agents with AgentTrace for full visibility into LLM calls, retrieval, tools, and agent actions.

The example includes a small reusable helper (`AgentTraceLangChain`) that acts like lightweight middleware.

## Install

```bash
pip install agenttrace-io
# Real LangChain usage:
# pip install langchain langchain-openai
python example.py
```

Local dev:

```bash
pip install -e ../../../../packages/sdk-python
python example.py
```

## Real LangChain Wiring (Python)

```python
from langchain_openai import ChatOpenAI
from agenttrace import init, trace

at = init(db_path="./traces.db")

llm = ChatOpenAI(model="gpt-4o-mini")

def traced_invoke(prompt: str):
    with at.trace("langchain-llm", input={"prompt": prompt}) as t:
        resp = llm.invoke(prompt)
        # LangChain often puts usage here:
        usage = getattr(resp, "response_metadata", {}).get("token_usage", {})
        t.set_tokens({
            "prompt_tokens": usage.get("prompt_tokens", 0),
            "completion_tokens": usage.get("completion_tokens", 0),
        })
        t.set_output(resp.content)
        return resp.content
```

For full graph tracing, prefer the official `@agenttrace-io/middleware-langgraph` package (works great with LangGraph which is built on LangChain).

See `examples/langgraph/README.md` in the repo root for a LangGraph-specific example.

## What the bundled example demonstrates

- `trace_llm_call` wrapper (easy drop-in around any LLM)
- `trace_chain_step` for custom nodes / tools / retrievers
- `record_agent_action` → `record_agent_usage` for agent-level telemetry
- Cost tracking across embedding + chat models
- Self-query after the "chain" runs

## JS / TS LangChain note

The same patterns apply with the Node SDK:

```ts
import { trace } from '@agenttrace-io/sdk';
const res = await trace('langchain-llm', () => llm.invoke(...), {
  model: 'gpt-4o-mini',
  tokens: extractTokensFromResponse(resp),
});
```

## View traces

```bash
npx agenttrace dashboard --db ./agenttrace.db
```

See the main README for the broader agent-focused guide.
