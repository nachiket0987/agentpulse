# AgentTrace + LangGraph Example

Shows how to trace a LangGraph agent with AgentTrace.

## Setup

```bash
pip install langgraph langchain-openai
npm install @agenttrace-io/sdk
```

## Usage

```python
import asyncio
from agenttrace import init, trace
from langgraph.graph import StateGraph, END
from langchain_openai import ChatOpenAI

# Initialize AgentTrace
agent = init(db_path="./traces.db")

# Define your LangGraph state and nodes
class AgentState:
    messages: list
    result: str = ""

async def research_node(state):
    """Example node that does research."""
    async with trace("research-node") as t:
        llm = ChatOpenAI(model="gpt-4o-mini")
        response = await llm.ainvoke(state["messages"])
        t.set_output(response.content)
        return {"messages": state["messages"] + [response], "result": response.content}

async def summarize_node(state):
    """Example node that summarizes."""
    async with trace("summarize-node") as t:
        llm = ChatOpenAI(model="gpt-4o-mini")
        prompt = f"Summarize: {state['result']}"
        response = await llm.ainvoke([{"role": "user", "content": prompt}])
        t.set_output(response.content)
        return {"result": response.content}

# Build graph
graph = StateGraph(dict)
graph.add_node("research", research_node)
graph.add_node("summarize", summarize_node)
graph.set_entry_point("research")
graph.add_edge("research", "summarize")
graph.add_edge("summarize", END)

app = graph.compile()

# Run with tracing
async def main():
    result = await app.ainvoke({"messages": [{"role": "user", "content": "What is agent observability?"}]})
    print(result["result"])

asyncio.run(main())
```

## Viewing Traces

```bash
npx agenttrace dashboard
# Open http://localhost:3000
```
