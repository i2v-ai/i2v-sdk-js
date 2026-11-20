import { setTimeout as sleep } from 'node:timers/promises';
import type { components, operations } from './api.generated.js';

export type { components, operations, paths } from './api.generated.js';
export { verifyWebhook } from './webhook.js';
export type { WebhookHeaders, VerifiedWebhook } from './webhook.js';

type Schema = components['schemas'];
type JsonSuccess<Operation, Code extends number = 200> =
  Operation extends { responses: Record<Code, { content: { 'application/json': infer Data } }> }
    ? Data
    : never;

export type MediaRequest = Schema['MediaQuoteRequest'];
export type MediaQuote = Schema['MediaQuote'];
export type MediaTask = Schema['Task'];
export type SubmissionReceipt = Schema['MediaSubmissionReceipt'];
export type AccountUsageRange = NonNullable<
  NonNullable<operations['getAccountUsage']['parameters']['query']>['range']
>;
export type Submission = MediaRequest & {
  maxCostUsd: string;
  expectedRevision: number;
  callBackUrl?: string;
};

export interface RequestOptions {
  signal?: AbortSignal;
}

export interface Result<Data> {
  data: Data;
  requestId: string | null;
  retryAfterMs: number | null;
}

export interface ClientOptions {
  apiKey?: string;
  /** An i2v.ai origin or an explicitly trusted integration environment. */
  baseUrl?: string;
  timeoutMs?: number;
  fetch?: typeof fetch;
}

export class I2VHttpError extends Error {
  constructor(
    public readonly status: number,
    public readonly code: string | null,
    public readonly requestId: string | null,
    public readonly retryAfterMs: number | null,
    public readonly reason: string | null = null,
  ) {
    super(`i2v.ai request failed (HTTP ${status})${code ? `: ${code}` : ''}`);
    this.name = 'I2VHttpError';
  }
}

export class I2VSubmissionUnknownError extends Error {
  constructor(public readonly idempotencyKey: string, cause: unknown) {
    super('Submission could not be confirmed. Look up the original receipt.', { cause });
    this.name = 'I2VSubmissionUnknownError';
  }
}

export class I2VWaitTimeoutError extends Error {
  constructor(public readonly taskId: string) {
    super('The wait ended before the task reached a terminal state.');
    this.name = 'I2VWaitTimeoutError';
  }
}

function parseRetryAfter(value: string | null): number | null {
  if (value === null) return null;
  if (/^[0-9]+$/.test(value)) {
    const seconds = Number(value);
    return Number.isSafeInteger(seconds * 1_000) ? seconds * 1_000 : null;
  }
  const date = Date.parse(value);
  return Number.isFinite(date) ? Math.max(0, date - Date.now()) : null;
}

function errorIdentifier(value: unknown): string | null {
  return typeof value === 'string' && /^[a-zA-Z0-9_-]{1,100}$/.test(value)
    ? value
    : null;
}

function getErrorIdentifiers(body: unknown) {
  if (!body || typeof body !== 'object') return { code: null, reason: null };
  const record = body as Record<string, unknown>;
  const detail = record.error;
  const nested = detail && typeof detail === 'object'
    ? (detail as Record<string, unknown>).code
    : null;
  return {
    code: errorIdentifier(nested ?? record.code),
    reason: errorIdentifier(record.reason),
  };
}

function requireIdempotencyKey(key: string) {
  if (!/^[\x21-\x7e]{1,200}$/.test(key)) {
    throw new TypeError('Use a stable Idempotency-Key of up to 200 visible ASCII characters.');
  }
}

export class I2VClient {
  readonly #apiKey?: string;
  readonly #origin: URL;
  readonly #timeout: number;
  readonly #fetch: typeof fetch;

  constructor({ apiKey, baseUrl = 'https://api.i2v.ai', timeoutMs = 20_000, fetch: transport = globalThis.fetch }: ClientOptions = {}) {
    this.#origin = new URL(baseUrl);
    const loopback = ['localhost', '127.0.0.1', '[::1]'].includes(this.#origin.hostname);
    if (
      (this.#origin.protocol !== 'https:' && !(loopback && this.#origin.protocol === 'http:')) ||
      this.#origin.pathname !== '/' || this.#origin.search || this.#origin.hash ||
      this.#origin.username || this.#origin.password
    ) {
      throw new TypeError('baseUrl must be an HTTPS origin or a local HTTP test origin.');
    }
    if (!Number.isSafeInteger(timeoutMs) || timeoutMs <= 0 || timeoutMs > 2_147_483_647) {
      throw new RangeError('timeoutMs must be a positive millisecond integer.');
    }
    this.#apiKey = apiKey;
    this.#timeout = timeoutMs;
    this.#fetch = transport;
  }

  #signal(signal?: AbortSignal) {
    const timeout = AbortSignal.timeout(this.#timeout);
    return signal ? AbortSignal.any([signal, timeout]) : timeout;
  }

  async #request<Data>(
    path: string,
    { body, headers: extraHeaders, signal, publicRoute = false }: RequestOptions & {
      body?: string;
      headers?: Record<string, string>;
      publicRoute?: boolean;
    } = {},
  ): Promise<Result<Data>> {
    const headers = new Headers(extraHeaders);
    headers.set('Accept', 'application/json');
    if (!publicRoute) {
      if (!this.#apiKey) throw new TypeError('An i2v.ai API key is required.');
      headers.set('Authorization', `Bearer ${this.#apiKey}`);
    }
    if (body !== undefined) headers.set('Content-Type', 'application/json');
    const response = await this.#fetch(new URL(path, this.#origin), {
      method: body === undefined ? 'GET' : 'POST',
      headers,
      body,
      signal: this.#signal(signal),
      redirect: 'error',
    });
    const requestId = response.headers.get('X-Request-ID');
    const retryAfterMs = parseRetryAfter(response.headers.get('Retry-After'));
    if (!response.ok) {
      const { code, reason } = getErrorIdentifiers(await response.json().catch(() => null));
      throw new I2VHttpError(response.status, code, requestId, retryAfterMs, reason);
    }
    return { data: await response.json() as Data, requestId, retryAfterMs };
  }

  listModels(options?: RequestOptions) {
    return this.#request<JsonSuccess<operations['listGenerationModels']>>(
      '/api/v1/generation-models',
      { ...options, publicRoute: true },
    );
  }

  async getModel(model: string, options?: RequestOptions) {
    const { data } = await this.listModels(options);
    return data.data.find(({ id }) => id === model);
  }

  quote(spec: MediaRequest, options?: RequestOptions) {
    return this.#request<MediaQuote>('/api/v1/jobs/quote', {
      ...options, body: JSON.stringify(spec),
    });
  }

  async createTask(spec: Submission, idempotencyKey: string, options?: RequestOptions) {
    requireIdempotencyKey(idempotencyKey);
    if (!this.#apiKey) throw new TypeError('An i2v.ai API key is required.');
    if (!/^(0|[1-9][0-9]*)(\.[0-9]{1,8})?$/.test(spec.maxCostUsd)) {
      throw new TypeError('Use a USD decimal string with at most eight decimal places.');
    }
    if (!Number.isSafeInteger(spec.expectedRevision) || spec.expectedRevision < 0) {
      throw new TypeError('Use expectedRevision from the quote.');
    }
    options?.signal?.throwIfAborted();
    const body = JSON.stringify(spec);
    try {
      const result = await this.#request<JsonSuccess<operations['createTask']>>(
        '/api/v1/jobs/createTask',
        { ...options, body, headers: { 'Idempotency-Key': idempotencyKey } },
      );
      if (typeof result.data.taskId !== 'string' || !result.data.taskId) {
        throw new Error('The API returned an invalid task ID.');
      }
      return result;
    } catch (error) {
      if (error instanceof I2VHttpError && error.status < 500 &&
        !(error.status === 409 && error.reason === 'submission_pending')) throw error;
      throw new I2VSubmissionUnknownError(idempotencyKey, error);
    }
  }

  recoverSubmission(idempotencyKey: string, options?: RequestOptions) {
    requireIdempotencyKey(idempotencyKey);
    return this.#request<SubmissionReceipt>('/api/v1/jobs/submission', {
      ...options, headers: { 'Idempotency-Key': idempotencyKey },
    });
  }

  getTask(taskId: string, options?: RequestOptions) {
    const query = new URLSearchParams({ taskId });
    return this.#request<MediaTask>(`/api/v1/jobs/recordInfo?${query}`, options);
  }

  cancelTask(taskId: string, options?: RequestOptions) {
    return this.#request<Schema['CancelMediaTaskResult']>('/api/v1/jobs/cancel', {
      ...options, body: JSON.stringify({ taskId }),
    });
  }

  getAccount(options?: RequestOptions) {
    return this.#request<JsonSuccess<operations['getAccount']>>('/api/v1/account', options);
  }

  getUsage(range: AccountUsageRange = '30d', options?: RequestOptions) {
    const query = new URLSearchParams({ range });
    return this.#request<Schema['AccountUsage']>(`/api/v1/account/usage?${query}`, options);
  }

  async uploadAsset(file: Blob, fileName: string, options?: RequestOptions) {
    const { data: ticket } = await this.#request<Schema['MediaUploadTicket']>('/api/v1/assets', {
      ...options,
      body: JSON.stringify({ fileName, fileSize: file.size, contentType: file.type }),
    });
    const target = new URL(ticket.uploadUrl);
    if (target.protocol !== 'https:' || target.username || target.password) {
      throw new TypeError('The upload ticket must contain an HTTPS storage URL.');
    }
    const response = await this.#fetch(target, {
      method: 'PUT',
      headers: { 'Content-Type': ticket.contentType },
      body: file,
      redirect: 'error',
      signal: this.#signal(options?.signal),
    });
    if (!response.ok) throw new I2VHttpError(response.status, 'asset_upload_failed', null, null);
    const complete = '/api/v1/assets/' + encodeURIComponent(ticket.assetId) + '/complete';
    return this.#request<Schema['CompletedMediaUpload']>(complete, { ...options, body: '{}' });
  }

  async waitForTask(taskId: string, { signal, timeoutMs = 900_000 }: RequestOptions & { timeoutMs?: number } = {}) {
    if (!Number.isSafeInteger(timeoutMs) || timeoutMs <= 0 || timeoutMs > 2_147_483_647) {
      throw new RangeError('timeoutMs must be a positive millisecond integer.');
    }
    const deadline = AbortSignal.timeout(timeoutMs);
    const waitSignal = signal ? AbortSignal.any([signal, deadline]) : deadline;
    let delay = 2_000;
    try {
      for (;;) {
        let suggestedDelay = 0;
        try {
          const result = await this.getTask(taskId, { signal: waitSignal });
          const task = result.data;
          if (task.status === 'success' || task.status === 'fail') return result;
          suggestedDelay = (task.lifecycle?.pollAfterSeconds ?? 0) * 1_000;
        } catch (error) {
          if (!(error instanceof I2VHttpError && (error.status === 429 || error.status >= 500))) {
            throw error;
          }
          suggestedDelay = error.retryAfterMs ?? 0;
        }
        const nextCheck = Math.min(2_147_483_647, Math.max(delay, suggestedDelay));
        await sleep(nextCheck, undefined, { signal: waitSignal });
        delay = Math.min(30_000, Math.ceil(delay * 1.5));
      }
    } catch (error) {
      if (deadline.aborted && !signal?.aborted) throw new I2VWaitTimeoutError(taskId);
      throw error;
    }
  }
}
