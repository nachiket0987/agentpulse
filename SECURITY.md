# AgentTrace Security Guide

Security model, configuration reference, and hardening checklist for AgentTrace
(v0.1.x). Covers the SDK, CLI, dashboard API, webhooks, and data storage.

---

## Table of Contents

1. [Threat Model](#threat-model)
2. [Architecture: Data Never Leaves by Default](#architecture-data-never-leaves-by-default)
3. [API Key Management](#api-key-management)
4. [Webhook HMAC Signing](#webhook-hmac-signing)
5. [Data at Rest](#data-at-rest)
6. [PII Redaction](#pii-redaction)
7. [Rate Limiting](#rate-limiting)
8. [Dashboard CORS](#dashboard-cors)
9. [Docker / Network Hardening](#docker--network-hardening)
10. [Security Checklist](#security-checklist)
11. [Reporting Vulnerabilities](#reporting-vulnerabilities)

---

## 1. Threat Model

AgentTrace is a **local-first** observability tool. The primary threat vectors are:

| Vector                        | Risk                                                 | Mitigation                                           |
| ----------------------------- | ---------------------------------------------------- | ---------------------------------------------------- |
| Unauthorized dashboard access | Read traces containing prompts/outputs               | API key auth (all `/api/*` except `/api/health`)     |
| Unauthorized trace ingestion  | Injection of fake traces                             | API keys with `write` permission; rate limiting      |
| Database file theft           | Exposure of all trace data (prompts, outputs, costs) | FS-level encryption; file permissions; PII redaction |
| Webhook payload tampering     | Man-in-the-middle on webhook delivery                | HMAC-SHA256 signatures                               |
| Trace flooding / DoS          | Memory/CPU exhaustion from high volume               | Token bucket rate limiter                            |
| Stolen API key replay         | Access to dashboard or trace writes                  | Key rotation; short-lived keys; `lastUsedAt` audit   |

What is **not** a threat by default: AgentTrace makes zero external network calls from the SDK. No telemetry. No phone-home. Data leaves the machine only via explicitly configured webhooks or manual export.

---

## 2. Architecture: Data Never Leaves by Default

```
Agent code
    |
    v
AgentTrace SDK  -->  SQLite (agenttrace.db)
                         |
                    CLI reads from DB
                    Dashboard reads from DB
                         |
               User-configured webhooks only
```

- The SDK writes to a local SQLite file (`./agenttrace.db` by default).
- The CLI and dashboard are thin clients over that file.
- No data is sent anywhere unless you:
  - Call `agent.export()` manually
  - Configure a webhook via `agent.addWebhook()`
  - Run the dashboard on a non-loopback interface

---

## 3. API Key Management

The dashboard REST API protects all `/api/*` routes (except `/api/health`) with
API key authentication via the `X-API-Key` header.

### How Keys Are Generated

```typescript
// SDK (storage.ts) — keys are random 32-byte hex strings
const key = randomBytes(32).toString('hex');
const keyHash = createHash('sha256').update(key).digest('hex');
// Only keyHash is stored in the `api_keys` table.
```

```typescript
// Dashboard (index.ts) — same approach, in-memory store
const plaintextKey = crypto.randomBytes(32).toString('hex');
const hash = crypto.createHash('sha256').update(plaintextKey).digest('hex');
```

### Key Properties

- **Plaintext is shown once** at creation time. It is never stored or logged.
- **Only the SHA-256 hash** is persisted (in the `api_keys` table or in-memory store).
- **Prefix** (first 8 characters) is stored for display purposes.
- **Permissions** are stored as a JSON array: `["read", "write"]` by default.
- **`lastUsedAt`** is updated on each successful authentication for audit trails.
- Keys can be **disabled** or **revoked** (deleted) via the API.

### Creating Keys

```bash
# Via the dashboard API
curl -X POST http://127.0.0.1:4317/api/v1/keys \
  -H "Content-Type: application/json" \
  -H "X-API-Key: <existing-key>" \
  -d '{"name": "ci-pipeline"}'
# Response: { "id": "...", "name": "ci-pipeline", "key": "abc123...", "prefix": "abc12345", ... }
# The "key" field appears ONLY in this response.
```

```typescript
// Via the SDK
const agent = init({ dbPath: './agenttrace.db' });
const { key, id, preview } = agent.createApiKey('my-service');
// Store `key` securely. It cannot be retrieved again.
```

### Listing Keys (no secrets exposed)

```bash
curl http://127.0.0.1:4317/api/v1/keys \
  -H "X-API-Key: <your-key>"
# Response: { "keys": [{ "id": "...", "name": "...", "prefix": "abc12345", "createdAt": ... }] }
# No hashes or plaintext keys are returned.
```

### Revoking Keys

```bash
curl -X DELETE http://127.0.0.1:4317/api/v1/keys/<key-id> \
  -H "X-API-Key: <your-key>"
# 204 No Content on success
```

### Best Practices

1. **Create separate keys** for each service/pipeline (CI, local dev, staging).
2. **Rotate keys regularly** — create a new key, update consumers, revoke the old one.
3. **Never commit keys** to source control. Use environment variables or a secrets manager.
4. **Use the minimum permission scope** — read-only keys for dashboards, write keys only for agents.
5. **Monitor `lastUsedAt`** via `listApiKeys()` to detect stale or compromised keys.

---

## 4. Webhook HMAC Signing

When a webhook is registered with a `secret`, AgentTrace signs every delivery
payload so the receiver can verify authenticity and integrity.

### Signature Algorithm

```
signature = SHA-256(secret + "." + requestBody)
header:    X-AgentTrace-Signature: sha256=<hex-signature>
```

This is implemented in `packages/sdk/src/index.ts` (`triggerWebhook`):

```typescript
if (wh.secret) {
  const sig = createHash('sha256')
    .update(wh.secret + '.' + bodyStr)
    .digest('hex');
  headers['X-AgentTrace-Signature'] = `sha256=${sig}`;
}
```

### Webhook Payload Structure

```json
{
  "event": "trace.complete",
  "timestamp": 1717000000000,
  "runId": "uuid-of-the-run"
}
```

The `event` and `timestamp` fields are always present. Additional fields depend
on the event type:

| Event            | Extra Fields               |
| ---------------- | -------------------------- |
| `trace.complete` | trace metadata             |
| `trace.error`    | trace metadata, error info |
| `run.complete`   | `runId`                    |
| `run.error`      | `runId`                    |
| `cost.threshold` | cost stats                 |
| `agent.inactive` | agent info                 |

### Verifying Signatures (Receiver Side)

```python
import hmac, hashlib, json

def verify_agenttrace_signature(request_body: bytes, signature_header: str, secret: str) -> bool:
    """Verify an AgentTrace webhook signature."""
    if not signature_header.startswith('sha256='):
        return False
    expected_mac = hmac.new(
        secret.encode('utf-8'),
        request_body,
        hashlib.sha256
    ).hexdigest()
    # AgentTrace uses: SHA256(secret + "." + body)
    # Note: the signature is over the concatenation of secret + "." + raw body string
    mac = hmac.new(
        (secret + '.').encode('utf-8'),
        request_body,
        hashlib.sha256
    ).hexdigest()
    return hmac.compare_digest(mac, signature_header[7:])
```

```typescript
// Node.js receiver
import { createHash } from 'node:crypto';

function verifySignature(body: string, signatureHeader: string, secret: string): boolean {
  if (!signatureHeader.startsWith('sha256=')) return false;
  const expected = createHash('sha256')
    .update(secret + '.' + body)
    .digest('hex');
  const actual = signatureHeader.slice(7); // strip "sha256="
  return (
    expected.length === actual.length && timingSafeEqual(Buffer.from(expected), Buffer.from(actual))
  );
}
```

### Best Practices

1. **Always set a webhook secret** — unsigned webhooks can be forged by anyone who knows the URL.
2. **Verify signatures** on the receiver before processing any payload.
3. **Use HTTPS** for webhook URLs in production to prevent MITM attacks.
4. **Check the `timestamp`** to reject stale deliveries (replay protection).
5. **Monitor `failure_count`** — AgentTrack increments it on each failed delivery. Use `getWebhooks()` to audit.

---

## 5. Data at Rest

### What Is Stored

The SQLite database (`agenttrace.db`) contains:

| Table           | Sensitive Content                               |
| --------------- | ----------------------------------------------- |
| `traces`        | Prompts, outputs, token counts, costs, metadata |
| `runs`          | Run names, metadata                             |
| `tool_calls`    | Tool inputs/outputs                             |
| `scores`        | Evaluation scores                               |
| `agent_usage`   | Agent names, actions, tokens, costs             |
| `webhooks`      | URLs, **secrets (plaintext)**, event configs    |
| `api_keys`      | Key hashes (SHA-256), names, permissions        |
| `alerts`        | Alert conditions, webhook URLs                  |
| `alert_history` | Triggered alert snapshots                       |

### Encryption

AgentTrace does **not** implement application-layer encryption. The database is a
standard SQLite file. To protect data at rest:

1. **Filesystem encryption** — Use LUKS (Linux), BitLocker (Windows), or FileVault (macOS) on the volume containing `agenttrace.db`.
2. **SQLite encryption extensions** — Consider SQLCipher or `sqleet` if you need database-level encryption. Replace `better-sqlite3` with a SQLCipher-compatible driver.
3. **Docker volumes** — The named volume (`agenttrace-data`) inherits the host's encryption. Use encrypted volume drivers in production.
4. **Backups** — If you back up `agenttrace.db`, encrypt the backup (e.g., `gpg --symmetric`).

### File Permissions

```bash
# Restrict the database file to the owner only
chmod 600 ./agenttrace.db

# Verify
ls -la ./agenttrace.db
# -rw------- 1 user user ... agenttrace.db
```

### Webhook Secrets in the Database

Webhook secrets are stored **in plaintext** in the `webhooks.secret` column.
This is a known tradeoff: the secret is needed to sign payloads on delivery.
Mitigations:

- Restrict filesystem access to the database (see above).
- Use a dedicated webhook receiver URL per environment.
- Rotate webhook secrets periodically.

---

## 6. PII Redaction

AgentTrace does **not** perform automatic PII redaction. Traces store whatever
your agent passes as `input` and `output`. If your agents handle PII (emails,
phone numbers, API keys, wallet addresses, etc.), you must redact **before**
calling `agent.trace()`.

### Recommended Approach: Pre-Trace Redaction

```typescript
import { init } from '@agenttrace-io/sdk';

const agent = init({ dbPath: './agenttrace.db' });

function redactPII(text: string): string {
  return text
    .replace(/[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}/g, '[EMAIL]')
    .replace(/\b\d{3}[-.]?\d{3}[-.]?\d{4}\b/g, '[PHONE]')
    .replace(/\b0x[a-fA-F0-9]{40}\b/g, '[ETH_ADDRESS]')
    .replace(/sk-[a-zA-Z0-9]{20,}/g, '[API_KEY]');
}

const result = await agent.trace(
  'llm-call',
  async () => {
    return await callLLM(userInput);
  },
  {
    input: redactPII(userInput), // redact before storage
    // output is captured automatically — redact it too if needed
  },
);
```

### Post-Hoc Scorer for PII Detection

Use the evaluation framework to detect PII in existing traces:

```typescript
const piiScorer = {
  name: 'pii-detection',
  fn: (trace: Trace) => {
    const text = JSON.stringify(trace.output || '');
    const hasEmail = /[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}/.test(text);
    const hasKey = /sk-[a-zA-Z0-9]{20,}/.test(text);
    return hasEmail || hasKey ? 0 : 1; // 0 = PII found, 1 = clean
  },
};

agent.evaluate({ scorers: [piiScorer] });
```

### Best Practices

1. **Redact at the source** — sanitize inputs/outputs before they reach `agent.trace()`.
2. **Use metadata for sensitive context** — store non-sensitive metadata in `trace.metadata` instead of `input`/`output`.
3. **Set retention policies** — use `retentionDays` in `TraceConfig` to auto-purge old traces containing PII.
4. **Audit with scorers** — run PII detection scorers periodically on existing traces.

---

## 7. Rate Limiting

AgentTrace includes a **token bucket rate limiter** to prevent trace flooding from
compromised or misbehaving agents.

### Configuration

```typescript
import { init } from '@agenttrace-io/sdk';

const agent = init({
  dbPath: './agenttrace.db',
  maxTracesPerSecond: 100, // sustained rate (0 = disabled)
  maxTracesPerMinute: 3000, // sustained rate (0 = disabled)
  burstAllowance: 50, // extra tokens above sustained rate
});
```

### How It Works

The rate limiter uses **two token buckets** — one per-second, one per-minute:

- **Per-second bucket**: refills at `maxTracesPerSecond / 1000` tokens per ms.
- **Per-minute bucket**: refills at `maxTracesPerMinute / 60000` tokens per ms.
- **Burst allowance**: extra tokens available immediately (for traffic spikes).
- A trace is recorded only if **both** buckets have tokens available.
- When rate-limited, the function still executes but the trace is **not recorded**.

```typescript
// Check how many traces were dropped
const dropped = agent.getDroppedTraces();
console.log(`Dropped ${dropped} traces due to rate limiting`);
```

### Defaults

All rate limits default to **0 (disabled)**. This means unlimited tracing by
default. Enable rate limiting in production:

```typescript
// Conservative production config
const agent = init({
  maxTracesPerSecond: 50,
  maxTracesPerMinute: 1000,
  burstAllowance: 25,
});
```

### Best Practices

1. **Enable rate limiting** in any environment shared by multiple agents.
2. **Monitor `getDroppedTraces()`** — a rising count indicates misbehaving agents or the need to raise limits.
3. **Set per-tenant limits** — use `tenantId` in `TraceConfig` for multi-tenant isolation (the `rate_limit_log` table tracks drops per tenant).
4. **Combine with retention** — rate limiting + `retentionDays` provides defense in depth against storage exhaustion.

---

## 8. Dashboard CORS

The dashboard server binds to `127.0.0.1:4317` by default (loopback only).
It does **not** set CORS headers — this is intentional. The dashboard is designed
for local access only.

### If You Need Cross-Origin Access

If you must serve the dashboard on a non-loopback interface or behind a reverse
proxy, add CORS middleware at the infrastructure layer:

```nginx
# Nginx reverse proxy example
server {
    listen 443 ssl;
    server_name agenttrace.internal.example.com;

    location /api/ {
        proxy_pass http://127.0.0.1:4317;
        proxy_set_header Host $host;

        # Restrict origins
        add_header 'Access-Control-Allow-Origin' 'https://app.example.com' always;
        add_header 'Access-Control-Allow-Methods' 'GET, POST, DELETE, OPTIONS' always;
        add_header 'Access-Control-Allow-Headers' 'Content-Type, X-API-Key' always;

        if ($request_method = OPTIONS) {
            return 204;
        }
    }
}
```

### Security Implications

- **Do not** expose the dashboard to the public internet without authentication and TLS.
- The dashboard has **no CSRF protection** — if you enable CORS, also implement CSRF tokens at the proxy layer.
- API keys are sent via the `X-API-Key` header, which is safe from CSRF (not a cookie).

---

## 9. Docker / Network Hardening

### Default Docker Configuration

```yaml
# docker-compose.yml (default)
services:
  agenttrace:
    ports:
      - '4317:4317' # binds to 0.0.0.0 — accessible from network
    volumes:
      - agenttrace-data:/app/data
```

### Hardened Configuration

```yaml
services:
  agenttrace:
    ports:
      - '127.0.0.1:4317:4317' # loopback only
    volumes:
      - agenttrace-data:/app/data
    read-only: true # read-only root filesystem
    user: '1000:1000' # non-root user
    security_opt:
      - no-new-privileges:true
    cap_drop:
      - ALL
    tmpfs:
      - /tmp:size=64M
    environment:
      - AGENTTRACE_DB_PATH=/app/data/agenttrace.db
      - NODE_ENV=production
```

### Network Policies

- Use Docker network isolation: `internal: true` on the network if no external access is needed.
- Place behind a reverse proxy (nginx, Caddy) for TLS termination.
- Use firewall rules to restrict port 4317 to trusted IPs only.

---

## 10. Security Checklist

Use this checklist when deploying AgentTrace in any environment beyond local
development:

### Data Protection

- [ ] Filesystem encryption enabled on the volume containing `agenttrace.db`
- [ ] Database file permissions set to `600` (owner read/write only)
- [ ] PII redaction implemented before calling `agent.trace()`
- [ ] Retention policy configured (`retentionDays > 0`)
- [ ] Backups encrypted if `agenttrace.db` is backed up

### Authentication & Access

- [ ] API keys created for each consumer (no shared keys)
- [ ] API keys stored in environment variables, not source code
- [ ] Unused/stale API keys revoked
- [ ] Dashboard bound to loopback (`127.0.0.1`) or behind authenticated reverse proxy
- [ ] TLS enabled if dashboard is accessible over a network

### Webhooks

- [ ] Webhook secrets set for all configured webhooks
- [ ] Signature verification implemented on the receiver side
- [ ] HTTPS used for all webhook URLs
- [ ] Webhook failure counts monitored

### Rate Limiting

- [ ] Rate limiting enabled (`maxTracesPerSecond > 0` or `maxTracesPerMinute > 0`)
- [ ] `getDroppedTraces()` monitored for anomalies
- [ ] Per-tenant `tenantId` set in multi-tenant deployments

### Docker / Infrastructure

- [ ] Container runs as non-root user
- [ ] Read-only root filesystem
- [ ] No unnecessary capabilities
- [ ] Network access restricted (internal networks, firewall rules)
- [ ] Health check configured (`/api/health`)

---

## 11. Reporting Vulnerabilities

If you find a security vulnerability in AgentTrace:

1. **Do not** open a public GitHub issue with exploit details.
2. Open a GitHub issue at `github.com/Klepsiphron/agenttrace` with the `security` label.
3. Include: affected version, description, reproduction steps, and suggested fix if available.
4. We will respond within 48 hours.

---

_Last updated: 2026-06-02 | AgentTrace v0.1.x_
