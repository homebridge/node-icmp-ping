'use strict';
const fs = require('node:fs');
const path = require('node:path');
const assert = require('node:assert/strict');
const { execFileSync } = require('node:child_process');
const { validateVersions } = require('./check-versions.js');

function build(args = process.argv.slice(2)) {
  const root = path.resolve(__dirname, '..');
  const pkg = require('../package.json');
  validateVersions({ pkg, lock: require('../package-lock.json'),
    cargo: fs.readFileSync(path.join(root, 'Cargo.toml'), 'utf8'),
    cargoLock: fs.readFileSync(path.join(root, 'Cargo.lock'), 'utf8') });
  const cliPackage = require.resolve('@napi-rs/cli/package.json');
  assert.equal(require(cliPackage).version, pkg.devDependencies['@napi-rs/cli'], 'Run npm ci to install the pinned generator');
  const targetArgs = args;
  assert(targetArgs.length === 0 || (targetArgs.length === 2 && targetArgs[0] === '--target' && pkg.napi.targets.includes(targetArgs[1])), 'Expected only --target <supported target>');
  const generated = fs.mkdtempSync(path.join(root, '.generated-'));
  try {
    execFileSync(process.execPath, [path.join(path.dirname(cliPackage), 'cli.mjs'), 'build', '--platform', '--release',
      '--output-dir', generated, '--js', 'binding.js', '--dts', 'native.d.ts', ...targetArgs, '--', '--locked'], { cwd: root, stdio: 'inherit', env: { ...process.env, npm_new_version: pkg.version } });
    fs.copyFileSync(path.join(generated, 'binding.js'), path.join(root, 'binding.js'));
    for (const file of fs.readdirSync(generated).filter(file => file.endsWith('.node'))) {
      fs.copyFileSync(path.join(generated, file), path.join(root, file));
    }
  } finally { fs.rmSync(generated, { recursive: true, force: true }); }
}
if (require.main === module) build();
module.exports = { build };
