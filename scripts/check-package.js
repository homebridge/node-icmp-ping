'use strict';
const fs = require('node:fs');
const assert = require('node:assert/strict');
const { execFileSync } = require('node:child_process');
const { packageFiles, tarballName } = require('./package-identity.js');
const pkg = require('../package.json');

function inspectTarball(tarball) {
  assert(fs.statSync(tarball).size > 0, `Empty tarball: ${tarball}`);
  const files = execFileSync('tar', ['-tf', tarball], { encoding: 'utf8' }).trim().split(/\r?\n/);
  const missing = packageFiles.filter(file => !files.includes(`package/${file}`));
  assert.equal(missing.length, 0, `Missing package files: ${missing.join(', ')}`);
  console.log(`Validated ${packageFiles.length} expected files in ${tarball}`);
}
if (require.main === module) inspectTarball(process.argv[2] || `distribution/${tarballName(pkg.name, pkg.version)}`);
module.exports = { inspectTarball };
