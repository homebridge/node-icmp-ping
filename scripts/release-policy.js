'use strict';
const assert = require('node:assert/strict');
function channel(version, prerelease) {
  assert(/^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?$/.test(version), 'Invalid release version');
  const suffix = version.split('-').slice(1).join('-');
  if (suffix) for (const part of suffix.split('.')) assert(!/^0\d+$/.test(part), 'Invalid numeric prerelease identifier');
  assert.equal(prerelease, !!suffix, 'Release prerelease flag mismatches version');
  return suffix ? 'next' : 'latest';
}
module.exports = { channel };
