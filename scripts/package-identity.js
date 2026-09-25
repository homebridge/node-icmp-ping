'use strict';
const assert = require('node:assert/strict');
const rootName = '@homebridge/node-icmp-ping';
const targets = {
  'x86_64-unknown-linux-gnu': 'linux-x64-gnu',
  'aarch64-unknown-linux-gnu': 'linux-arm64-gnu',
  'x86_64-unknown-linux-musl': 'linux-x64-musl',
  'aarch64-unknown-linux-musl': 'linux-arm64-musl',
  'x86_64-apple-darwin': 'darwin-x64',
  'aarch64-apple-darwin': 'darwin-arm64',
  'x86_64-pc-windows-msvc': 'win32-x64-msvc',
  'aarch64-pc-windows-msvc': 'win32-arm64-msvc',
};
const platforms = Object.values(targets);
const binaries = platforms.map(platform => `icmp_ping.${platform}.node`);
const packageFiles = ['package.json', 'index.js', 'index.mjs', 'index.d.ts', 'binding.js',
  'README.md', 'LICENSE', 'docs/platforms.md', 'docs/releasing.md', ...binaries];
function tarballName(name, version) {
  assert.equal(name, rootName, `Unexpected distribution package: ${name}`);
  return `${name.slice(1).replace('/', '-')}-${version}.tgz`;
}
module.exports = { rootName, targets, platforms, binaries, packageFiles, tarballName };
