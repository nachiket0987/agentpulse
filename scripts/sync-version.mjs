#!/usr/bin/env node
// scripts/sync-version.mjs
// Sync VERSION file to all packages before build
import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const rootDir = join(__dirname, '..');
const version = readFileSync(join(rootDir, 'VERSION'), 'utf-8').trim();

const packages = [
  'packages/sdk',
  'packages/cli',
  'packages/dashboard',
  'packages/auto-instrument',
  'packages/middleware-langgraph',
  'packages/middleware-crewai',
  'packages/sdk-python',
];

for (const pkg of packages) {
  const pkgJsonPath = join(rootDir, pkg, 'package.json');
  if (existsSync(pkgJsonPath)) {
    const pkgJson = JSON.parse(readFileSync(pkgJsonPath, 'utf-8'));
    pkgJson.version = version;
    // Replace workspace refs with exact version for publishing
    // NOTE: Only do this at publish time, not during prebuild/pretest.
    // workspace:* refs are needed for local pnpm install to work.
    // Uncomment the block below before publishing:
    /*
    for (const key of ['dependencies', 'devDependencies', 'peerDependencies']) {
      if (pkgJson[key]) {
        for (const dep of Object.keys(pkgJson[key])) {
          if (pkgJson[key][dep] === 'workspace:*') {
            pkgJson[key][dep] = version;
          }
        }
      }
    }
    */
    writeFileSync(pkgJsonPath, JSON.stringify(pkgJson, null, 2) + '\n');
  }
  // Also handle pyproject.toml for Python packages
  const pyprojectPath = join(rootDir, pkg, 'pyproject.toml');
  if (existsSync(pyprojectPath)) {
    let content = readFileSync(pyprojectPath, 'utf-8');
    content = content.replace(/^version = ".*"/m, `version = "${version}"`);
    writeFileSync(pyprojectPath, content);
  }
  // Also replace VERSION placeholder in TypeScript source files
  const srcDir = join(rootDir, pkg, 'src');
  if (existsSync(srcDir)) {
    const tsFiles = ['index.ts'];
    for (const tsFile of tsFiles) {
      const tsPath = join(srcDir, tsFile);
      if (existsSync(tsPath)) {
        let content = readFileSync(tsPath, 'utf-8');
        // Skip files that use readVersion() pattern (runtime version from package.json)
        if (content.includes('readVersion()')) {
          continue;
        }
        content = content.replace(
          /export const VERSION = '[^']*';?\s*\/\/.*$/,
          `export const VERSION = '${version}';`,
        );
        // Also handle any remaining placeholder
        content = content.replace(
          /export const VERSION = '0\.0\.0';.*/,
          `export const VERSION = '${version}';`,
        );
        writeFileSync(tsPath, content);
      }
    }
  }
  // Also handle Python VERSION constants
  const pyCore = join(srcDir, 'agenttrace', 'core.py');
  if (existsSync(pyCore)) {
    let content = readFileSync(pyCore, 'utf-8');
    content = content.replace(/VERSION = "[^"]*"/, `VERSION = "${version}"`);
    writeFileSync(pyCore, content);
  }
  const pyInit = join(srcDir, 'agenttrace_middleware', '__init__.py');
  if (existsSync(pyInit)) {
    let content = readFileSync(pyInit, 'utf-8');
    content = content.replace(/VERSION = "[^"]*"/, `VERSION = "${version}"`);
    writeFileSync(pyInit, content);
  }
}

console.log(`Synced version ${version} to all packages`);
