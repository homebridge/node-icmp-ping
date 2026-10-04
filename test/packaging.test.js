'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const { targets, binaries, packageFiles } = require('../scripts/package-identity.js');
const { inspectTarball } = require('../scripts/check-package.js');

function fixture(t) {
  const source = fs.mkdtempSync(path.join(os.tmpdir(), 'icmp-pack-'));
  t.after(() => fs.rmSync(source, { recursive: true, force: true }));
  for (const file of packageFiles.filter(file => !binaries.includes(file) && file !== 'binding.js')) {
    fs.mkdirSync(path.dirname(path.join(source, file)), { recursive: true });
    fs.copyFileSync(path.join(__dirname, '..', file), path.join(source, file));
  }
  fs.copyFileSync(path.join(__dirname, '../.gitignore'), path.join(source, '.gitignore'));
  fs.cpSync(path.join(__dirname, '../scripts'), path.join(source, 'scripts'), { recursive: true });
  for (const [target, platform] of Object.entries(targets)) {
    const dir = path.join(source, 'artifacts', `bindings-${target}`);
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, `icmp_ping.${platform}.node`), 'fixture binary');
    fs.writeFileSync(path.join(dir, 'binding.js'), 'fixture generated loader');
  }
  return source;
}
test('assembly packages generated loader and all eight artifacts without a checkout loader', t => {
  const source = fixture(t);
  execFileSync(process.execPath, ['scripts/assemble.js'], { cwd: source });
  assert.equal(fs.readFileSync(path.join(source, 'binding.js'), 'utf8'), 'fixture generated loader');
  const distribution = path.join(source, 'distribution');
  const files = fs.readdirSync(distribution);
  assert.equal(files.length, 1);
  inspectTarball(path.join(distribution, files[0]));
});
test('assembly names every missing binary before packaging', t => {
  const source = fixture(t);
  for (const [target, platform] of Object.entries(targets)) {
    fs.unlinkSync(path.join(source, 'artifacts', `bindings-${target}`, `icmp_ping.${platform}.node`));
  }
  assert.throws(() => execFileSync(process.execPath, ['scripts/assemble.js'], { cwd: source, stdio: 'pipe' }), error => {
    for (const file of binaries) assert(error.stderr.toString().includes(file));
    return true;
  });
  assert.equal(fs.existsSync(path.join(source, 'distribution')), false);
});
test('content check names missing public files and rejects an empty tarball', t => {
  const source = fixture(t);
  const tarball = path.join(source, 'incomplete.tgz');
  fs.mkdirSync(path.join(source, 'package'));
  fs.copyFileSync(path.join(source, 'package.json'), path.join(source, 'package/package.json'));
  execFileSync('tar', ['-czf', tarball, 'package'], { cwd: source });
  assert.throws(() => inspectTarball(tarball), /Missing package files:.*index.js.*binding.js.*icmp_ping/);
  fs.writeFileSync(tarball, '');
  assert.throws(() => inspectTarball(tarball), /Empty tarball/);
});
