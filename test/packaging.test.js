'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const pkg = require('../package.json');
const { targets, binaries, packageFiles, tarballName } = require('../scripts/package-identity.js');
const { integrity, preflight } = require('../scripts/publish.js');
const { checkManifest } = require('../scripts/check-package.js');
const channel = require('../scripts/release-policy.js').channel(pkg.version, pkg.version.includes('-'));

function fixture(fn) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bundled-pack-'));
  try {
    const source = path.join(dir, 'source');
    const distribution = path.join(dir, 'distribution');
    fs.mkdirSync(source);
    fs.mkdirSync(distribution);
    for (const name of packageFiles) {
      fs.mkdirSync(path.dirname(path.join(source, name)), { recursive: true });
      fs.writeFileSync(path.join(source, name), binaries.includes(name) ? `fixture ${name}` : fs.readFileSync(path.join(__dirname, '..', name)));
    }
    // Model the current-version loader produced by a native build.
    const loaderPath = path.join(source, 'binding.js');
    fs.writeFileSync(loaderPath, require('../scripts/loader-version.js').loaderForVersion(fs.readFileSync(loaderPath, 'utf8'), pkg.version));
    function pack() {
      const [result] = JSON.parse(execFileSync('npm', ['pack', '--json', '--ignore-scripts', '--pack-destination', distribution], { cwd: source, encoding: 'utf8', shell: process.platform === 'win32' }));
      fs.writeFileSync(path.join(distribution, 'integrity.json'), JSON.stringify({ name: pkg.name, version: pkg.version, filename: result.filename, integrity: result.integrity }));
      return result;
    }
    fn({ source, distribution, pack });
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
}

test('npm pack contains precisely the API, docs, loader and eight binaries', () => fixture(({ distribution, pack }) => {
  const result = pack();
  assert.equal(result.filename, tarballName(pkg.name, pkg.version));
  assert.deepEqual(result.files.map(f => f.path).sort(), [...packageFiles].sort());
  const item = preflight(distribution, channel);
  assert.equal(item.name, pkg.name);
  assert.equal(item.integrity, integrity(fs.readFileSync(item.tarball)));
  assert.equal(item.integrity, result.integrity);
  assert.throws(() => preflight(distribution, channel === 'next' ? 'latest' : 'next'), /Unsafe release channel/);
}));
for (const fault of ['missing binary', 'missing musl x64', 'missing musl arm64', 'empty binary', 'optional dependency', 'install hook', 'private access', 'wrong version', 'wrong identity', 'unexpected target', 'unexpected file', 'changed loader']) test(`reject package with ${fault}`, () => fixture(({ source, distribution, pack }) => {
  const metadata = structuredClone(pkg);
  if (fault === 'missing binary') fs.rmSync(path.join(source, binaries[0]));
  if (fault.startsWith('missing musl ')) fs.rmSync(path.join(source, `icmp_ping.linux-${fault.split(' ')[2]}-musl.node`));
  if (fault === 'empty binary') fs.writeFileSync(path.join(source, binaries[0]), '');
  if (fault === 'optional dependency') metadata.optionalDependencies = { [`${pkg.name}-linux-x64-gnu`]: pkg.version };
  if (fault === 'install hook') metadata.scripts.install = 'node download.js';
  if (fault === 'private access') metadata.publishConfig.access = 'restricted';
  if (fault === 'wrong version') metadata.version = '99.0.0';
  if (fault === 'wrong identity') metadata.name = 'node-icmp-ping';
  if (fault === 'unexpected target') metadata.napi.targets.push('s390x-unknown-linux-gnu');
  if (fault === 'unexpected file') { metadata.files.push('extra.node'); fs.writeFileSync(path.join(source, 'extra.node'), 'extra'); }
  if (fault === 'changed loader') fs.appendFileSync(path.join(source, 'binding.js'), '\n// changed');
  fs.writeFileSync(path.join(source, 'package.json'), JSON.stringify(metadata));
  pack();
  assert.throws(() => preflight(distribution, channel));
}));
for (const fault of ['missing checksum', 'tampered bytes', 'wrong checksum', 'extra tarball']) test(`reject retained artifact with ${fault}`, () => fixture(({ distribution, pack }) => {
  const result = pack();
  const recordPath = path.join(distribution, 'integrity.json');
  if (fault === 'missing checksum') fs.rmSync(recordPath);
  if (fault === 'tampered bytes') fs.appendFileSync(path.join(distribution, result.filename), 'changed after assembly');
  if (fault === 'wrong checksum') {
    const record = JSON.parse(fs.readFileSync(recordPath));
    record.integrity = integrity(Buffer.from('wrong'));
    fs.writeFileSync(recordPath, JSON.stringify(record));
  }
  if (fault === 'extra tarball') fs.copyFileSync(path.join(distribution, result.filename), path.join(distribution, 'obsolete-native.tgz'));
  assert.throws(() => preflight(distribution, channel));
}));
test('manifest forbids dependencies and each install hook', () => {
  for (const key of ['dependencies', 'optionalDependencies', 'peerDependencies']) {
    assert.throws(() => checkManifest({ ...pkg, [key]: { unexpected: '1.0.0' } }), /Unexpected/);
  }
  for (const name of ['preinstall', 'install', 'postinstall']) {
    assert.throws(() => checkManifest({ ...pkg, scripts: { [name]: 'unsafe' } }), /Forbidden install hook/);
  }
});

test('assembly uses all eight tested artifacts, preserves manifest and refuses to overwrite retention', () => fixture(({ source }) => {
  fs.cpSync(path.join(__dirname, '../scripts'), path.join(source, 'scripts'), { recursive: true });
  const original = fs.readFileSync(path.join(source, 'package.json'));
  const artifacts = path.join(source, 'artifacts');
  for (const [target, platform] of Object.entries(targets)) {
    const dir = path.join(artifacts, `bindings-${target}`);
    fs.mkdirSync(dir, { recursive: true });
    fs.copyFileSync(path.join(source, 'binding.js'), path.join(dir, 'binding.js'));
    fs.writeFileSync(path.join(dir, `icmp_ping.${platform}.node`), `tested ${target}`);
  }
  const run = () => execFileSync(process.execPath, ['scripts/assemble.js'], { cwd: source, encoding: 'utf8', stdio: 'pipe' });
  const first = path.join(artifacts, `bindings-${Object.keys(targets)[0]}`);
  fs.appendFileSync(path.join(first, 'binding.js'), '\n// differs');
  assert.throws(run, /Generated loader differs/);
  fs.copyFileSync(path.join(source, 'binding.js'), path.join(first, 'binding.js'));
  fs.renameSync(first, first + '-wrong');
  assert.throws(run, /All eight intended build artifacts/);
  fs.renameSync(first + '-wrong', first);
  assert.match(run(), /Validated .* bytes compressed/);
  assert.match(execFileSync(process.execPath, ['scripts/check-package.js'], { cwd: source, encoding: 'utf8' }), /Validated 17 files/);
  const loaderPath = path.join(source, 'binding.js');
  const loader = fs.readFileSync(loaderPath, 'utf8');
  fs.writeFileSync(loaderPath, loader.replace(/\n/g, '\r\n'));
  assert.match(execFileSync(process.execPath, ['scripts/check-package.js'], { cwd: source, encoding: 'utf8' }), /Validated 17 files/);
  fs.writeFileSync(loaderPath, loader);
  assert.deepEqual(fs.readFileSync(path.join(source, 'package.json')), original);
  assert.throws(run, /Distribution directory must be empty/);
}));

for (const version of ['1.0.0', '1.1.0-rc.2']) test(`assembly and retained tarball accept a version-only bump to ${version}`, () => fixture(({ source }) => {
  fs.cpSync(path.join(__dirname, '../scripts'), path.join(source, 'scripts'), { recursive: true });
  const metadata = { ...pkg, version };
  fs.writeFileSync(path.join(source, 'package.json'), JSON.stringify(metadata));
  const loaderPath = path.join(source, 'binding.js');
  const reviewed = fs.readFileSync(path.join(__dirname, '../binding.js'), 'utf8');
  fs.writeFileSync(loaderPath, reviewed);
  const generated = reviewed.split(reviewed.match(/bindingPackageVersion !== '([^']+)'/)[1]).join(version);
  const artifacts = path.join(source, 'artifacts');
  for (const [target, platform] of Object.entries(targets)) {
    const dir = path.join(artifacts, `bindings-${target}`);
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, 'binding.js'), generated);
    fs.writeFileSync(path.join(dir, `icmp_ping.${platform}.node`), `tested ${target}`);
  }
  const run = script => execFileSync(process.execPath, [script], { cwd: source, encoding: 'utf8', stdio: 'pipe' });
  // Exercise the last artifact too: every target must match the current version.
  const last = path.join(artifacts, `bindings-${Object.keys(targets).at(-1)}`, 'binding.js');
  for (const bad of [reviewed, generated.replace(version, '9.9.9'), generated + '\n// drift']) {
    fs.writeFileSync(last, bad);
    assert.throws(() => run('scripts/assemble.js'), /Generated loader differs/);
    assert.equal(fs.readFileSync(loaderPath, 'utf8'), reviewed);
    assert.equal(fs.existsSync(path.join(source, 'distribution')), false);
  }
  fs.writeFileSync(last, generated);
  assert.match(run('scripts/assemble.js'), /Validated/);
  assert.equal(fs.readFileSync(loaderPath, 'utf8'), generated);
  // Publish/install jobs start from a fresh checkout with the old reviewed loader.
  fs.writeFileSync(loaderPath, reviewed);
  assert.match(run('scripts/check-package.js'), /Validated 17 files/);
  fs.writeFileSync(loaderPath, reviewed.replace(/\n/g, '\r\n'));
  assert.match(run('scripts/check-package.js'), /Validated 17 files/);
}));
