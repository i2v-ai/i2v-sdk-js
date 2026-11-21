<p align="center">
  <a href="https://i2v.ai">
    <img src="https://i2v.ai/brand/folded-rabbit-light.png" alt="i2v.ai" width="96">
  </a>
</p>

<h1 align="center">i2v.ai TypeScript SDK</h1>

<p align="center">
  Server-side client for i2v.ai image and video generation: catalog, quotes, uploads, tasks, recovery and signed webhooks.<br>
  Node.js 22 or newer · typed errors · quote before submit.
</p>

<p align="center">
  <a href="https://www.npmjs.com/package/@i2v-ai/sdk"><img alt="npm" src="https://img.shields.io/npm/v/@i2v-ai/sdk?style=flat-square"></a>
  <a href="https://i2v.ai/docs/integration"><img alt="Docs" src="https://img.shields.io/badge/docs-i2v.ai%2Fdocs%2Fintegration-6366f1?style=flat-square"></a>
  <a href="https://api.i2v.ai/openapi.json"><img alt="OpenAPI" src="https://img.shields.io/badge/OpenAPI-2.2.0-0ea5e9?style=flat-square"></a>
  <a href="./LICENSE"><img alt="License" src="https://img.shields.io/badge/license-MIT-22c55e?style=flat-square"></a>
</p>

<br>

## Install

```bash
npm install @i2v-ai/sdk
```

## Quick start

```ts
import { I2VClient } from '@i2v-ai/sdk';

const client = new I2VClient({ apiKey: process.env.I2V_API_KEY });
const models = await client.listModels();          // public, no key needed

const quote = await client.quote({ model: 'gpt-image-2', inputs: { prompt: 'A ceramic mug' } });
const receipt = await client.createTask(
  { model: 'gpt-image-2', inputs: { prompt: 'A ceramic mug' },
    maxCostUsd: '0.20', expectedRevision: quote.data.expectedRevision },
  'order-1234-image',
);
const task = await client.waitForTask(receipt.data.taskId);
console.log(task.data.status, task.data.output);
```

## Error model

| Error | Meaning |
| --- | --- |
| `I2VHttpError` | Non-2xx response. Carries `status`, `code`, `reason`, `requestId`, `retryAfterMs`. |
| `I2VSubmissionUnknownError` | The submission may be accepted (5xx, network failure, or HTTP 409 with `submission_pending`). Recover with `recoverSubmission(idempotencyKey)`. |
| `I2VWaitTimeoutError` | The wait ended before the task reached a terminal state. |

Webhook deliveries are verified with `verifyWebhook(rawBody, headers, getSecret)`, which checks the timestamp window, the HMAC over `timestamp.body` and the event ID in the body.

## Development

```bash
npm install
npm run build     # regenerates src/api.generated.ts from openapi/i2v-2.2.0.json
npm test
```

## For AI agents

- Agent index: <https://i2v.ai/llms.txt>
- Full documentation: <https://i2v.ai/llms-full.txt>
- Remote MCP server: <https://i2v.ai/api/mcp>

## Related repositories

| Repository | Purpose |
| --- | --- |
| [i2v-cli](https://github.com/i2v-ai/i2v-cli) | Command-line tools |
| [i2v-sdk-python](https://github.com/i2v-ai/i2v-sdk-python) | Python SDK |
| [i2v-skills](https://github.com/i2v-ai/i2v-skills) | Agent Skills |
| [i2v-mcp](https://github.com/i2v-ai/i2v-mcp) | Remote MCP metadata |
| [generate-action](https://github.com/i2v-ai/generate-action) | GitHub Action |
| [i2v-api-examples](https://github.com/i2v-ai/i2v-api-examples) | Runnable examples |
| [i2v-agent-tools](https://github.com/i2v-ai/i2v-agent-tools) | Ecosystem hub |

## License

MIT. See [LICENSE](./LICENSE).
