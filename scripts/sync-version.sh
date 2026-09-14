#!/usr/bin/env bash
# Sync VERSION from root to all packages
# Called from each package's build script via prebuild

VERSION=$(cat "$(dirname "$0")/../../VERSION")

# Update package.json version
cd "$(dirname "$0")/.."
python3 -c "
import json, sys
with open('package.json') as f:
    pkg = json.load(f)
pkg['version'] = '$VERSION'
# Replace workspace refs with actual version
for key in ['dependencies', 'devDependencies', 'peerDependencies']:
    if key in pkg:
        for dep in pkg[key]:
            if pkg[key][dep] == 'workspace:*':
                pkg[key][dep] = '$VERSION'
with open('package.json', 'w') as f:
    json.dump(pkg, f, indent=2)
    f.write('\n')
print(f'Synced version: {pkg[\"name\"]} -> $VERSION')
"

echo "Version synced: $VERSION"
