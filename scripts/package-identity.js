'use strict';
const assert = require('node:assert/strict');
const rootName = '@homebridge/node-icmp-ping';
const platforms = [
  'linux-x64-gnu', 'linux-arm64-gnu',
  'darwin-x64', 'darwin-arm64',
  'win32-x64-msvc', 'win32-arm64-msvc',
];
const nativeNames = platforms.map(platform => `${rootName}-${platform}`);
const packageNames = [...nativeNames, rootName];
function tarballName(name, version) {
  assert(packageNames.includes(name), `Unexpected distribution package: ${name}`);
  // npm pack removes the leading @ and replaces the scope separator with -.
  return `${name.slice(1).replace('/', '-')}-${version}.tgz`;
}
module.exports = { rootName, platforms, nativeNames, packageNames, tarballName };
