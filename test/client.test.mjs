import assert from 'node:assert/strict';
import { createHmac } from 'node:crypto';
import { test } from 'node:test';
import {
  I2VClient, I2VHttpError, I2VSubmissionUnknownError, I2VWaitTimeoutError, verifyWebhook,
} from '../dist/index.js';

const sample = { model: 'fixture-image', inputs: { prompt: 'A ceramic cup' } };
const submission = { ...sample, maxCostUsd: '0.10000000', expectedRevision: 7 };
const apiKey = 'isolated-fixture-key';
const json = (body, init) => Response.json(body, init);

test('catalog reads do not send the account key', async () => {
  const client = new I2VClient({
    apiKey,
    fetch: async (url, init) => {
      assert.equal(url.pathname, '/api/v1/generation-models');
      assert.equal(init.headers.has('Authorization'), false);
      return json({ data: [{ id: sample.model }] });
    },
  });
  assert.equal((await client.getModel(sample.model)).id, sample.model);
});

test('quote then submit with exact inputs, revision, cap, and operation key', async () => {
  const client = new I2VClient({
    apiKey,
    fetch: async (url, init) => {
      assert.equal(init.redirect, 'error');
      assert.equal(init.headers.get('Authorization'), `Bearer ${apiKey}`);
      if (url.pathname.endsWith('/quote')) {
        assert.deepEqual(JSON.parse(init.body), sample);
        return json({ model: sample.model, maximum: { currency: 'USD', amount: '0.10000000' }, expectedRevision: 7 });
      }
      assert.equal(url.pathname, '/api/v1/jobs/createTask');
      assert.equal(init.headers.get('Idempotency-Key'), 'operation-1');
      assert.deepEqual(JSON.parse(init.body), submission);
      return json({ taskId: 'task-1' }, { headers: { 'X-Request-ID': 'request-1' } });
    },
  });
  const { data: quote } = await client.quote(sample);
  assert.equal(quote.maximum.amount, submission.maxCostUsd);
  const task = await client.createTask(submission, 'operation-1');
  assert.deepEqual(task, { data: { taskId: 'task-1' }, requestId: 'request-1', retryAfterMs: null });
  await assert.rejects(client.createTask({ ...submission, maxCostUsd: '1.000000001' }, 'operation-1'), TypeError);
});

test('a lost response recovers the original operation without creating a task again', async () => {
  const calls = [];
  const client = new I2VClient({
    apiKey,
    fetch: async (url, init) => {
      calls.push(url.pathname);
      assert.equal(init.headers.get('Idempotency-Key'), 'operation-2');
      if (calls.length === 1) throw new Error('fixture connection closed after acceptance');
      return json({ status: 'accepted', taskId: 'task-2' });
    },
  });
  await assert.rejects(client.createTask(submission, 'operation-2'), error =>
    error instanceof I2VSubmissionUnknownError && error.idempotencyKey === 'operation-2');
  assert.equal((await client.recoverSubmission('operation-2')).data.taskId, 'task-2');
  assert.deepEqual(calls, ['/api/v1/jobs/createTask', '/api/v1/jobs/submission']);
});

test('an HTTP 409 pending submission preserves the key and recovery metadata', async () => {
  const calls = [];
  const client = new I2VClient({
    apiKey,
    fetch: async (url, init) => {
      calls.push(url.pathname);
      assert.equal(init.headers.get('Idempotency-Key'), 'operation-pending');
      if (url.pathname === '/api/v1/jobs/createTask') {
        return json({ code: 'conflict', reason: 'submission_pending' }, {
          status: 409,
          headers: { 'X-Request-ID': 'pending-request', 'Retry-After': '5' },
        });
      }
      return json({ status: 'pending' }, { headers: { 'Retry-After': '5' } });
    },
  });
  let operationId;
  await assert.rejects(client.createTask(submission, 'operation-pending'), error => {
    assert(error instanceof I2VSubmissionUnknownError);
    assert.equal(error.idempotencyKey, 'operation-pending');
    operationId = error.idempotencyKey;
    assert(error.cause instanceof I2VHttpError);
    assert.equal(error.cause.code, 'conflict');
    assert.equal(error.cause.reason, 'submission_pending');
    assert.equal(error.cause.requestId, 'pending-request');
    assert.equal(error.cause.retryAfterMs, 5000);
    return true;
  });
  const receipt = await client.recoverSubmission(operationId);
  assert.equal(receipt.data.status, 'pending');
  assert.equal(receipt.retryAfterMs, 5000);
  assert.deepEqual(calls, ['/api/v1/jobs/createTask', '/api/v1/jobs/submission']);
});

test('definitive submit conflicts preserve the reason as an HTTP error', async () => {
  for (const reason of ['max_cost_exceeded', 'usd_commercial_quote_changed', null]) {
    const client = new I2VClient({
      apiKey,
      fetch: async () => json({ code: 'conflict', ...(reason && { reason }) }, { status: 409 }),
    });
    await assert.rejects(client.createTask(submission, 'operation-rejected'), error =>
      error instanceof I2VHttpError && error.status === 409 && error.code === 'conflict' && error.reason === reason);
  }
});

test('rate limits preserve the HTTP metadata', async () => {
  const client = new I2VClient({
    apiKey,
    fetch: async () => json({ error: { code: 'rate_limited' } }, {
      status: 429,
      headers: { 'X-Request-ID': 'request-3', 'Retry-After': '6' },
    }),
  });
  await assert.rejects(client.getTask('task-3'), error =>
    error instanceof I2VHttpError &&
    error.retryAfterMs === 6000 && error.requestId === 'request-3' && error.code === 'rate_limited');
});

test('asset upload separates signed storage requests from authenticated API calls', async () => {
  const client = new I2VClient({
    apiKey,
    fetch: async (url, init) => {
      if (url.pathname === '/api/v1/assets') {
        assert.deepEqual(JSON.parse(init.body), { fileName: 'reference.png', contentType: 'image/png', fileSize: 4 });
        return json({ assetId: 'asset-1', contentType: 'image/png', uploadUrl: 'https://storage.example.test/reference' }, { status: 201 });
      }
      if (url.hostname === 'storage.example.test') {
        assert.equal(init.method, 'PUT');
        assert.equal(new Headers(init.headers).has('Authorization'), false);
        assert.equal(await init.body.text(), 'test');
        return new Response(null, { status: 204 });
      }
      assert.equal(url.pathname, '/api/v1/assets/asset-1/complete');
      assert.equal(init.headers.get('Authorization'), `Bearer ${apiKey}`);
      return json({ url: 'https://storage.example.test/verified' });
    },
  });
  const file = new Blob(['test'], { type: 'image/png' });
  assert.equal((await client.uploadAsset(file, 'reference.png')).data.url, 'https://storage.example.test/verified');
});

test('waiting uses the same task and never cancels it on timeout', async () => {
  const calls = [];
  const client = new I2VClient({
    apiKey,
    fetch: async (url, init) => {
      calls.push([url.pathname, url.searchParams.get('taskId'), init.method]);
      return json({ status: 'generating', lifecycle: { phase: 'reconciling', pollAfterSeconds: 30 } });
    },
  });
  await assert.rejects(client.waitForTask('task-4', { timeoutMs: 30 }), error =>
    error instanceof I2VWaitTimeoutError && error.taskId === 'task-4');
  assert.deepEqual(calls, [['/api/v1/jobs/recordInfo', 'task-4', 'GET']]);
});

test('webhook validation covers raw bytes, key rotation and freshness', () => {
  const now = 1_763_520_000_000;
  const timestamp = String(now / 1000);
  const body = Buffer.from('{"eventId":"event-1","data":{"taskId":"task-5","status":"success"}}\n');
  const secret = 'fixture-webhook-secret';
  const signature = createHmac('sha256', secret).update(timestamp + '.').update(body).digest('hex');
  const headers = new Headers({
    'X-I2V-Event-ID': 'event-1',
    'X-I2V-Key-ID': 'current',
    'X-I2V-Timestamp': timestamp,
    'X-I2V-Signature': 'v1=' + signature,
  });
  const getSecret = key => key === 'current' ? secret : undefined;
  const event = verifyWebhook(body, headers, getSecret, { now });
  assert.equal(event.eventId, 'event-1');
  assert.equal(event.body.data.taskId, 'task-5');
  assert.equal(verifyWebhook(body.subarray(0, -1), headers, getSecret, { now }), null);
  assert.equal(verifyWebhook(body, headers, getSecret, { now: now + 301_000 }), null);
  headers.set('X-I2V-Event-ID', 'unbound-event-id');
  assert.equal(verifyWebhook(body, headers, getSecret, { now }), null);
  headers.set('X-I2V-Event-ID', 'event-1');
  headers.set('X-I2V-Key-ID', 'retired');
  assert.equal(verifyWebhook(body, headers, getSecret, { now }), null);
});
