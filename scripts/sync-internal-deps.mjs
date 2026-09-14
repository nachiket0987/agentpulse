#!/usr/bin/env node
// scripts/sync-internal-deps.mjs
// Update internal workspace dependency versions to match current version
// Run this BEFORE publishing to ensure all internal deps are at the same version
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
  'packages/middleware-langgraph',
  'packages/middleware-crewai',
];

// Build a map of package name -> version
const pkgVersions = {};
for (const pkg of packages) {
  const pkgJsonPath = join(rootDir, pkg, 'package.json');
  if (existsSync(pkgJsonPath)) {
    const pkgJson = JSON.parse(readFileSync(pkgJsonPath, 'utf-8'));
    if (pkgJson.name) {
      pkgVersions[pkgJson.name] = version;
    }
  }
}

// Update internal deps in each package
for (const pkg of packages) {
  const pkgJsonPath = join(rootDir, pkg, 'package.json');
  if (!existsSync(pkgJsonPath)) continue;

  const pkgJson = JSON.parse(readFileSync(pkgJsonPath, 'utf-8'));
  let changed = false;

  for (const key of ['dependencies', 'devDependencies', 'peerDependencies']) {
    if (!pkgJson[key]) continue;
    for (const dep of Object.keys(pkgJson[key])) {
      // If dep is another package in our workspace, update to current version
      if (pkgVersions[dep] && pkgJson[key][dep] !== version) {
        pkgJson[key][dep] = version;
        changed = true;
      }
    }
  }

  if (changed) {
    writeFileSync(pkgJsonPath, JSON.stringify(pkgJson, null, 2) + '\n');
    console.log(`Updated internal deps in ${pkg}`);
  }
}

console.log(`Synced all internal deps to ${version}`);
