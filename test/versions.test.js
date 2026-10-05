'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { validateVersions } = require('../scripts/check-versions.js');
function fixture() {
  return { pkg: { version: '1.0.1' }, lock: { version: '1.0.1', packages: { '': { version: '1.0.1' } } },
    cargo: '[package]\nname = "node-icmp-ping"\nversion = "1.0.1"\n[dependencies]\n',
    cargoLock: 'version = 4\n[[package]]\nname = "dependency"\nversion = "9.9.9"\n[[package]]\nname = "node-icmp-ping"\nversion = "1.0.1"\n' };
}
test('compares root package versions, not dependency versions', () => validateVersions(fixture()));
for (const field of ['pkg', 'lock', 'lockRoot', 'cargo', 'cargoLock']) {
  test(`reports every version when ${field} disagrees`, () => {
    const f = fixture();
    if (field === 'lockRoot') f.lock.packages[''].version = '2.0.0';
    else if (typeof f[field] === 'string') f[field] = f[field].replace('1.0.1', '2.0.0');
    else f[field].version = '2.0.0';
    assert.throws(() => validateVersions(f), error => {
      for (const label of ['package.json', 'package-lock.json (top level)', 'package-lock.json (root package)', 'Cargo.toml', 'Cargo.lock (node-icmp-ping)', '1.0.1', '2.0.0']) assert(error.message.includes(label));
      return true;
    });
  });
}
test('missing Cargo root version fails clearly', () => {
  const f = fixture(); f.cargoLock = '';
  assert.throws(() => validateVersions(f), /Cargo.lock \(node-icmp-ping\): \(missing\)/);
});
