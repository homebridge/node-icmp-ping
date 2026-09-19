'use strict';
const fs = require('node:fs');
const path = require('node:path');
const assert = require('node:assert/strict');
const { execFileSync } = require('node:child_process');
const pkg = JSON.parse(fs.readFileSync('package.json', 'utf8'));
const { rootName, platforms, nativeNames, tarballName } = require('./package-identity.js');
assert.equal(pkg.name, rootName);
const dirs = fs.readdirSync('npm');
assert.deepEqual([...dirs].sort(), [...platforms].sort(), 'All six intended platform packages are required');
const loaders = fs.readdirSync('artifacts').map(d => path.join('artifacts', d, 'binding.js'));
assert.equal(loaders.length, 6);
const loader = fs.readFileSync(loaders[0], 'utf8');
assert(loaders.every(p => fs.readFileSync(p, 'utf8') === loader), 'Generated loaders differ');
for (const name of nativeNames) assert(loader.includes(`require('${name}')`), `Missing scoped loader lookup: ${name}`);
fs.writeFileSync('binding.js', loader);
function pack(directory) {
  const metadata = JSON.parse(fs.readFileSync(path.join(directory, 'package.json'), 'utf8'));
  const [result] = JSON.parse(execFileSync('npm', ['pack', '--json', '--pack-destination', process.cwd()], { cwd: directory, encoding: 'utf8' }));
  assert.equal(result.name, metadata.name);
  assert.equal(result.version, metadata.version);
  assert.equal(result.filename, tarballName(metadata.name, metadata.version), 'Unexpected npm pack filename');
  console.log(`Packed ${result.filename}`);
}
pkg.optionalDependencies = {};
for (const dir of dirs) {
  const filename = `icmp_ping.${dir}.node`;
  assert(fs.statSync(path.join('npm', dir, filename)).size > 0, `Missing ${filename}`);
  const file = path.join('npm', dir, 'package.json');
  const nativePkg = JSON.parse(fs.readFileSync(file, 'utf8'));
  assert.equal(nativePkg.name, `${pkg.name}-${dir}`, 'Unexpected generated native package identity');
  nativePkg.version = pkg.version;
  nativePkg.engines = pkg.engines;
  nativePkg.repository = pkg.repository;
  nativePkg.license = pkg.license;
  nativePkg.publishConfig = pkg.publishConfig;
  fs.writeFileSync(file, JSON.stringify(nativePkg, null, 2) + '\n');
  fs.copyFileSync('LICENSE', path.join('npm', dir, 'LICENSE'));
  pkg.optionalDependencies[nativePkg.name] = pkg.version;
  pack(path.join('npm', dir));
}
fs.writeFileSync('package.json', JSON.stringify(pkg, null, 2) + '\n');
// Root installation must exercise platform optional dependencies, not a bundled
// collection of all architectures. Platform tarballs carry the native binaries.
pkg.files = pkg.files.filter(f => f !== '*.node');
fs.writeFileSync('package.json', JSON.stringify(pkg, null, 2) + '\n');
pack('.');
const channel = require('./release-policy.js').channel(pkg.version, pkg.version.includes('-'));
const packages = require('./publish.js').preflight('.', channel);
console.log(`Validated ${packages.length} scoped tarballs; root last: ${packages.at(-1).name}`);
