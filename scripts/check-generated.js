'use strict';
const fs = require('node:fs');
const assert = require('node:assert/strict');
const api = require('../binding.js');
assert.deepEqual(Object.keys(api), ['ping']);
fs.rmSync('native.d.ts', { force: true });
