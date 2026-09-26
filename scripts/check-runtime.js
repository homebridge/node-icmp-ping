'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs');

// Check the running process, not the host label or the generated loader heuristic.
function checkRuntime() {
  const { EXPECTED_ARCH: arch, EXPECTED_LIBC: libc, EXPECTED_NODE: node } = process.env;
  if (arch) assert.equal(process.arch, arch, 'Wrong native runtime architecture');
  if (node) assert.equal(process.versions.node.split('.')[0], node, 'Wrong Node major');
  if (libc) {
    assert.equal(process.platform, 'linux');
    assert(['gnu', 'musl'].includes(libc), 'Unknown expected libc');
    const glibc = process.report.getReport().header.glibcVersionRuntime;
    const musl = /\/[^\s]*ld-musl-[^\s/]+\.so\.1/.test(fs.readFileSync('/proc/self/maps', 'utf8'));
    assert.equal(musl, libc === 'musl', 'Unexpected mapped musl runtime');
    assert.equal(Boolean(glibc), libc === 'gnu', 'Unexpected glibc runtime');
  }
  console.log(JSON.stringify({ node: process.version, arch: process.arch, platform: process.platform, libc }));
}
if (require.main === module) checkRuntime();
module.exports = { checkRuntime };
