'use strict';
const fs = require('node:fs');
const { execFileSync } = require('node:child_process');
const assert = require('node:assert/strict');
const pkg = require('../package.json');
const { rootName, targets, packageFiles } = require('./package-identity.js');

function checkManifest(metadata) {
  assert.equal(metadata.name, rootName, 'Unexpected package identity');
  assert.equal(metadata.version, pkg.version, 'Unexpected package version');
  assert.equal(metadata.publishConfig?.access, 'public', 'Package must be public');
  assert.deepEqual(metadata.engines, pkg.engines, 'Unexpected Node support');
  assert.deepEqual(metadata.napi?.targets, Object.keys(targets), 'Unexpected native targets');
  assert.equal(metadata.napi?.binaryName, 'icmp_ping');
  assert.equal(metadata.main, 'index.js');
  assert.equal(metadata.types, 'index.d.ts');
  assert.deepEqual(metadata.exports, pkg.exports, 'Unexpected API entry points');
  for (const key of ['dependencies', 'optionalDependencies', 'peerDependencies']) {
    assert.equal(Object.keys(metadata[key] || {}).length, 0, `Unexpected ${key}`);
  }
  for (const name of ['preinstall', 'install', 'postinstall']) {
    assert(!metadata.scripts?.[name], `Forbidden install hook: ${name}`);
  }
  assert(!metadata.gypfile, 'Install-time compilation is forbidden');
}

function checkFiles(files) {
  assert.deepEqual([...files].sort(), [...packageFiles].sort(), 'Unexpected package contents (all six binaries required)');
}

// Inspect the retained tarball itself, never a new dry-run pack of the checkout.
function inspectTarball(tarball) {
  const listing = execFileSync('tar', ['-tf', tarball], { encoding: 'utf8' }).trim().split(/\r?\n/);
  const files = listing.filter(name => !name.endsWith('/'));
  checkFiles(files.map(name => {
    assert(name.startsWith('package/'), `Unexpected tar entry: ${name}`);
    return name.slice('package/'.length);
  }));
  const read = name => execFileSync('tar', ['-xOf', tarball, `package/${name}`], { maxBuffer: 16 * 1024 * 1024 });
  const metadata = JSON.parse(read('package.json'));
  checkManifest(metadata);
  for (const name of packageFiles) assert(read(name).length > 0, `Empty package file: ${name}`);
  // Windows checkouts may use CRLF; the generated and packed loader uses LF.
  const reviewedLoader = fs.readFileSync(require.resolve('../binding.js'), 'utf8').replace(/\r\n/g, '\n');
  assert.equal(read('binding.js').toString(), reviewedLoader, 'Tarball loader differs from the reviewed generated loader');
  return metadata;
}

module.exports = { checkManifest, checkFiles, inspectTarball };

if (require.main === module) {
  const directory = process.argv[2] || 'distribution';
  const channel = require('./release-policy.js').channel(pkg.version, pkg.version.includes('-'));
  const item = require('./publish.js').preflight(directory, channel);
  console.log(`Validated ${packageFiles.length} files in ${item.tarball}; ${item.integrity}`);
}
