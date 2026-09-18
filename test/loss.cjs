'use strict';
const assert = require('node:assert/strict');
const { execFileSync } = require('node:child_process');
const fs = require('node:fs');
const { ping } = require('..');
(async () => {
  await ping('127.0.0.1');
  const before = fs.readdirSync('/proc/self/fd').length;
  for (let cycle = 0; cycle < 3; cycle++) {
    execFileSync('ip6tables', ['-A', 'OUTPUT', '-p', 'ipv6-icmp', '--icmpv6-type', 'echo-reply', '-j', 'DROP']);
    execFileSync('iptables', ['-A', 'OUTPUT', '-p', 'icmp', '--icmp-type', 'echo-reply', '-j', 'DROP']);
    try {
      let ticks = 0;
      const timer = setInterval(() => ticks++, 10);
      const started = performance.now();
      let result;
      try { result = await Promise.all([ping('127.0.0.1'), ping('::1')]); } finally { clearInterval(timer); }
      for (const item of result) assert.deepEqual(item, { success: false, latency: null, message: 'Request timed out after 3 attempts' });
      assert(performance.now() - started >= 2800);
      assert(performance.now() - started < 6000);
      assert(ticks > 50, 'JS event loop blocked during timeout');
    } finally {
      execFileSync('ip6tables', ['-D', 'OUTPUT', '-p', 'ipv6-icmp', '--icmpv6-type', 'echo-reply', '-j', 'DROP']);
      execFileSync('iptables', ['-D', 'OUTPUT', '-p', 'icmp', '--icmp-type', 'echo-reply', '-j', 'DROP']);
    }
    assert.equal((await ping('127.0.0.1')).success, true);
  }
  const after = fs.readdirSync('/proc/self/fd').length;
  assert(after <= before + 1, `Descriptors grew ${before} -> ${after}`);
  console.log(`Three real bounded timeout/success cycles; descriptors ${before} -> ${after}`);
})().catch(error => { console.error(error); process.exitCode = 1; });
