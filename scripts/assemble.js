'use strict';
const fs = require('node:fs');
const path = require('node:path');
const assert = require('node:assert/strict');
const { execFileSync } = require('node:child_process');
const { targets } = require('./package-identity.js');
const { inspectTarball } = require('./check-package.js');

function assemble(artifactDirectory = 'artifacts', outputDirectory = 'distribution') {
  const inputs = Object.entries(targets).map(([target, platform]) =>
    [path.join(artifactDirectory, `bindings-${target}`, `icmp_ping.${platform}.node`), `icmp_ping.${platform}.node`]);
  // napi-rs emits the same platform-independent loader on every build.
  inputs.push([path.join(artifactDirectory, 'bindings-x86_64-unknown-linux-gnu', 'binding.js'), 'binding.js']);
  const missing = inputs.filter(([source]) => !fs.existsSync(source)).map(([source]) => source);
  assert.equal(missing.length, 0, `Missing build artifacts:\n${missing.join('\n')}`);
  for (const [source, destination] of inputs) fs.copyFileSync(source, destination);
  fs.mkdirSync(outputDirectory, { recursive: true });
  const [result] = JSON.parse(execFileSync('npm', ['pack', '--json', '--ignore-scripts', '--pack-destination', path.resolve(outputDirectory)],
    { encoding: 'utf8', shell: process.platform === 'win32' }));
  inspectTarball(path.join(outputDirectory, result.filename));
  return result;
}
if (require.main === module) assemble();
module.exports = { assemble };
