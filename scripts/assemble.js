'use strict';
const fs = require('node:fs');
const path = require('node:path');
const assert = require('node:assert/strict');
const { execFileSync } = require('node:child_process');
const pkg = JSON.parse(fs.readFileSync('package.json', 'utf8'));
const dirs = fs.readdirSync('npm');
assert.equal(dirs.length, 6, 'All six platform packages are required');
const loaders = fs.readdirSync('artifacts').map(d => path.join('artifacts', d, 'binding.js'));
assert.equal(loaders.length, 6);
const loader = fs.readFileSync(loaders[0], 'utf8');
assert(loaders.every(p => fs.readFileSync(p, 'utf8') === loader), 'Generated loaders differ');
fs.writeFileSync('binding.js', loader);
pkg.optionalDependencies = {};
for (const dir of dirs) {
  const filename = `icmp_ping.${dir}.node`;
  assert(fs.statSync(path.join('npm', dir, filename)).size > 0, `Missing ${filename}`);
  const file = path.join('npm', dir, 'package.json');
  const nativePkg = JSON.parse(fs.readFileSync(file, 'utf8'));
  nativePkg.version = pkg.version;
  nativePkg.engines = pkg.engines;
  nativePkg.repository = pkg.repository;
  nativePkg.license = pkg.license;
  fs.writeFileSync(file, JSON.stringify(nativePkg, null, 2) + '\n');
  fs.copyFileSync('LICENSE', path.join('npm', dir, 'LICENSE'));
  pkg.optionalDependencies[nativePkg.name] = pkg.version;
  execFileSync('npm', ['pack', '--pack-destination', '../..'], { cwd: path.join('npm', dir), stdio: 'inherit' });
}
fs.writeFileSync('package.json', JSON.stringify(pkg, null, 2) + '\n');
// Root installation must exercise platform optional dependencies, not a bundled
// collection of all architectures. Platform tarballs carry the native binaries.
pkg.files = pkg.files.filter(f => f !== '*.node');
fs.writeFileSync('package.json', JSON.stringify(pkg, null, 2) + '\n');
execFileSync('npm', ['pack'], { stdio: 'inherit' });
