import { createSign } from 'node:crypto';
import http2 from 'node:http2';
import type { Device } from '../store/types.js';

export interface PushMessage {
  /** Visible alert. Omit for a silent, content-available push. */
  alert?: { title: string; body: string };
  /** Custom payload, delivered next to "aps". */
  data?: Record<string, unknown>;
}

export interface PushResult {
  sent: number;
  /** Tokens APNs reported as no longer valid (410 Unregistered, 400 BadDeviceToken). */
  invalidTokens: string[];
  failures: { token: string; status: number; reason: string }[];
}

export interface PushSender {
  send(devices: Device[], message: PushMessage): Promise<PushResult>;
}

/** Used when APNs is not configured: logs nothing, sends nothing. */
export class NoopPushSender implements PushSender {
  async send(): Promise<PushResult> {
    return { sent: 0, invalidTokens: [], failures: [] };
  }
}

export interface ApnsOptions {
  keyId: string;
  teamId: string;
  p8: string;
  bundleId: string;
}

const HOSTS = {
  sandbox: 'https://api.sandbox.push.apple.com',
  production: 'https://api.push.apple.com',
} as const;

/** APNs provider token (ES256 JWT). Apple accepts a token for up to 60 minutes. */
export function apnsProviderToken(opts: ApnsOptions, nowMs: number = Date.now()): string {
  const b64 = (o: unknown) => Buffer.from(JSON.stringify(o)).toString('base64url');
  const unsigned = `${b64({ alg: 'ES256', kid: opts.keyId })}.${b64({
    iss: opts.teamId,
    iat: Math.floor(nowMs / 1000),
  })}`;
  const signature = createSign('SHA256')
    .update(unsigned)
    .sign({ key: opts.p8, dsaEncoding: 'ieee-p1363' })
    .toString('base64url');
  return `${unsigned}.${signature}`;
}

export function buildApnsPayload(message: PushMessage): Record<string, unknown> {
  const aps: Record<string, unknown> = message.alert
    ? { alert: message.alert, sound: 'default' }
    : { 'content-available': 1 };
  return { aps, ...(message.data ?? {}) };
}

/** Sends pushes over HTTP/2 with token-based auth. */
export class ApnsPushSender implements PushSender {
  private token: { value: string; issuedAt: number } | null = null;

  constructor(private readonly opts: ApnsOptions) {}

  private providerToken(): string {
    const now = Date.now();
    // Refresh every 45 minutes, inside Apple's 20-60 minute window.
    if (!this.token || now - this.token.issuedAt > 45 * 60 * 1000) {
      this.token = { value: apnsProviderToken(this.opts, now), issuedAt: now };
    }
    return this.token.value;
  }

  async send(devices: Device[], message: PushMessage): Promise<PushResult> {
    const result: PushResult = { sent: 0, invalidTokens: [], failures: [] };
    const body = JSON.stringify(buildApnsPayload(message));
    const silent = !message.alert;

    for (const environment of ['sandbox', 'production'] as const) {
      const batch = devices.filter((d) => d.environment === environment);
      if (!batch.length) continue;
      const client = http2.connect(HOSTS[environment]);
      client.on('error', () => undefined);
      try {
        for (const device of batch) {
          const res = await this.post(client, device.apnsToken, body, silent);
          if (res.status === 200) result.sent += 1;
          else if (res.status === 410 || res.reason === 'BadDeviceToken') {
            result.invalidTokens.push(device.apnsToken);
          } else result.failures.push({ token: device.apnsToken, ...res });
        }
      } finally {
        client.close();
      }
    }
    return result;
  }

  private post(
    client: http2.ClientHttp2Session,
    deviceToken: string,
    body: string,
    silent: boolean,
  ): Promise<{ status: number; reason: string }> {
    return new Promise((resolve) => {
      const req = client.request({
        ':method': 'POST',
        ':path': `/3/device/${deviceToken}`,
        authorization: `bearer ${this.providerToken()}`,
        'apns-topic': this.opts.bundleId,
        'apns-push-type': silent ? 'background' : 'alert',
        'apns-priority': silent ? '5' : '10',
        'content-type': 'application/json',
      });
      let status = 0;
      let data = '';
      req.setEncoding('utf8');
      req.on('response', (headers) => {
        status = Number(headers[':status'] ?? 0);
      });
      req.on('data', (chunk: string) => {
        data += chunk;
      });
      req.on('end', () => {
        let reason = '';
        try {
          reason = data ? ((JSON.parse(data) as { reason?: string }).reason ?? '') : '';
        } catch {
          reason = data;
        }
        resolve({ status, reason });
      });
      req.on('error', (err) => resolve({ status: 0, reason: err.message }));
      req.setTimeout(10_000, () => {
        req.close();
        resolve({ status: 0, reason: 'timeout' });
      });
      req.end(body);
    });
  }
}
