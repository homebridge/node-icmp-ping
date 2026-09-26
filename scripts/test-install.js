'use strict';
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const pkg = require('../package.json');
require('./check-runtime.js').checkRuntime();
const { packageFiles } = require('./package-identity.js');
const channel = require('./release-policy.js').channel(pkg.version, pkg.version.includes('-'));
const item = require('./publish.js').preflight(process.argv[2] || 'distribution', channel);
const tarball = path.resolve(item.tarball);
const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'icmp-install-'));
try {
  fs.writeFileSync(path.join(temp, 'package.json'), JSON.stringify({ private: true }));
  execFileSync('npm', ['install', '--ignore-scripts', '--no-audit', '--no-fund', '--offline', tarball], { cwd: temp, stdio: 'inherit', shell: process.platform === 'win32' });
  execFileSync(process.execPath, ['-e', `
    const assert = require('node:assert/strict');
    const fs = require('node:fs');
    const path = require('node:path');
    const directory = path.dirname(require.resolve('${pkg.name}'));
    const metadata = JSON.parse(fs.readFileSync(path.join(directory, 'package.json')));
    assert.equal(metadata.name, '${pkg.name}');
    assert.equal(metadata.version, '${pkg.version}');
    assert.equal(Object.keys(metadata.optionalDependencies || {}).length, 0);
    for (const file of ${JSON.stringify(packageFiles)}) assert(fs.statSync(path.join(directory, file)).size > 0);
    const lock = JSON.parse(fs.readFileSync('package-lock.json'));
    assert.deepEqual(Object.keys(lock.packages).sort(), ['', 'node_modules/${pkg.name}']);
    assert.equal(lock.packages['node_modules/${pkg.name}'].integrity, '${item.integrity}');
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
  const echo = [process.execPath, '-e', `
    const assert = require('node:assert/strict');
    const {ping} = require('${pkg.name}');
    Promise.all([ping('127.0.0.1'), ping('::1')]).then(results => {
      for (const result of results) {
        assert.equal(result.success, true, JSON.stringify(result));
        assert.equal(typeof result.latency, 'number');
      }
    }).catch(error => { console.error(error); process.exitCode = 1; });
  `];
  if (process.platform === 'win32' || process.getuid() === 0) {
    execFileSync(echo[0], echo.slice(1), { cwd: temp, stdio: 'inherit' });
  } else {
    execFileSync('sudo', ['-n', ...echo], { cwd: temp, stdio: 'inherit' });
  }
  console.log(`Installed and tested ${item.name}@${item.version} on ${process.platform}/${process.arch}, Node ${process.version}; ${item.integrity}`);
} finally { fs.rmSync(temp, { recursive: true, force: true }); }
