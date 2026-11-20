# i2v.ai TypeScript SDK

A server-side ECMAScript module for Node.js 22 and newer. The SDK generates its HTTP types from the checked-in i2v.ai OpenAPI 2.2.0 snapshot. Model inputs are discovered at runtime.

```ts
import { I2VClient } from '@i2v-ai/sdk';

const client = new I2VClient({ apiKey: process.env.I2V_API_KEY });
const { data: catalog } = await client.listModels();
const spec = { model: 'gpt-image-2', inputs: { prompt: 'A ceramic mug on an oak table' } };
const { data: quote } = await client.quote(spec);
console.log(quote.maximum.amount, quote.expectedRevision);
```

The snippet only reads the catalog and obtains a quote. Quote and account operations require a server-side API key. When the user approves a budget, store the exact submission with the quoted revision, approved USD as a decimal string, and a stable operation key. Pass them to `createTask(submission, operationKey)`. Record the task ID and use `getTask` or `waitForTask`. The SDK returns `data`, `requestId`, and `retryAfterMs` so an application can surface support details and choose its own retry policy.

- **Recover:** if a submission times out or cannot be confirmed, call `recoverSubmission(originalKey)` with the original credential. On `accepted`, retain the task ID. On `pending`, keep checking the receipt. Replay a `retryable` request with exactly the same payload and key. A 404 calls for checking the key and credential.
- **Cancel:** aborting `waitForTask` ends your local wait. `cancelTask` attempts to cancel an owned task before the worker claims it. On a 409 continue reading the original task.
- **Upload:** `uploadAsset(blob, fileName)` requests a signed ticket, sends raw bytes without the API key, and confirms the upload on the API origin. Use the verified URL in the model's reference field.
- **Receive callbacks:** pass the raw body and request headers to `verifyWebhook` with a key-ID secret lookup. Apply the event only to the task owned by your application, deduplicate the event ID in durable storage, and make state changes idempotent.

See the [media workflow](https://i2v.ai/docs/media-workflow) and [runnable API examples](https://github.com/i2v-ai/i2v-api-examples).
