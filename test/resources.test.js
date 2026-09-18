'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const { ping } = require('..');
const { Worker } = require('node:worker_threads');
const path = require('node:path');
function descriptors() {
  if (process.platform !== 'linux') return null;
  return fs.readdirSync('/proc/self/fd').length;
}
test('64 sequential operations release sockets', { timeout: 30000 }, async () => {
  await ping('127.0.0.1'); // initialize worker infrastructure before counting
  const before = descriptors();
  for (let i = 0; i < 64; i++) {
    const result = await ping(i % 2 ? '::1' : '127.0.0.1');
    assert.equal(result.success, true);
  }
  const after = descriptors();
  if (before !== null) assert(after <= before + 1, `Descriptor count grew: ${before} -> ${after}`);
  console.log(`64 successful operations; descriptor counts: ${before} -> ${after}`);
});
test('worker environment termination releases pending native work', { timeout: 15000 }, async () => {
  const modulePath = path.resolve(__dirname, '..');
  const worker = new Worker(`const { parentPort } = require('node:worker_threads'); const { ping } = require(${JSON.stringify(modulePath)}); const p = ping('192.0.2.1'); p.catch(() => {}); parentPort.postMessage('started');`, { eval: true });
  await new Promise((resolve, reject) => { worker.once('message', resolve); worker.once('error', reject); });
  const started = Date.now();
  await worker.terminate();
  assert(Date.now() - started < 10000, 'Worker shutdown exceeded bounded operation duration');
});
