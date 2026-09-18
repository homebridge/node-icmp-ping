'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { ping } = require('..');
test('single CommonJS export and shared ESM implementation', async () => {
  assert.deepEqual(Object.keys(require('..')), ['ping']);
  const esm = await import('../index.mjs');
  assert.equal(esm.ping, ping);
});
test('invalid arguments always return rejected Promises', async () => {
  for (const value of [undefined, null, 42, {}, [], true]) {
    const promise = ping(value);
    assert(promise instanceof Promise);
    await assert.rejects(promise, TypeError);
  }
  await assert.rejects(ping(), TypeError);
  await assert.rejects(ping('127.0.0.1', {}), TypeError);
});
test('native IP parser rejects hostnames and malformed/scoped literals', async () => {
  for (const value of ['not-an-ip', 'localhost', '', '127.1', '256.0.0.1', '1.2.3.4\0', '[::1]', 'fe80::1%eth0']) {
    await assert.rejects(ping(value), /literal|InvalidArg/);
  }
});
test('native addon rejects direct non-string arguments', async () => {
  const native = require('../binding.js');
  assert.throws(() => native.ping(42));
});
test('release channels cannot promote prereleases to latest', () => {
  const { channel } = require('../scripts/release-policy.js');
  assert.equal(channel('1.0.0', false), 'latest');
  assert.equal(channel('1.0.0-beta.1', true), 'next');
  assert.throws(() => channel('1.0.0-beta.1', false));
  assert.throws(() => channel('1.0.0', true));
  for (const version of ['01.0.0', '1.0.0-beta..1', '1.0.0-01', '1.0.0;echo']) assert.throws(() => channel(version, true));
});
