'use strict';
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const pkg = require('../package.json');
const { tarballName } = require('./package-identity.js');
const root = process.cwd();
const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'icmp-install-'));
try {
  const suffix = `${process.platform}-${process.arch}${process.platform === 'linux' ? '-gnu' : process.platform === 'win32' ? '-msvc' : ''}`;
  const nativeName = `${pkg.name}-${suffix}`;
  if (!pkg.optionalDependencies[nativeName]) throw new Error(`Unsupported install-test target ${suffix}`);
  fs.writeFileSync(path.join(temp, 'package.json'), JSON.stringify({ private: true, dependencies: { [nativeName]: `file:${path.join(root, tarballName(nativeName, pkg.version))}` } }));
  execFileSync('npm', ['install', '--ignore-scripts', '--no-audit', '--no-fund'], { cwd: temp, stdio: 'inherit' });
  execFileSync('npm', ['install', '--ignore-scripts', '--no-audit', '--no-fund', '--offline', path.join(root, tarballName(pkg.name, pkg.version))], { cwd: temp, stdio: 'inherit' });
  execFileSync(process.execPath, ['-e', `
    const assert = require('node:assert/strict');
    const fs = require('node:fs');
    const path = require('node:path');
    const root = JSON.parse(fs.readFileSync(path.join(path.dirname(require.resolve('${pkg.name}')), 'package.json')));
    const native = require('${nativeName}/package.json');
    assert.equal(root.name, '${pkg.name}');
    assert.equal(root.version, '${pkg.version}');
    assert.equal(native.name, '${nativeName}');
    assert.equal(native.version, '${pkg.version}');
    import('${pkg.name}').then(esm => assert.equal(esm.ping, require('${pkg.name}').ping));
  `], { cwd: temp, stdio: 'inherit' });
  execFileSync(process.execPath, ['-e', "const {ping}=require('@homebridge/node-icmp-ping'); ping('not-an-ip').then(()=>process.exit(1), e=>{if(!/literal/.test(e.message))process.exit(1)});"], { cwd: temp, stdio: 'inherit' });
  execFileSync('sudo', [process.execPath, '-e', "const {ping}=require('@homebridge/node-icmp-ping'); Promise.all([ping('127.0.0.1'),ping('::1')]).then(r=>{if(!r.every(x=>x.success&&typeof x.latency==='number'))process.exit(1)},e=>{console.error(e);process.exit(1)});"], { cwd: temp, stdio: 'inherit' });
} finally { fs.rmSync(temp, { recursive: true, force: true }); }
