# Contributing to the Python SDK (agenttrace)

Thank you for contributing to the Python SDK! This package is part of the AgentTrace monorepo and is MIT-licensed.

See the root [CONTRIBUTING.md](../../CONTRIBUTING.md) for general project guidelines, commit messages, security rules, and overall workflow. This document covers Python-specific details.

## Development Setup

Requires Python 3.10 or newer.

```bash
cd packages/sdk-python

# Create and activate a virtual environment
python -m venv .venv
source .venv/bin/activate   # Windows: .venv\Scripts\activate

# Install in editable mode with dev dependencies
pip install --upgrade pip
pip install -e '.[dev]'
```

This installs `pytest` and makes the `agenttrace` package importable from source (via `src/agenttrace`).

## Running Tests

```bash
# From packages/sdk-python (with venv active)
pytest
```

- Tests live in `tests/` (test\_\*.py)
- Uses pytest configuration from `pyproject.toml` (verbose, short tracebacks)
- Integration tests use temporary SQLite DB files
- All tests must pass before PR

Example:

```bash
pytest -q                  # quieter
pytest tests/test_core.py  # specific file
```

## Code Style

- **Type hints**: All public functions, methods, and classes must have type hints. Use `from __future__ import annotations` and `typing` constructs. Avoid `Any` except where truly necessary (prefer `object` or precise types).
- **Docstrings**: Every public class, function, and method must have a docstring (use `"""` style, one-line summary or multi-line with Args/Returns sections where helpful). Internal helpers may be lighter.
- **Naming**: Use `snake_case` for functions, methods, variables, attributes, and filenames. Use `PascalCase` for classes and types. Never use camelCase in Python code (the SDK normalizes camelCase inputs from config for TS parity).
- **Modules**: Keep implementation in `src/agenttrace/` (core.py, storage.py, types.py). Export from `__init__.py`.
- **Dependencies**: Zero runtime dependencies (only stdlib + optional dev/test). Match the spirit of the TS SDK (no deps in `@agenttrace-io/sdk`).
- **Formatting**: No strict auto-formatter enforced yet, but keep code clean and consistent with existing style. Use 4-space indents.
- **Error handling & logging**: Respect the `silent` config flag; do not print unless necessary.

## Adding New Features

When adding features, **mirror the TypeScript SDK API** (`packages/sdk/src/index.ts` and `types.ts`) as closely as possible for cross-language consistency:

- Class: `AgentTrace` (main entry)
- Functions: `init(config?)`, `get_agent_trace()`, `trace(...)` (top-level and method)
- Methods on AgentTrace: `start_run`, `complete_run`, `trace`, `record_tool_call`, `get_traces`, `get_trace`, `get_runs`, `get_run`, `get_stats`, `export`, `close`, plus newer ones like `get_cost_breakdown`, `register_alert`, `check_alerts`, `create_child`, `link_traces`, `get_trace_tree`, OTEL export helpers, etc.
- Config: `TraceConfig` (use snake_case fields: `db_path`, `max_traces`, etc.; support camelCase via normalization where it makes sense)
- Types: Keep parity in `types.py` (dataclasses with snake_case)
- Behavior: Same defaults (e.g. auto_cleanup true, max_traces 10000), same cost calculator rates, same export formats (json/csv), same run/trace lifecycle.
- Async: Python SDK supports async context managers; extend for async `trace` when mirroring TS async overloads.
- Storage: Update `storage.py` and schema if new tables/columns are needed in TS.
- Tests: Add or update tests mirroring `packages/sdk/src/*.test.ts` (see `tests/test_integration.py` comment).
- Public API: Update `__all__` and re-exports in `src/agenttrace/__init__.py`.
- Version: Bump in `pyproject.toml` and `__init__.py` / core.py `VERSION` (keep in sync with TS for now).

Example of mirroring:

- TS `getCostBreakdown` → Python `get_cost_breakdown`
- TS `dbPath` in config → Python accepts `db_path` (and normalizes `dbPath`)

If the feature involves framework integrations, coordinate with `packages/middleware-*/` (also Python).

Add tests first (TDD) for behavior changes.

## Pull Request Process

1. Create a feature branch from `main`: `git checkout -b feat/python-my-feature`
2. Write tests first for new behavior.
3. Implement, following the code style and mirroring rules above.
4. Verify locally:
   - `pip install -e '.[dev]'`
   - `pytest`
5. Ensure no `__pycache__`, `*.db`, or venv artifacts are committed (root `.gitignore` and security rules apply).
6. Commit using conventional commits (e.g. `feat(python): add get_cost_breakdown`, `fix(python): ...`).
7. Push and open PR against `main`.
8. CI (Python matrix + root CI if touching shared) must pass.
9. Reference issues: `Closes #123`.
10. One focused change per PR; keep atomic.

The Python CI (in this package's `.github/workflows/ci.yml`) runs pytest across Python 3.10/3.11/3.12 on relevant changes.

After merge, the package can be published from the monorepo publish workflow (see root).

## Need Help?

Open an issue with the `python` or `sdk` label, or discuss in the root repo.

## License

By contributing, you agree that your contributions will be licensed under [MIT](../../LICENSE).
