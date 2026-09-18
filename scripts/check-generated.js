'use strict';
const fs = require('node:fs');
const assert = require('node:assert/strict');
const api = require('../binding.js');
assert.equal(typeof api.ping, 'function');
assert.deepEqual(Object.keys(require('../index.js')), ['ping']);
fs.rmSync('native.d.ts', { force: true });
