#!/usr/bin/env bash
#
# scripts/bump-version.sh
# Bumps version across the AgentTrace monorepo for a release.
#
# Usage:
#   ./scripts/bump-version.sh patch   # 0.1.0 -> 0.1.1
#   ./scripts/bump-version.sh minor   # 0.1.0 -> 0.2.0
#   ./scripts/bump-version.sh major   # 0.1.0 -> 1.0.0
#
# What it does:
# - Computes new semantic version
# - Updates "version" in ALL package.json (root + packages/*)
# - Updates version= in ALL pyproject.toml (Python packages)
# - Updates VERSION constants in SDK source code (TS + Python)
# - Updates matching version assertions in tests (so tests continue to pass)
# - Generates a changelog entry (new version section in CHANGELOG.md)
# - Creates an annotated git tag (vX.Y.Z)  [note: does NOT commit changes]
#
# After running:
#   git add -A
#   git commit -m "chore: release vX.Y.Z"
#   git push && git push --tags
#
# IMPORTANT: This script does NOT commit or push (per project release guidelines).
# Review changes, then commit/tag manually if the auto-tag is insufficient.

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT_DIR="$(cd "${SCRIPT_DIR}/.." && pwd)"

cd "$ROOT_DIR"

if [ $# -ne 1 ]; then
  echo "Usage: $0 <patch|minor|major>"
  echo "Example: $0 minor"
  exit 1
fi

BUMP_TYPE="$1"

case "$BUMP_TYPE" in
  patch|minor|major) ;;
  *)
    echo "Error: bump type must be one of: patch, minor, major"
    exit 1
    ;;
esac

# Read current version from the core TS SDK (authoritative for monorepo releases)
if [ ! -f packages/sdk/package.json ]; then
  echo "Error: packages/sdk/package.json not found"
  exit 1
fi

CURRENT_VERSION=$(grep -o '"version": "[^"]*"' packages/sdk/package.json | head -1 | cut -d '"' -f 4)

if [ -z "$CURRENT_VERSION" ]; then
  echo "Error: could not parse current version from packages/sdk/package.json"
  exit 1
fi

# Semver bump (pure bash)
bump_semver() {
  local ver="$1"
  local typ="$2"
  IFS='.' read -r major minor patch <<< "$ver"
  # default to 0 if missing
  major=${major:-0}
  minor=${minor:-0}
  patch=${patch:-0}

  case "$typ" in
    major)
      major=$((major + 1))
      minor=0
      patch=0
      ;;
    minor)
      minor=$((minor + 1))
      patch=0
      ;;
    patch)
      patch=$((patch + 1))
      ;;
  esac
  echo "${major}.${minor}.${patch}"
}

NEW_VERSION=$(bump_semver "$CURRENT_VERSION" "$BUMP_TYPE")

echo "==> Bumping version: ${CURRENT_VERSION} -> ${NEW_VERSION} (${BUMP_TYPE})"

# --- Update all package.json files (top-level version only, first match) ---
PACKAGE_JSONS=(
  "package.json"
  "packages/sdk/package.json"
  "packages/cli/package.json"
  "packages/dashboard/package.json"
  "packages/middleware-langgraph/package.json"
)

for pkg in "${PACKAGE_JSONS[@]}"; do
  if [ -f "$pkg" ]; then
    # Limit replacement to first "version" occurrence (the package's own version, not deps)
    sed -i '0,/"version":/{s/"version": "[^"]*"/"version": "'"$NEW_VERSION"'"/}' "$pkg"
    echo "  updated $pkg"
  fi
done

# --- Update all pyproject.toml files ---
PYPROJECTS=(
  "packages/sdk-python/pyproject.toml"
  "packages/middleware-crewai/pyproject.toml"
)

for toml in "${PYPROJECTS[@]}"; do
  if [ -f "$toml" ]; then
    # First version = "..." under [project]
    sed -i '0,/^version =/{s/^version = "[^"]*"/version = "'"$NEW_VERSION"'"/}' "$toml"
    echo "  updated $toml"
  fi
done

# --- Update VERSION in SDK source code ---
# TypeScript packages
TS_VERSION_FILES=(
  "packages/sdk/src/index.ts"
  "packages/cli/src/index.ts"
  "packages/dashboard/src/index.ts"
  "packages/middleware-langgraph/src/index.ts"
)

for f in "${TS_VERSION_FILES[@]}"; do
  if [ -f "$f" ]; then
    # Handles both single and double quotes in source
    sed -i "s/export const VERSION = '[^']*';/export const VERSION = '$NEW_VERSION';/g" "$f"
    sed -i "s/export const VERSION = \"[^\"]*\";/export const VERSION = \"$NEW_VERSION\";/g" "$f"
    echo "  updated $f"
  fi
done

# Python packages
PY_VERSION_FILES=(
  "packages/sdk-python/src/agenttrace/core.py"
  "packages/middleware-crewai/src/agenttrace_middleware/__init__.py"
)

for f in "${PY_VERSION_FILES[@]}"; do
  if [ -f "$f" ]; then
    sed -i 's/^VERSION = "[^"]*"/VERSION = "'"$NEW_VERSION"'"/' "$f"
    sed -i "s/^VERSION = '[^']*'/VERSION = '$NEW_VERSION'/" "$f"
    echo "  updated $f"
  fi
done

# --- Update version expectations in tests (keep tests green after bump) ---
# TS tests
TS_TEST_FILES=(
  "packages/sdk/src/index.test.ts"
  "packages/cli/src/index.test.ts"
  "packages/cli/src/costs.test.ts"
  "packages/dashboard/src/index.test.ts"
  "packages/middleware-langgraph/tests/test.ts"
)

for f in "${TS_TEST_FILES[@]}"; do
  if [ -f "$f" ]; then
    sed -i "s/expect(VERSION).toBe('[^']*')/expect(VERSION).toBe('$NEW_VERSION')/g" "$f"
    sed -i "s/expect(VERSION).toBe(\"[^\"]*\")/expect(VERSION).toBe(\"$NEW_VERSION\")/g" "$f"
    echo "  updated $f"
  fi
done

# Python test
if [ -f "packages/middleware-crewai/tests/test_crewai.py" ]; then
  sed -i 's/assert VERSION == "[^"]*"/assert VERSION == "'"$NEW_VERSION"'"/g' "packages/middleware-crewai/tests/test_crewai.py"
  sed -i "s/assert VERSION == '[^']*'/assert VERSION == '$NEW_VERSION'/g" "packages/middleware-crewai/tests/test_crewai.py"
  echo "  updated packages/middleware-crewai/tests/test_crewai.py"
fi

# --- Generate changelog entry ---
DATE=$(date +%Y-%m-%d)

# Insert a new version section immediately after the [Unreleased] header.
# Leaves [Unreleased] empty for future work; moves the "release" content conceptually to the new section.
awk -v ver="$NEW_VERSION" -v dt="$DATE" -v typ="$BUMP_TYPE" '
  BEGIN { inserted=0 }
  /^## \[Unreleased\]/ && !inserted {
    print $0
    print ""
    print "## [" ver "] - " dt
    print ""
    print "### Changed"
    print ""
    print "- Version bump (" typ "): " ver
    print "- See git log for detailed changes since previous release."
    print "- Run tests/build before publishing."
    print ""
    inserted=1
    next
  }
  { print }
' CHANGELOG.md > /tmp/CHANGELOG.tmp && mv /tmp/CHANGELOG.tmp CHANGELOG.md

echo "  updated CHANGELOG.md (added section for v${NEW_VERSION})"

# --- Create git tag (does not commit; changes remain uncommitted per requirements) ---
TAG_NAME="v${NEW_VERSION}"
if git rev-parse "$TAG_NAME" >/dev/null 2>&1; then
  echo "Warning: tag ${TAG_NAME} already exists. Skipping tag creation."
else
  git tag -a "$TAG_NAME" -m "AgentTrace ${TAG_NAME}

Automated version bump (${BUMP_TYPE}).

See CHANGELOG.md for details."
  echo "  created annotated tag ${TAG_NAME}"
fi

echo ""
echo "==> Done. Version bumped to ${NEW_VERSION}"
echo ""
echo "Next steps (manual, do not push until ready):"
echo "  git add -A"
echo "  git commit -m \"chore: release ${TAG_NAME}\""
echo "  # then push: git push origin main && git push origin ${TAG_NAME}"
echo ""
echo "The working tree now has the version updates (no commit was performed by this script)."
echo "Review with: git status && git diff --stat"
