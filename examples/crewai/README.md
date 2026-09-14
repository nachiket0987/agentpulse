# AgentTrace + CrewAI Example

Shows how to trace a CrewAI multi-agent workflow with AgentTrace.

## Setup

```bash
pip install crewai
npm install @agenttrace-io/sdk
```

## Usage

```python
import asyncio
from agenttrace import init, trace
from crewai import Agent, Task, Crew

agent = init(db_path="./traces.db")

async def run_crew():
    researcher = Agent(
        role="Researcher",
        goal="Research the given topic thoroughly",
        backstory="Expert researcher with attention to detail"
    )

    writer = Agent(
        role="Writer",
        goal="Write clear, concise summaries",
        backstory="Technical writer who simplifies complex topics"
    )

    task1 = Task(
        description="Research agent observability tools",
        agent=researcher,
        expected_output="List of top 5 observability tools with pros/cons"
    )

    task2 = Task(
        description="Write a summary of the research",
        agent=writer,
        expected_output="Concise markdown summary"
    )

    crew = Crew(agents=[researcher, writer], tasks=[task1, task2])

    # Trace the entire crew execution
    async with trace("crew-execution") as t:
        result = await crew.kickoff()
        t.set_output(str(result))
        return result

asyncio.run(run_crew())
```

## Viewing Traces

```bash
npx agenttrace dashboard
```
