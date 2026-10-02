'use strict';
const fs = require('node:fs');
const path = require('node:path');
const assert = require('node:assert/strict');
const { execFileSync } = require('node:child_process');
const pkg = require('../package.json');
const { targets, binaries, tarballName } = require('./package-identity.js');
const { checkManifest, inspectTarball, integrity } = require('./check-package.js');

function assemble(artifactDirectory = 'artifacts', outputDirectory = 'distribution') {
  checkManifest(pkg);
  const directories = Object.keys(targets).map(target => `bindings-${target}`);
  assert.deepEqual(fs.readdirSync(artifactDirectory).sort(), directories.sort(), 'All eight intended build artifacts are required');
  // napi-rs emits a platform-independent loader; choose one fixed build artifact.
  const loader = fs.readFileSync(path.join(artifactDirectory, 'bindings-x86_64-unknown-linux-gnu', 'binding.js'));
  assert(loader.length > 0, 'Empty generated loader');
  const inputs = Object.entries(targets).map(([target, platform]) => {
    const dir = path.join(artifactDirectory, `bindings-${target}`);
    const filename = `icmp_ping.${platform}.node`;
    assert.deepEqual(fs.readdirSync(dir).sort(), ['binding.js', filename].sort(), `Unexpected files for ${target}`);
    const bytes = fs.readFileSync(path.join(dir, filename));
    assert(bytes.length > 0, `Empty binary for ${target}`);
    return { filename, bytes };
  });
  assert(!fs.existsSync(outputDirectory) || fs.readdirSync(outputDirectory).length === 0, 'Distribution directory must be empty; preserve original release artifacts');
  const extra = fs.readdirSync('.').filter(f => f.endsWith('.node') && !binaries.includes(f));
  assert.equal(extra.length, 0, `Unexpected local binaries: ${extra}`);
  fs.mkdirSync(outputDirectory, { recursive: true });
  inputs.push({ filename: 'binding.js', bytes: loader });
  for (const { filename, bytes } of inputs) fs.writeFileSync(filename, bytes);
  const [result] = JSON.parse(execFileSync('npm', ['pack', '--json', '--ignore-scripts', '--pack-destination', path.resolve(outputDirectory)], { encoding: 'utf8', shell: process.platform === 'win32' }));
  assert.equal(result.filename, tarballName(pkg.name, pkg.version));
  const tarball = path.join(outputDirectory, result.filename);
  inspectTarball(tarball);
  // Verify pack copied the exact loader and binaries tested by the eight prebuild jobs.
  for (const { filename, bytes } of inputs) {
    assert.deepEqual(execFileSync('tar', ['-xOf', tarball, `package/${filename}`], { maxBuffer: 16 * 1024 * 1024 }), bytes);
  }
  for (const { filename, bytes } of inputs) console.log(`${filename}: ${bytes.length} bytes`);
  const sri = integrity(fs.readFileSync(tarball));
  assert.equal(result.integrity, sri);
  fs.writeFileSync(path.join(outputDirectory, 'integrity.json'), JSON.stringify({ name: pkg.name, version: pkg.version, filename: result.filename, integrity: sri }, null, 2) + '\n');
  console.log(`Validated ${result.filename}: ${result.size} bytes compressed; ${result.unpackedSize} bytes unpacked; ${result.entryCount} files`);
  return result;
}
if (require.main === module) assemble();
module.exports = { assemble };
