import { createHmac, timingSafeEqual } from 'node:crypto';

type Bytes = string | Uint8Array;

export interface WebhookHeaders {
  get(name: string): string | null;
}

export interface VerifiedWebhook {
  eventId: string;
  keyId: string;
  timestamp: number;
  body: unknown;
}

export function verifyWebhook(
  rawBody: Bytes,
  headers: WebhookHeaders,
  getSecret: (keyId: string) => Bytes | undefined,
  { now = Date.now(), maxAgeSeconds = 300 }: { now?: number; maxAgeSeconds?: number } = {},
): VerifiedWebhook | null {
  const eventId = headers.get('X-I2V-Event-ID');
  const keyId = headers.get('X-I2V-Key-ID');
  const ts = headers.get('X-I2V-Timestamp');
  const signature = headers.get('X-I2V-Signature');
  if (!eventId || !keyId || !ts || !/^[0-9]{1,13}$/.test(ts) || !signature ||
      !/^v1=[a-f0-9]{64}$/.test(signature)) {
    return null;
  }
  if (!Number.isFinite(now) || !Number.isSafeInteger(maxAgeSeconds) || maxAgeSeconds < 0) {
    throw new RangeError('Provide a valid webhook clock and freshness window.');
  }
  const timestamp = Number(ts);
  if (Math.abs(Math.floor(now / 1_000) - timestamp) > maxAgeSeconds) return null;

  const secret = getSecret(keyId);
  if (!secret || secret.length === 0) return null;
  const expected = createHmac('sha256', secret).update(ts + '.').update(rawBody).digest();
  const received = Buffer.from(signature.slice(3), 'hex');
  if (!timingSafeEqual(expected, received)) return null;
  try {
    const body: unknown = JSON.parse(typeof rawBody === 'string' ? rawBody : Buffer.from(rawBody).toString('utf8'));
    return { eventId, keyId, timestamp, body };
  } catch {
    return null;
  }
}
