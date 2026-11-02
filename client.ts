import { randomUUID } from 'node:crypto';
export class BrokerClient {
  constructor(private base: string, private token: string, private signal?: AbortSignal) {
    const url = new URL(base);
    if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.search || url.hash) throw new Error('PHEME_URL must be an HTTP(S) broker origin');
  }
  async call<T>(path: string, data?: unknown, key = randomUUID()): Promise<T> {
    // Reuse the same key for all transport retries, including an ambiguous commit.
    for (let attempt = 0; ; attempt++) {
      try {
        const res = await fetch(new URL(path, this.base), {
          method: data === undefined ? 'GET' : 'POST',
          headers: { Authorization: `Bearer ${this.token}`, 'Content-Type': 'application/json', 'Idempotency-Key': key },
          ...(data === undefined ? {} : { body: JSON.stringify(data) }),
          signal: AbortSignal.any([AbortSignal.timeout(35_000), ...(this.signal ? [this.signal] : [])]), redirect: 'error'
        });
        const value = await res.json();
        if (!res.ok) throw new ApiError(res.status, value.error ?? 'Broker request failed');
        return value as T;
      } catch (err) {
        if (err instanceof ApiError || this.signal?.aborted || attempt >= 2) throw err;
        await new Promise(resolve => setTimeout(resolve, 250 * 2 ** attempt));
      }
    }
  }
}
export class ApiError extends Error { constructor(public status: number, message: string) { super(message); } }
