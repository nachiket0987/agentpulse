# Contributing to AgentTrace

Thank you for contributing! AgentTrace is MIT-licensed and community-driven. This guide covers everything you need to get started — from environment setup to shipping a PR.

---

## Table of Contents

1. [Development Setup](#development-setup)
2. [Project Structure](#project-structure)
3. [Development Workflow](#development-workflow)
4. [Testing Guidelines](#testing-guidelines)
5. [Code Style & Standards](#code-style--standards)
6. [Commit Conventions](#commit-conventions)
7. [Pull Request Process](#pull-request-process)
8. [Security Rules](#security-rules)
9. [Need Help?](#need-help)

---

## Development Setup

### Prerequisites

- **Node.js** >= 20
- **pnpm** >= 9 (package manager — this is a pnpm workspace)
- **Python** >= 3.10 (for the Python SDK)

### Clone and Install

```bash
git clone https://github.com/Klepsiphron/agenttrace.git
cd agenttrace
pnpm install
```

This installs dependencies for all packages in the monorepo via pnpm workspaces (`packages/*`).

### Build

```bash
pnpm build
```

This runs `pnpm -r run build` — every package compiles in dependency order.

### Python SDK Setup (optional)

```bash
cd packages/sdk-python

# Create and activate a virtual environment
python -m venv .venv
source .venv/bin/activate   # Linux/macOS
# .venv\Scripts\activate    # Windows

# Install in editable mode with dev dependencies
pip install --upgrade pip
pip install -e '.[dev]'
```

### Verify Everything Works

```bash
pnpm build          # TypeScript compilation across all packages
pnpm test           # Vitest runs all test suites
pnpm lint           # ESLint checks
pnpm format:check   # Prettier checks
```

**Windows note:** Native modules like `better-sqlite3` may require Visual Studio Build Tools (C++ workload) for compilation. Install them or use WSL for easier local dev. The CI runs on Ubuntu and handles prebuilts fine.

---

## Project Structure

```
agenttrace/
├── packages/
│   ├── sdk/                    # @agenttrace-io/sdk -- TypeScript SDK (core)
│   │   └── src/
│   │       ├── index.ts        # Main module & public API
│   │       ├── index.test.ts   # Core unit + integration tests
│   │       ├── integration.test.ts
│   │       └── *.test.ts       # Module-specific tests
│   ├── sdk-python/             # agenttrace-io -- Python SDK
│   │   └── src/agenttrace/
│   │   └── tests/              # pytest test files
│   ├── cli/                    # @agenttrace-io/cli -- CLI tool
│   ├── dashboard/              # @agenttrace-io/dashboard -- Local web UI
│   ├── middleware-langgraph/   # LangGraph auto-tracing integration
│   ├── middleware-crewai/      # CrewAI auto-tracing integration
│   └── billing/                # Stripe billing integration
├── docs/                       # Documentation (API reference, architecture, roadmap)
├── examples/                   # Integration examples (LangGraph, CrewAI, Custom)
└── scripts/                    # Utility scripts (e.g. import-bridge.py)
```

---

## Development Workflow

1. **Create a feature branch** from `main`:

   ```bash
   git checkout -b feat/my-feature
   ```

   Branch naming: `feat/`, `fix/`, `docs/`, `refactor/`, `test/` prefixes.

2. **Write tests first** (TDD) for behavior changes. See [Testing Guidelines](#testing-guidelines).

3. **Implement the change** — keep it focused on a single concern.

4. **Verify everything passes locally** before pushing:

   ```bash
   pnpm build    # TypeScript compilation
   pnpm lint     # ESLint (zero warnings)
   pnpm test     # All test suites
   pnpm format:check   # Prettier formatting check
   ```

5. **Commit** using [conventional commits](#commit-conventions).

6. **Push and open a PR** against `main`.

7. **CI must pass** before merge (branch protection requires it).

---

## Testing Guidelines

### TypeScript Tests (Vitest)

All TypeScript tests use **Vitest**. Test files live alongside source: `packages/*/src/**/*.test.ts`.

```bash
# Run all tests
pnpm test

# Watch mode
pnpm test:watch

# Run tests for a specific package
pnpm --filter @agenttrace-io/sdk test

# Run a specific test file
npx vitest run packages/sdk/src/index.test.ts
```

**Test conventions:**

- Test files are named `*.test.ts` and placed next to the source they test.
- Unit tests in `*.test.ts`, integration tests in `integration.test.ts`, end-to-end tests in `e2e.test.ts`.
- Use descriptive test names: `it('should return cost breakdown by model', ...)`.
- Tests should be fast, deterministic, and independent (no shared mutable state).
- Integration tests use temporary SQLite DB files — never hardcode paths.
- Every new public function needs at least one test covering the happy path and edge cases.

### Python Tests (pytest)

Python SDK tests use **pytest** and live in `packages/sdk-python/tests/`.

```bash
cd packages/sdk-python
pytest              # Run all tests
pytest -q           # Quiet mode
pytest tests/test_core.py  # Specific file
```

**Test conventions:**

- Test files: `test_*.py`
- Test classes: `Test*` (optional grouping)
- Test functions: `test_*`
- Configuration in `pyproject.toml` (verbose, short tracebacks).
- Use `pytest` fixtures for setup/teardown of DB files.

### Running TypeScript and Python Together

For full coverage:

```bash
pnpm test          # All TS tests
cd packages/sdk-python && pytest && cd ../..  # Python tests
```

---

## Code Style & Standards

### TypeScript

Zero config drift — the following are enforced by CI:

- **TypeScript strict mode** (`tsconfig.json`): `strict: true`, `noUncheckedIndexedAccess`, `noImplicitReturns`, `noFallthroughCasesInSwitch`.
- **Avoid `any`** — use `unknown` + type guards. `any` is only acceptable for third-party type escapes with a comment.
- **ESLint**: `eslint.config.mjs` enforces `@typescript-eslint/recommended` + unused vars (underscore-prefixed args allowed: `_unused`).
- **Prettier** (`.prettierrc`):
  - Semicolons: yes
  - Single quotes: yes
  - Trailing commas: all
  - Print width: 100
- **Zero runtime dependencies** in `@agenttrace-io/sdk` — the core SDK must remain dependency-free.
- Every public function needs JSDoc-style documentation and tests.

### Python

- **Type hints**: All public functions, methods, and classes must have type hints. Use `from __future__ import annotations`.
- **Naming**: `snake_case` for functions/variables, `PascalCase` for classes. No camelCase in Python code (the SDK normalizes camelCase config keys from TS parity).
- **Docstrings**: Every public class, function, and method must have a docstring.
- **Zero runtime dependencies** — Python SDK uses only stdlib.
- **Formatting**: No auto-formatter enforced yet. Keep code clean and consistent with existing style (4-space indents).

### Cross-Language API Parity

The Python SDK mirrors the TypeScript SDK API:

- TS `getCostBreakdown` → Python `get_cost_breakdown`
- TS `dbPath` config → Python accepts `db_path` (normalizes camelCase)
- Keep defaults, cost rates, export formats, and run/trace lifecycle consistent.

### Pre-commit (if configured)

If you have Husky hooks installed, code is auto-formatted on commit. Otherwise, run `pnpm format` before committing.

---

## Commit Messages

This project follows **Conventional Commits** (enforced):

```
<type>(<scope>): <description>
```

**Types:**

- `feat` — new feature
- `fix` — bug fix
- `docs` — documentation only
- `chore` — maintenance, tooling, config
- `test` — adding or updating tests
- `refactor` — code restructuring without behavior change
- `perf` — performance improvement
- `ci` — CI/CD changes

**Scopes** (optional but recommended):

- `sdk` — TypeScript SDK
- `python` — Python SDK
- `cli` — CLI package
- `dashboard` — Dashboard UI
- `middleware-*` — Specific middleware package
- `all` — Cross-cutting changes

**Examples:**

```
feat(sdk): add OpenTelemetry export
fix(cli): resolve SQLite race condition
docs: update API reference
chore: add pre-commit format hook
test(sdk): expand integration coverage to 29 tests
refactor(dashboard): extract auth middleware
fix(python): correct cost calculation for claude-3
```

**Rules:**

- Description in imperative mood ("add" not "added").
- Keep the first line under 72 characters.
- Use the body for detailed explanation of _what_ and _why_ (not _how_).
- Reference issues in the body or footer: `Closes #123`, `Refs #456`.

---

## Pull Request Process

1. **One concern per PR** — keep changes atomic and reviewable.
2. **Fill out the PR template** (`.github/pull_request_template.md` is provided):
   - Describe what changed and why.
   - Mark the type of change (bug fix, feature, docs, etc.).
   - Check off the checklist (tests, lint, build).
3. **Reference related issues** in the PR body: `Closes #123`, `Refs #456`.
4. **Ensure CI passes** before requesting review. The CI pipeline runs:
   - `pnpm install --frozen-lockfile`
   - `pnpm build` (TypeScript compilation)
   - `pnpm test` (all Vitest tests)
   - `pnpm lint` (ESLint)
   - `pnpm format:check` (Prettier)
   - Tested on Node 20 and 22
5. **Review your own diff first** — catch obvious issues before others do.
6. **Screenshots**: Include them for UI (dashboard) changes.
7. **Keep PRs small**: If a PR exceeds ~400 lines, consider splitting it.

### PR Title Convention

PR titles should follow the same convention as commit messages:

```
feat(sdk): add batch trace export
fix(cli): handle missing DB file gracefully
```

---

## Security Rules

Never commit:

- API keys, tokens, or credentials (including `.env` files)
- Database files (`*.db`, `*.sqlite`, `*.sqlite-journal`)
- `node_modules/` or `__pycache__/`
- `*.log` files
- `.vscode/` or `.idea/` IDE configs

AgentTrace stores all data locally in SQLite — no data leaves your machine by default. The dashboard serves on localhost only.

To report a security vulnerability, open a GitHub issue with the `security` label. We respond within 48 hours.

---

## Need Help?

- **Questions**: Open an issue with the `question` label.
- **Bugs**: Open an issue with the `bug` label and include reproduction steps.
- **Feature requests**: Open an issue with the `enhancement` label.
- **Python-specific**: Tag with `python` or `sdk`.

---

## License

By contributing, you agree that your contributions will be licensed under [MIT](LICENSE).
