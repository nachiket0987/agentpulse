# AgentTrace Product Roadmap

## v0.1.0 ✅ Foundation

- [x] TypeScript SDK (trace, cost, SQLite storage)
- [x] Python SDK (context manager + decorator, 23 tests)
- [x] Full CLI (init, dashboard, runs, traces, stats, export, version)
- [x] Express dashboard (dark theme, runs list, trace details, stats, export)
- [x] OpenTelemetry export (OTLP JSON format)
- [x] GitHub Actions CI (Node 20+22 matrix)
- [x] OSS hygiene (CONTRIBUTING, SECURITY, CODE_OF_CONDUCT, CHANGELOG, dependabot)
- [x] Examples (LangGraph, CrewAI, custom)
- [x] Landing page (GitHub Pages)
- [x] Comparison page (vs Langfuse/LangSmith)
- [x] Branch protection + CODEOWNERS
- [x] Publish pipeline (PyPI + npm on release tag)

## v0.2.0 🔄 In Progress -- Integration

- [x] Full CLI -- init, dashboard, runs, traces, stats, export commands
- [x] OpenTelemetry export -- industry standard, enables integration with existing tools
- [x] Python SDK -- must-have, 70%+ of AI agent code is Python
- [x] Framework middleware -- LangGraph callback handler (27 tests), CrewAI integration (7 tests)
- [ ] Documentation site -- proper docs with search, examples, API reference
- [ ] README demo GIF -- visual proof for landing page
- [ ] GitHub Sponsors -- enable sponsorship
- [ ] npm publishing -- `npm install @agenttrace-io/sdk` works (needs NPM_TOKEN)
- [ ] PyPI publishing -- `pip install agenttrace-io` works (needs PYPI_TOKEN)

## v0.3.0 📋 Planned -- Growth

- [ ] Evaluation framework -- basic trace evaluation (pass/fail/custom)
- [ ] Alerting -- webhook notifications on failures
- [ ] Multi-agent tracing -- trace across multiple agents
- [ ] Cost budgets -- set spending limits, get alerts
- [ ] User guide -- step-by-step tutorials for common use cases

## v1.0.0 🎯 Monetization

- [ ] Hosted version -- team dashboards, shared traces, cloud storage
- [ ] SSO/SAML -- enterprise auth
- [ ] Audit logs -- compliance feature
- [ ] Usage-based pricing -- free tier (1K traces/mo), paid ($29/mo for 50K)
- [ ] Stripe integration -- payment processing

## Positioning Statement

"AgentTrace is the local-first, privacy-first observability tool for AI agents.
No cloud. No accounts. No telemetry. Just traces."

## Competitive Moat

- Langfuse: 28K stars, full-featured, but heavy (Docker/K8s), cloud-first
- LangSmith: LangGraph-native, but cloud-only, usage-based pricing
- AgentOps: agent reliability focus, but cloud-first
- **AgentTrace: zero-dependency, local-first, CLI-first, privacy-first**

We don't compete on features. We compete on simplicity and privacy.
