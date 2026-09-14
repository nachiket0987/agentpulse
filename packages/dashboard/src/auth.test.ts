import { describe, it, expect, afterEach } from 'vitest';
import { createDashboardApp, createApiKey, apiKeyStore } from './index.ts';
import * as http from 'node:http';
import type { AddressInfo } from 'node:net';
import type { Express } from 'express';
import { createHash } from 'node:crypto';

function getServerPort(server: http.Server): number {
  const addr = server.address();
  if (addr && typeof addr === 'object' && 'port' in addr) {
    return ((addr as AddressInfo).port as number) || 0;
  }
  return 0;
}

describe('API key authentication', () => {
  let servers: http.Server[] = [];
  let closes: Array<() => void> = [];

  afterEach(() => {
    servers.forEach((s) => {
      try {
        s.close();
      } catch (_) {
        /* ignore */
      }
    });
    closes.forEach((c) => {
      try {
        c();
      } catch (_) {
        /* ignore */
      }
    });
    servers = [];
    closes = [];
    apiKeyStore.clear();
  });

  async function startTemp(app: Express): Promise<{ port: number; base: string }> {
    const server = app.listen(0);
    servers.push(server);
    const port = getServerPort(server);
    await new Promise((r) => setTimeout(r, 5));
    return { port, base: `http://127.0.0.1:${port}` };
  }

  describe('auth middleware (localhost = no auth)', () => {
    it('GET /api/health works without API key', async () => {
      const { app, close } = createDashboardApp(':memory:');
      closes.push(close);
      const { base } = await startTemp(app);
      const res = await fetch(`${base}/api/health`);
      expect(res.status).not.toBe(401);
      const data = await res.json();
      expect(data.status).toMatch(/healthy|degraded|unhealthy/);
      expect(data.checks).toBeTruthy();
    });

    it('GET /api/stats works without API key on localhost', async () => {
      const { app, close } = createDashboardApp(':memory:');
      closes.push(close);
      const { base } = await startTemp(app);
      const res = await fetch(`${base}/api/stats`);
      expect(res.status).toBe(200);
    });

    it('GET /api/stats returns 200 with valid API key', async () => {
      const { app, close } = createDashboardApp(':memory:');
      closes.push(close);
      const { plaintextKey } = createApiKey('test-key');
      const { base } = await startTemp(app);
      const res = await fetch(`${base}/api/stats`, {
        headers: { 'X-API-Key': plaintextKey },
      });
      expect(res.status).toBe(200);
    });

    it('returns 401 with invalid API key', async () => {
      const { app, close } = createDashboardApp(':memory:');
      closes.push(close);
      const { base } = await startTemp(app);
      const res = await fetch(`${base}/api/stats`, {
        headers: { 'X-API-Key': 'totally-invalid-key' },
      });
      expect(res.status).toBe(401);
    });

    it('static assets are served without auth', async () => {
      const { app, close } = createDashboardApp(':memory:');
      closes.push(close);
      const { base } = await startTemp(app);
      const res = await fetch(`${base}/`);
      expect(res.status).not.toBe(401);
    });
  });

  describe('POST /api/v1/keys (create)', () => {
    it('creates a new API key and returns plaintext once', async () => {
      const { app, close } = createDashboardApp(':memory:');
      closes.push(close);
      const { base } = await startTemp(app);
      // On localhost, no auth needed to create first key
      const res = await fetch(`${base}/api/v1/keys`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name: 'my-test-key' }),
      });
      expect(res.status).toBe(201);
      const data = await res.json();
      expect(data.id).toBeTruthy();
      expect(data.name).toBe('my-test-key');
      expect(data.key).toBeTruthy();
      expect(data.key.length).toBe(64);
      expect(data.prefix).toBe(data.key.slice(0, 8));
      expect(typeof data.createdAt).toBe('number');
    });

    it('creates key with default name when name is omitted', async () => {
      const { app, close } = createDashboardApp(':memory:');
      closes.push(close);
      const { base } = await startTemp(app);
      const res = await fetch(`${base}/api/v1/keys`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({}),
      });
      expect(res.status).toBe(201);
      const data = await res.json();
      expect(data.name).toBe('default');
    });

    it('newly created key works for authentication', async () => {
      const { app, close } = createDashboardApp(':memory:');
      closes.push(close);
      const { base } = await startTemp(app);
      const createRes = await fetch(`${base}/api/v1/keys`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name: 'child-key' }),
      });
      const created = await createRes.json();
      const statsRes = await fetch(`${base}/api/stats`, {
        headers: { 'X-API-Key': created.key },
      });
      expect(statsRes.status).toBe(200);
    });
  });

  describe('GET /api/v1/keys (list)', () => {
    it('lists all keys without exposing hashes', async () => {
      const { app, close } = createDashboardApp(':memory:');
      closes.push(close);
      createApiKey('key-one');
      createApiKey('key-two');
      const { base } = await startTemp(app);
      const res = await fetch(`${base}/api/v1/keys`);
      expect(res.status).toBe(200);
      const data = await res.json();
      expect(data.keys).toBeTruthy();
      expect(data.keys.length).toBe(2);
      for (const key of data.keys) {
        expect(key.id).toBeTruthy();
        expect(key.name).toBeTruthy();
        expect(key.prefix).toBeTruthy();
        expect(key.prefix.length).toBe(8);
        expect(typeof key.createdAt).toBe('number');
        expect(key.hash).toBeUndefined();
        expect(key.key).toBeUndefined();
      }
    });
  });

  describe('DELETE /api/v1/keys/:id (revoke)', () => {
    it('revokes an existing key', async () => {
      const { app, close } = createDashboardApp(':memory:');
      closes.push(close);
      const { base } = await startTemp(app);
      const targetRes = await fetch(`${base}/api/v1/keys`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name: 'to-be-revoked' }),
      });
      const target = await targetRes.json();

      const beforeRes = await fetch(`${base}/api/stats`, {
        headers: { 'X-API-Key': target.key },
      });
      expect(beforeRes.status).toBe(200);

      const deleteRes = await fetch(`${base}/api/v1/keys/${target.id}`, {
        method: 'DELETE',
      });
      expect(deleteRes.status).toBe(204);

      const afterRes = await fetch(`${base}/api/stats`, {
        headers: { 'X-API-Key': target.key },
      });
      expect(afterRes.status).toBe(401);
    });

    it('returns 404 for non-existent key id', async () => {
      const { app, close } = createDashboardApp(':memory:');
      closes.push(close);
      const { base } = await startTemp(app);
      const res = await fetch(`${base}/api/v1/keys/nonexistent-id`, {
        method: 'DELETE',
      });
      expect(res.status).toBe(404);
      const data = await res.json();
      expect(data.code).toBe('NOT_FOUND');
    });
  });

  describe('key storage', () => {
    it('keys are stored as SHA-256 hashes, not plaintext', () => {
      const { record, plaintextKey } = createApiKey('hash-test');
      const expectedHash = createHash('sha256').update(plaintextKey).digest('hex');
      expect(record.hash).toBe(expectedHash);
      expect(apiKeyStore.get(expectedHash)).toBe(record);
      expect(record.hash).not.toBe(plaintextKey);
    });

    it('prefix is first 8 characters of the key', () => {
      const { record, plaintextKey } = createApiKey('prefix-test');
      expect(record.prefix).toBe(plaintextKey.slice(0, 8));
    });
  });
});
