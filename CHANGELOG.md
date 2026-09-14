# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.0.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Fixed

- All package versions bumped to 0.4.3 (package.json, pyproject.toml, hardcoded VERSION constants)
- All test assertions updated to match 0.4.3
- Landing page: added `rel="noopener"` to all external links
- Landing page: added missing `.prose-custom` CSS class
- Landing page: fixed CSS quote consistency
- `pages.yml`: removed trailing null bytes

## [0.4.3] - 2026-06-07

### Added

- Auto-instrument package (`@agenttrace-io/auto-instrument`) for zero-code tracing
- Process scanning: `agenttrace watch` auto-detects running agents
- Module-level hooks intercept `require()` to auto-patch LangChain, OpenAI SDK
- WSL-to-Windows process bridge
- Dashboard `--no-auth` flag for local dev
- Starlight documentation site with search, guides, and API reference (16 pages)
- Python SDK: `close()` method, fixed exports, schema migrations
- CLI: `wrap` command for zero-config agent tracing
- CLI: budget tracking and alerting commands
- CLI: budget tracking and alerting commands
- Session bridge script to import session data into AgentTrace
- Comprehensive CLI command tests (24 tests)
- LangGraph middleware integration tests (27 tests)
- Multi-tenant test coverage (23 tests)
- Agent usage tracking tests (5 tests)
- Retention policy tests (30 tests)
- Export format tests (20 tests)
- Integration tests for Python SDK (full filter/stats/export coverage)

### Changed

- better-sqlite3 upgraded to v12 with prebuilt binaries for clean Windows install
- Engine constraint: Node 20-23 (prebuilt binary compatibility)
- Landing page: modernized with Tailwind CSS, dark theme, indigo accent
- Landing page: dashboard UI redesign with polished modern look
- README: overhauled with professional structure
- CI/CD workflows consolidated with PyPI OIDC + Docker publishing
- Dependabot for npm and GitHub Actions updates
- Pre-commit hook: format + lint check on staged files

### Fixed

- TraceContext constructor error on Node 22 (isolatedModules import erasure)
- 41 CI lint errors across all packages
- 12 CI test failures in multi-tenant and SDK
- recordToolCall now stores tool calls in active trace context
- safe JSON parsing for bridged data
- Multi-tenant test failures (tenantId pass-through, connection pooling)
- Retention test transform error
- CI lint errors from eslint 10 + flat config migration
- VERSION strings in all packages now consistent at 0.4.3

### Security

- Comprehensive security audit: 0 hits across 10 categories
- Removed all internal references from public files
- Removed internal tooling, development configs, and internal documentation
- All tokens/secrets stored as GitHub secrets only

### Documentation

- Added CONTRIBUTING.md, SECURITY.md, CODE_OF_CONDUCT.md
- Added debugging, evaluation, getting-started tutorials
- Added LangGraph, CrewAI, custom agent, Discord bot, Slack bot, FastAPI examples
- Added Windows dev setup note for native modules
- Updated ROADMAP with completed items

## [0.3.0] - 2026-06-06

### Added

- OpenTelemetry export (OTLP JSON format)
- Dockerfile and docker-compose.yml for self-hosting
- Evaluation framework and alerting webhooks
- GitHub Pages landing page
- Social preview HTML, logo SVG, demo GIF description
- Comparison page (vs Langfuse/LangSmith)
- LangGraph middleware package
- CrewAI middleware package
- Branch protection, CODEOWNERS, repo metadata

### Changed

- Package naming: `@agenttrace-io/*` / `agenttrace-io`
- README with v0.2.0 features and comparison table
- Contributing guide with project structure and workflow

### Fixed

- ESLint no-unused-vars in catch clauses
- `any` types in OpenTelemetry tests

## [0.2.0] - 2026-06-02

### Added

- TypeScript SDK: trace wrapper, cost tracking, SQLite storage
- Python SDK: context manager + decorator, 23 unit tests
- Full CLI: init, dashboard, runs, traces, stats, export, version, costs, benchmark, health, self-stats, alerts
- Express dashboard: dark theme, runs list, trace details, stats, export
- GitHub Actions CI with Node 20 + 22 matrix
- Publish pipeline: PyPI + npm on GitHub release tag
- Issue templates, PR template, CODEOWNERS, branch protection
- Dependabot for npm and GitHub Actions
- Pre-commit hook for auto-formatting

### Changed

- Set initial version 0.1.0 across core packages
- Prepared repository for launch

### Documentation

- Added changelog, SECURITY.md, CONTRIBUTING.md
- Added market analysis, roadmap, launch materials
- Added LangGraph, CrewAI, custom agent integration examples
