'use strict';
// A private network namespace: no changes to the host's firewall or routes.
const { execFileSync } = require('node:child_process');
const path = require('node:path');
const ns = `icmp-test-${process.pid}`;
try {
  execFileSync('ip', ['netns', 'add', ns]);
  execFileSync('ip', ['-n', ns, 'link', 'set', 'lo', 'up']);
  execFileSync('ip', ['netns', 'exec', ns, process.execPath, path.resolve(__dirname, '../test/loss.cjs')], { stdio: 'inherit' });
} finally {
  try { execFileSync('ip', ['netns', 'del', ns]); } catch { /* preserve original failure */ }
}
