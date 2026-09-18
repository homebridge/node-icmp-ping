'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { ping } = require('..');
function shape(result) {
  assert.deepEqual(Object.keys(result).sort(), ['latency', 'message', 'success']);
  assert.equal(result.success, true);
  assert.equal(typeof result.latency, 'number');
  assert(Number.isFinite(result.latency) && result.latency >= 0);
  assert.equal(result.message, '');
}
for (const address of ['127.0.0.1', '::1']) {
  test(`real raw ICMP Echo ${address}`, { timeout: 15000 }, async () => shape(await ping(address)));
}
test('concurrent raw probes are independent', { timeout: 30000 }, async () => {
  const results = await Promise.all(Array.from({ length: 12 }, (_, i) => ping(i % 2 ? '::1' : '127.0.0.1')));
  results.forEach(shape);
});
test('event loop remains responsive during native work', async () => {
  const operation = ping('127.0.0.1');
  await new Promise(resolve => setImmediate(resolve));
  shape(await operation);
});
