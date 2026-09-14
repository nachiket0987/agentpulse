# agenttrace-io (Python SDK)

Drop-in tracing for any AI agent. Local SQLite storage, zero dependencies, zero cloud.

## Installation

```bash
pip install agenttrace-io
```

Requires Python 3.10+.

## Quickstart

```python
from agenttrace import init, trace

agent = init(db_path="./traces.db")

# Trace a callable
result = agent.trace("my-op", lambda: 42 * 2)

# Use as decorator
@trace("greet")
def greet(name: str) -> str:
    return f"Hello, {name}"

# Use as context manager
with agent.trace("context-op") as t:
    value = "computed"
    t.set_output(value)

# Query and export
traces = agent.get_traces()
stats = agent.get_stats()
agent.export("json")
agent.close()
```

See the [full README](https://github.com/Klepsiphron/agenttrace#python-sdk) for more.

## License

MIT © Klepsiphron
