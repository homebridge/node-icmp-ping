'use strict';
const fs = require('node:fs');
const path = require('node:path');
const assert = require('node:assert/strict');
const { execFileSync } = require('node:child_process');
const pkg = require('../package.json');
const expectedChannel = pkg.version.includes('-') ? 'next' : 'latest';
assert.equal(process.env.CHANNEL, expectedChannel, 'Unsafe release channel');
const files = fs.readdirSync('distribution').filter(f => f.endsWith('.tgz'));
assert.equal(files.length, 7, 'Expected root and six platform tarballs');
const root = `${pkg.name}-${pkg.version}.tgz`;
assert(files.includes(root));
for (const filename of files) {
  const metadata = JSON.parse(execFileSync('tar', ['-xOf', path.join('distribution', filename), 'package/package.json'], { encoding: 'utf8' }));
  assert.equal(metadata.version, pkg.version);
  assert.equal(filename, `${metadata.name}-${metadata.version}.tgz`);
  if (filename !== root) {
    const listing = execFileSync('tar', ['-tf', path.join('distribution', filename)], { encoding: 'utf8' });
    assert(listing.includes('.node'), `Missing native binding: ${filename}`);
  } else { assert.equal(Object.keys(metadata.optionalDependencies).length, 6); }
}
for (const filename of [...files.filter(f => f !== root), root]) {
  execFileSync('npm', ['publish', path.join('distribution', filename), '--access', 'public', '--provenance', '--tag', expectedChannel], { stdio: 'inherit' });
}
