import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { AgentTrace } from './index.js';

// Mock global fetch
const mockFetch = vi.fn();
global.fetch = mockFetch;

function createClient(dbPath: string = ':memory:') {
  return new AgentTrace({ dbPath, silent: true });
}

describe('Webhook Management', () => {
  let client: AgentTrace;

  beforeEach(() => {
    mockFetch.mockReset();
    client = createClient();
  });

  afterEach(() => {
    client.close();
  });

  describe('registerWebhook', () => {
    it('should register a webhook and return an id', () => {
      const id = client.registerWebhook('https://example.com/hook', ['trace.complete']);
      expect(id).toBeDefined();
      expect(typeof id).toBe('string');
      expect(id.length).toBeGreaterThan(0);
    });

    it('should register a webhook with a secret', () => {
      const id = client.registerWebhook(
        'https://example.com/hook',
        ['trace.complete', 'run.complete'],
        'my-secret',
      );
      expect(id).toBeDefined();
      const webhooks = client.getWebhooks();
      expect(webhooks).toHaveLength(1);
      expect(webhooks[0].secret).toBe('my-secret');
    });

    it('should register a webhook without a secret', () => {
      const id = client.registerWebhook('https://example.com/hook', ['trace.complete']);
      expect(id).toBeDefined();
      const webhooks = client.getWebhooks();
      expect(webhooks).toHaveLength(1);
      expect(webhooks[0].secret).toBeUndefined();
    });

    it('should register multiple webhooks', () => {
      client.registerWebhook('https://example.com/hook1', ['trace.complete']);
      client.registerWebhook('https://example.com/hook2', ['run.complete']);
      client.registerWebhook('https://example.com/hook3', ['trace.error']);
      const webhooks = client.getWebhooks();
      expect(webhooks).toHaveLength(3);
    });
  });

  describe('getWebhooks', () => {
    it('should return empty array when no webhooks registered', () => {
      const webhooks = client.getWebhooks();
      expect(webhooks).toEqual([]);
    });

    it('should return all registered webhooks with correct shape', () => {
      client.registerWebhook(
        'https://example.com/hook',
        ['trace.complete', 'run.complete'],
        'secret123',
      );
      const webhooks = client.getWebhooks();
      expect(webhooks).toHaveLength(1);
      const wh = webhooks[0];
      expect(wh).toMatchObject({
        url: 'https://example.com/hook',
        secret: 'secret123',
        events: ['trace.complete', 'run.complete'],
        enabled: true,
      });
      expect(wh.id).toBeDefined();
      expect(wh.createdAt).toBeDefined();
      expect(wh.failureCount).toBe(0);
    });
  });

  describe('deleteWebhook', () => {
    it('should delete a webhook by id', () => {
      const id = client.registerWebhook('https://example.com/hook', ['trace.complete']);
      expect(client.getWebhooks()).toHaveLength(1);
      client.deleteWebhook(id);
      expect(client.getWebhooks()).toHaveLength(0);
    });

    it('should not throw when deleting non-existent webhook', () => {
      expect(() => client.deleteWebhook('non-existent-id')).not.toThrow();
    });

    it('should only delete the specified webhook', () => {
      const id1 = client.registerWebhook('https://example.com/hook1', ['trace.complete']);
      const id2 = client.registerWebhook('https://example.com/hook2', ['run.complete']);
      client.deleteWebhook(id1);
      const webhooks = client.getWebhooks();
      expect(webhooks).toHaveLength(1);
      expect(webhooks[0].id).toBe(id2);
    });
  });

  describe('triggerWebhook', () => {
    it('should call fetch for matching webhooks', async () => {
      mockFetch.mockResolvedValueOnce(new Response('ok', { status: 200 }));
      client.registerWebhook('https://example.com/hook', ['trace.complete']);
      const results = await client.triggerWebhook('trace.complete', { traceId: 't1' });
      expect(results).toHaveLength(1);
      expect(mockFetch).toHaveBeenCalledTimes(1);
      expect(mockFetch).toHaveBeenCalledWith(
        'https://example.com/hook',
        expect.objectContaining({
          method: 'POST',
          headers: expect.objectContaining({
            'Content-Type': 'application/json',
          }),
        }),
      );
    });

    it('should not call fetch for non-matching events', async () => {
      client.registerWebhook('https://example.com/hook', ['trace.complete']);
      const results = await client.triggerWebhook('run.complete', { runId: 'r1' });
      expect(results).toHaveLength(0);
      expect(mockFetch).not.toHaveBeenCalled();
    });

    it('should include signature header when secret is set', async () => {
      mockFetch.mockResolvedValueOnce(new Response('ok', { status: 200 }));
      client.registerWebhook('https://example.com/hook', ['trace.complete'], 'my-secret');
      await client.triggerWebhook('trace.complete', { traceId: 't1' });
      const callArgs = mockFetch.mock.calls[0];
      const headers = callArgs[1].headers;
      expect(headers['X-AgentTrace-Signature']).toBeDefined();
      expect(headers['X-AgentTrace-Signature']).toMatch(/^sha256=[a-f0-9]{64}$/);
    });

    it('should not include signature header when no secret', async () => {
      mockFetch.mockResolvedValueOnce(new Response('ok', { status: 200 }));
      client.registerWebhook('https://example.com/hook', ['trace.complete']);
      await client.triggerWebhook('trace.complete', { traceId: 't1' });
      const callArgs = mockFetch.mock.calls[0];
      const headers = callArgs[1].headers;
      expect(headers['X-AgentTrace-Signature']).toBeUndefined();
    });

    it('should return delivery results with correct shape', async () => {
      mockFetch.mockResolvedValueOnce(new Response('ok', { status: 200 }));
      client.registerWebhook('https://example.com/hook', ['trace.complete']);
      const results = await client.triggerWebhook('trace.complete', { traceId: 't1' });
      expect(results).toHaveLength(1);
      const delivery = results[0];
      expect(delivery).toMatchObject({
        webhookId: expect.any(String),
        event: 'trace.complete',
        status: 'success',
        httpStatus: 200,
        createdAt: expect.any(Number),
      });
      expect(delivery.id).toBeDefined();
      expect(delivery.payload).toBeDefined();
    });

    it('should handle fetch failure gracefully', async () => {
      mockFetch.mockRejectedValueOnce(new Error('Connection refused'));
      client.registerWebhook('https://example.com/hook', ['trace.complete']);
      const results = await client.triggerWebhook('trace.complete', { traceId: 't1' });
      expect(results).toHaveLength(1);
      expect(results[0].status).toBe('failure');
      expect(results[0].error).toBe('Connection refused');
    });

    it('should handle non-ok HTTP response', async () => {
      mockFetch.mockResolvedValueOnce(new Response('error', { status: 500 }));
      client.registerWebhook('https://example.com/hook', ['trace.complete']);
      const results = await client.triggerWebhook('trace.complete', { traceId: 't1' });
      expect(results).toHaveLength(1);
      expect(results[0].status).toBe('failure');
      expect(results[0].httpStatus).toBe(500);
    });

    it('should trigger multiple matching webhooks', async () => {
      mockFetch
        .mockResolvedValueOnce(new Response('ok', { status: 200 }))
        .mockResolvedValueOnce(new Response('ok', { status: 201 }));
      client.registerWebhook('https://example.com/hook1', ['trace.complete']);
      client.registerWebhook('https://example.com/hook2', ['trace.complete', 'run.complete']);
      const results = await client.triggerWebhook('trace.complete', { traceId: 't1' });
      expect(results).toHaveLength(2);
      expect(mockFetch).toHaveBeenCalledTimes(2);
    });

    it('should include event and timestamp in payload', async () => {
      mockFetch.mockResolvedValueOnce(new Response('ok', { status: 200 }));
      client.registerWebhook('https://example.com/hook', ['trace.complete']);
      await client.triggerWebhook('trace.complete', { traceId: 't1', extra: 'data' });
      const callArgs = mockFetch.mock.calls[0];
      const body = JSON.parse(callArgs[1].body);
      expect(body.event).toBe('trace.complete');
      expect(body.timestamp).toBeDefined();
      expect(body.traceId).toBe('t1');
      expect(body.extra).toBe('data');
    });
  });

  describe('webhook event emission on trace.complete', () => {
    it('should trigger trace.complete webhook after successful trace', async () => {
      mockFetch.mockResolvedValue(new Response('ok', { status: 200 }));
      client.registerWebhook('https://example.com/hook', ['trace.complete']);
      client.startRun('test-run');
      await client.trace('test-op', async () => 'result');
      client.completeRun();
      // Wait for fire-and-forget webhook
      await new Promise((r) => setTimeout(r, 50));
      expect(mockFetch).toHaveBeenCalled();
      const callArgs = mockFetch.mock.calls[0];
      const body = JSON.parse(callArgs[1].body);
      expect(body.event).toBe('trace.complete');
      expect(body.name).toBe('test-op');
    });

    it('should trigger trace.error webhook after failed trace', async () => {
      mockFetch.mockResolvedValue(new Response('ok', { status: 200 }));
      client.registerWebhook('https://example.com/hook', ['trace.error']);
      client.startRun('test-run');
      try {
        await client.trace('test-op', async () => {
          throw new Error('fail');
        });
      } catch (_) {
        /* expected */
      }
      client.completeRun();
      // Wait for fire-and-forget webhook
      await new Promise((r) => setTimeout(r, 50));
      expect(mockFetch).toHaveBeenCalled();
      const callArgs = mockFetch.mock.calls[0];
      const body = JSON.parse(callArgs[1].body);
      expect(body.event).toBe('trace.error');
      expect(body.error).toBe('fail');
    });
  });

  describe('webhook event emission on run.complete', () => {
    it('should trigger run.complete webhook after successful run', async () => {
      mockFetch.mockResolvedValue(new Response('ok', { status: 200 }));
      client.registerWebhook('https://example.com/hook', ['run.complete']);
      const runId = client.startRun('test-run');
      client.completeRun('success');
      // Wait for fire-and-forget webhook
      await new Promise((r) => setTimeout(r, 50));
      expect(mockFetch).toHaveBeenCalled();
      const callArgs = mockFetch.mock.calls[0];
      const body = JSON.parse(callArgs[1].body);
      expect(body.event).toBe('run.complete');
      expect(body.runId).toBe(runId);
    });

    it('should trigger run.error webhook after failed run', async () => {
      mockFetch.mockResolvedValue(new Response('ok', { status: 200 }));
      client.registerWebhook('https://example.com/hook', ['run.error']);
      client.startRun('test-run');
      client.completeRun('error');
      // Wait for fire-and-forget webhook
      await new Promise((r) => setTimeout(r, 50));
      expect(mockFetch).toHaveBeenCalled();
      const callArgs = mockFetch.mock.calls[0];
      const body = JSON.parse(callArgs[1].body);
      expect(body.event).toBe('run.error');
    });
  });
});
