'use strict';
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const pkg = require('../package.json');
const root = process.cwd();
const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'icmp-install-'));
try {
  fs.writeFileSync(path.join(temp, 'package.json'), JSON.stringify({ private: true, dependencies: Object.fromEntries(Object.entries(pkg.optionalDependencies).map(([name, version]) => [name, `file:${path.join(root, `${name}-${version}.tgz`)}`])) }));
  execFileSync('npm', ['install', '--ignore-scripts', '--force'], { cwd: temp, stdio: 'inherit' });
  execFileSync('npm', ['install', '--ignore-scripts', '--offline', path.join(root, `${pkg.name}-${pkg.version}.tgz`)], { cwd: temp, stdio: 'inherit' });
  execFileSync(process.execPath, ['-e', "const {ping}=require('node-icmp-ping'); ping('not-an-ip').then(()=>process.exit(1), e=>{if(!/literal/.test(e.message))process.exit(1)});"], { cwd: temp, stdio: 'inherit' });
  execFileSync('sudo', [process.execPath, '-e', "const {ping}=require('node-icmp-ping'); Promise.all([ping('127.0.0.1'),ping('::1')]).then(r=>{if(!r.every(x=>x.success&&typeof x.latency==='number'))process.exit(1)},e=>{console.error(e);process.exit(1)});"], { cwd: temp, stdio: 'inherit' });
} finally { fs.rmSync(temp, { recursive: true, force: true }); }
