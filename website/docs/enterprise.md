# AgentTrace for Enterprise & Governance

AI agents are increasingly part of regulated workflows, customer support, research pipelines, and internal automation. When agents spend real money and make real decisions, observability becomes a governance requirement — not just a debugging convenience.

AgentTrace was built from day one with local-first, auditable, cost-aware tracing. It gives organizations the visibility they need without forcing data into a third-party cloud.

---

## Why Observability Matters for AI Governance

- **Cost control at scale** — Agents can easily burn thousands of dollars in tokens through loops, retries, bad routing, or expensive model choices. You need per-agent, per-run, per-day attribution.
- **Audit & compliance** — Regulated industries (finance, healthcare, legal) require records of what the system did, when, with what inputs/outputs, and at what cost. Full trace history + export (JSON/CSV/OTEL) provides the paper trail.
- **Incident response** — When an agent hallucinates, loops, or produces harmful output, you need the complete execution tree (including tool calls and sub-agents) to debug and demonstrate root cause.
- **Budget accountability** — Finance teams and engineering leads need to know _which_ agent or feature is driving spend before they can set meaningful guardrails.

---

## Token Budget Management

AgentTrace gives you:

- Real-time and historical cost by model, by day, and by run
- `getCostBreakdown()` + CLI `costs --daily`
- Self-tracked usage (`self-stats`, `recordAgentUsage`) for meta-agents
- Alert conditions on `totalCostUsd`, error rate, or any computed stat
- Webhook delivery on `cost.threshold` (or any custom event) with optional HMAC signatures

Retention policies (`setRetentionPolicy(90)`) let you keep detailed history for the periods auditors care about while automatically pruning older data.

---

## Per-Agent Cost Attribution

Traditional request-level gateways give you model spend. AgentTrace gives you **agent-level** spend:

- Every trace belongs to a run and can carry `metadata` (user, team, feature flag, customer tier, etc.)
- Hierarchical trees via `createChild()` / `parentId` + `getTraceTree()` show exactly which sub-agent or tool was expensive
- `recordAgentUsage()` lets agents log their own high-level actions with token and cost impact
- CLI commands `who`, `cost --agent`, `sessions`, and `activity` surface this data

---

## Compliance & Audit Trails

- Everything is stored in a local SQLite file (`agenttrace.db`) that you control.
- No data is sent anywhere unless you explicitly call `export()` or configure webhooks.
- Export formats: JSON (full fidelity), CSV (for spreadsheets / BI tools), OTEL (vendor-neutral).
- Webhook history and alert history are persisted and queryable.
- `getHealth()` + storage stats give you integrity signals for the backing database.
- All webhook deliveries (including failures) are recorded with timestamps and error messages.

For air-gapped or highly sensitive environments, run the entire stack inside your VPC or on developer laptops with no external network calls except the ones your agents already make.

---

## Team Dashboards & Collaboration

The local dashboard (`agenttrace dashboard`) is zero-config and private by default. For teams:

- Share a single `agenttrace.db` via a network filesystem, Docker volume, or a small internal server.
- Use the Team plan hosted dashboard (when available) for browser-based access with role separation.
- API keys (`createApiKey`) let you expose a read/write surface without checking the raw DB file into git.
- Multi-project support (`createProject`) provides lightweight tenant isolation.

---

## Enterprise Features (Free vs Team vs Enterprise)

| Capability                               | Free (OSS)   | Team           | Enterprise               |
| ---------------------------------------- | ------------ | -------------- | ------------------------ |
| Local SQLite + CLI + Dashboard           | Full         | Full           | Full + air-gapped        |
| All SDK tracing, alerts, webhooks, trees | Full         | Full           | Full                     |
| Self-hosted dashboard                    | Yes          | Yes            | Yes + air-gapped support |
| Hosted team dashboard                    | —            | Yes            | Yes                      |
| SSO / SCIM / advanced RBAC               | —            | —              | Yes                      |
| Audit log export pipelines               | Manual       | Enhanced       | Full + OTEL streaming    |
| Retention & legal hold                   | Basic        | Extended       | Custom policies          |
| Dedicated support & SLA                  | Community    | Priority email | Dedicated + SLA          |
| On-prem / VPC deployment                 | Self-managed | —              | Supported                |
| Professional services                    | —            | —              | Available                |
| Volume licensing & custom model cards    | —            | —              | Available                |

**Contact Sales** for custom model rate cards, fine-grained cost center reporting, or integration with internal identity providers.

---

## ROI Calculator — How much are you spending on AI tokens?

Use the simple calculator below (when viewed as HTML) or plug your own numbers:

```html
<!-- Interactive ROI calculator (paste into any HTML viewer) -->
<div
  id="roi"
  style="background:#111113;border:1px solid #242429;border-radius:8px;padding:16px 18px;max-width:520px"
>
  <div style="font-size:12px;color:#9a9aa0;margin-bottom:8px">MONTHLY TOKEN SPEND ESTIMATOR</div>
  <label style="display:block;font-size:12px;margin:8px 0 4px">Avg daily tokens (all agents)</label>
  <input
    id="tokens"
    type="number"
    value="1200000"
    style="width:100%;padding:8px;background:#0a0a0c;border:1px solid #242429;color:#e8e8eb;border-radius:6px"
  />
  <label style="display:block;font-size:12px;margin:8px 0 4px"
    >Avg cost per 1k tokens (blended)</label
  >
  <input
    id="rate"
    type="number"
    step="0.0001"
    value="0.003"
    style="width:100%;padding:8px;background:#0a0a0c;border:1px solid #242429;color:#e8e8eb;border-radius:6px"
  />
  <div style="margin-top:12px;font-size:13px">
    Estimated monthly spend: <strong id="monthly">$—</strong><br />
    With 18% waste from loops/retries: <strong id="waste">$—</strong><br />
    <span style="color:#22c55e"
      >Potential savings with AgentTrace visibility: <strong id="savings">$—</strong>/mo</span
    >
  </div>
</div>
<script>
  (function () {
    function calc() {
      var t = parseFloat(document.getElementById('tokens').value) || 0;
      var r = parseFloat(document.getElementById('rate').value) || 0;
      var monthly = (t / 1000) * r * 30;
      var waste = monthly * 0.18;
      document.getElementById('monthly').textContent = '$' + monthly.toFixed(0);
      document.getElementById('waste').textContent = '$' + waste.toFixed(0);
      document.getElementById('savings').textContent = '$' + waste.toFixed(0);
    }
    ['tokens', 'rate'].forEach(function (id) {
      var el = document.getElementById(id);
      if (el) {
        el.addEventListener('input', calc);
      }
    });
    calc();
  })();
</script>
```

Typical teams see 12–30% reduction in token spend within the first month after gaining per-agent visibility.

---

## Compliance Badges & Posture

- **SOC 2 Type II** — Roadmap item (contact us for timeline)
- **GDPR-ready** — Local data residency by default; exports are explicit
- **HIPAA-ready** — Self-hosted / air-gapped deployments supported; BAA available for Enterprise
- **Data residency** — Your traces never leave the machine unless you choose to export or forward via webhook.
- **SSRF & secret handling** — Webhook delivery enforces HTTPS for non-localhost targets and performs basic SSRF protection. All persisted secrets are stored hashed only.
- **License** — MIT. You can fork, vendor, or embed with no restrictions beyond the license text.

---

## Getting Started for Enterprise Teams

1. Install the CLI and SDK exactly as in the [Quickstart](./quickstart.md).
2. Instrument a pilot agent or use the LangGraph / CrewAI middleware.
3. Run `agenttrace dashboard` and explore the data with your team.
4. Add a few `registerAlert()` calls for cost and error thresholds.
5. Decide on retention policy and export cadence for compliance.
6. Talk to us about hosted team dashboards or on-prem deployment.

---

## Contact & Next Steps

- Open a GitHub discussion or issue: https://github.com/Klepsiphron/agenttrace
- For enterprise pricing, deployment support, or custom development: reach out via the repository or email the maintainers (details in the repo).
- We are happy to schedule a walkthrough, review your current instrumentation, or help design an evaluation + alerting strategy that fits your governance model.

**Contact Sales** — Enterprise inquiries: open an issue with `[enterprise]` in the title or email the maintainers listed in the repository.

AgentTrace gives you the observability layer that regulated, cost-conscious teams need — without forcing you to give up control of your data.
