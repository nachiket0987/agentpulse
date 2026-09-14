# AgentTrace Custom Agent Example

Shows how to trace any custom agent with the AgentTrace SDK.

## Setup

```bash
npm install @agenttrace-io/sdk
```

## Basic Usage

```typescript
import { init, trace } from '@agenttrace-io/sdk';

// Initialize with default SQLite storage
const agent = init();

// Or with custom DB path and options
const agent = init({
  dbPath: './my-traces.db',
  verbose: true, // console.log each trace
});

// Trace any async function
async function myAgent(userInput: string) {
  return await trace('my-agent', async () => {
    // Step 1: Preprocess
    const processed = await trace('preprocess', async () => {
      return userInput.trim().toLowerCase();
    });

    // Step 2: Call LLM
    const response = await trace('llm-call', async () => {
      const res = await fetch('https://api.openai.com/v1/chat/completions', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          model: 'gpt-4o-mini',
          messages: [{ role: 'user', content: processed }],
        }),
      });
      return res.json();
    });

    // Step 3: Post-process
    const output = await trace('postprocess', async () => {
      return response.choices[0].message.content;
    });

    return output;
  });
}

// Run it
const result = await myAgent('What is observability?');
console.log(result);
```

## With Manual Token Tracking

```typescript
import { init, startTrace } from '@agenttrace-io/sdk';

const agent = init();

async function trackedAgent(input: string) {
  const t = startTrace('manual-agent', input);

  try {
    // Your agent logic here
    const result = await callYourLLM(input);

    // Manually set token counts if you have them
    t.setTokens({
      promptTokens: 150,
      completionTokens: 50,
      totalTokens: 200,
    });
    t.setModel('gpt-4o-mini');
    t.setOutput(result);

    return result;
  } catch (error) {
    t.setError(error.message);
    throw error;
  }
}
```

## Viewing Traces

```bash
# Start the dashboard
npx agenttrace dashboard

# Or query from CLI
npx agenttrace runs --limit 10
npx agenttrace stats
npx agenttrace export --format json --output traces.json
```
