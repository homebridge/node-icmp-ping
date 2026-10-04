'use strict';
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const pkg = require('../package.json');
require('./check-runtime.js').checkRuntime();
const { tarballName } = require('./package-identity.js');
const tarball = path.resolve(process.argv[2] || 'distribution', tarballName(pkg.name, pkg.version));
const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'icmp-install-'));
try {
  fs.writeFileSync(path.join(temp, 'package.json'), JSON.stringify({ private: true }));
  execFileSync('npm', ['install', '--ignore-scripts', '--no-audit', '--no-fund', '--offline', tarball], { cwd: temp, stdio: 'inherit', shell: process.platform === 'win32' });
  execFileSync(process.execPath, ['-e', `
    const assert = require('node:assert/strict');
    const path = require('node:path');
    const directory = path.dirname(require.resolve('${pkg.name}'));
    const api = require('${pkg.name}');
    assert.deepEqual(Object.keys(api), ['ping']);
    if (process.env.EXPECTED_LIBC) {
      const expected = path.join(directory, 'icmp_ping.linux-' + process.arch + '-' + process.env.EXPECTED_LIBC + '.node');
      assert.deepEqual(Object.keys(require.cache).filter(file => file.endsWith('.node')), [expected]);
    }
    (async () => {
      const esm = await import('${pkg.name}');
      assert.equal(esm.ping, api.ping);
      await assert.rejects(api.ping('not-an-ip'), /literal/);
    })().catch(error => { console.error(error); process.exitCode = 1; });
  `], { cwd: temp, stdio: 'inherit' });
  const installed = path.join(temp, 'node_modules', pkg.name);
  fs.mkdirSync(path.join(installed, 'test'));
  for (const file of ['api.test.js', 'integration.test.js', 'resources.test.js']) {
    fs.copyFileSync(path.join(__dirname, '..', 'test', file), path.join(installed, 'test', file));
  }
  const echo = [process.execPath, '--test', ...['api.test.js', 'integration.test.js', 'resources.test.js']
    .map(file => path.join(installed, 'test', file))];
  if (process.platform === 'win32' || process.getuid() === 0) {
    execFileSync(echo[0], echo.slice(1), { cwd: temp, stdio: 'inherit' });
  } else {
    execFileSync('sudo', ['-n', ...echo], { cwd: temp, stdio: 'inherit' });
  }
  console.log(`Installed and tested ${pkg.name}@${pkg.version} on ${process.platform}/${process.arch}, Node ${process.version}`);
} finally { fs.rmSync(temp, { recursive: true, force: true }); }
