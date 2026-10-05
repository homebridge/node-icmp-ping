'use strict';
const fs = require('node:fs');
const assert = require('node:assert/strict');

function cargoVersion(text) {
  const section = text.split(/^\[\[?package\]\]?\s*$/m).slice(1)
    .map(part => part.split(/^\[/m)[0])
    .find(part => /^name\s*=\s*"node-icmp-ping"\s*$/m.test(part));
  return section?.match(/^version\s*=\s*"([^"]+)"\s*$/m)?.[1];
}
function validateVersions({ pkg, lock, cargo, cargoLock }) {
  const versions = {
    'package.json': pkg.version,
    'package-lock.json (top level)': lock.version,
    'package-lock.json (root package)': lock.packages?.['']?.version,
    'Cargo.toml': cargoVersion(cargo),
    'Cargo.lock (node-icmp-ping)': cargoVersion(cargoLock),
  };
  assert(Object.values(versions).every(value => typeof value === 'string' && value === pkg.version),
    'Package versions must agree; edit the four version files manually:\n' +
    Object.entries(versions).map(([file, value]) => `  ${file}: ${value ?? '(missing)'}`).join('\n'));
}
if (require.main === module) {
  validateVersions({ pkg: require('../package.json'), lock: require('../package-lock.json'),
    cargo: fs.readFileSync('Cargo.toml', 'utf8'), cargoLock: fs.readFileSync('Cargo.lock', 'utf8') });
  console.log('All four package version files agree');
}
module.exports = { validateVersions };
