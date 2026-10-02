'use strict';
const fs = require('node:fs');
const path = require('node:path');
const assert = require('node:assert/strict');
const { execFileSync } = require('node:child_process');
const { validateVersions } = require('./release-check.js');

function checkLoader(committed, generated) {
  // Git may check out CRLF on Windows; generation always emits LF.
  assert.equal(generated, committed.replace(/\r\n/g, '\n'),
    'Committed binding.js differs from the pinned generator. Run npm ci && npm run build, review and commit binding.js in the version PR.');
}

function build(args = process.argv.slice(2)) {
  const root = path.resolve(__dirname, '..');
  const pkg = require('../package.json');
  validateVersions({ pkg, lock: require('../package-lock.json'),
    cargo: fs.readFileSync(path.join(root, 'Cargo.toml'), 'utf8'),
    cargoLock: fs.readFileSync(path.join(root, 'Cargo.lock'), 'utf8') });
  const cliPackage = require.resolve('@napi-rs/cli/package.json');
  assert.equal(require(cliPackage).version, pkg.devDependencies['@napi-rs/cli'], 'Run npm ci to install the pinned generator');
  const write = args.includes('--write');
  const targetArgs = args.filter(arg => arg !== '--write');
  assert(targetArgs.length === 0 || (targetArgs.length === 2 && targetArgs[0] === '--target' && pkg.napi.targets.includes(targetArgs[1])), 'Expected only --write and/or --target <supported target>');
  const generated = fs.mkdtempSync(path.join(root, '.generated-'));
  try {
    execFileSync(process.execPath, [path.join(path.dirname(cliPackage), 'cli.mjs'), 'build', '--platform', '--release',
      '--output-dir', generated, '--js', 'binding.js', '--dts', 'native.d.ts', ...targetArgs, '--', '--locked'], { cwd: root, stdio: 'inherit' });
    const loader = fs.readFileSync(path.join(generated, 'binding.js'), 'utf8');
    const committed = path.join(root, 'binding.js');
    if (write) fs.writeFileSync(committed, loader);
    else checkLoader(fs.readFileSync(committed, 'utf8'), loader);
    // Only build outputs leave the temporary directory in CI; source stays untouched.
    for (const file of fs.readdirSync(generated).filter(file => file.endsWith('.node'))) {
      fs.copyFileSync(path.join(generated, file), path.join(root, file));
    }
    assert.equal(typeof require('../binding.js').ping, 'function');
    assert.deepEqual(Object.keys(require('../index.js')), ['ping']);
  } finally { fs.rmSync(generated, { recursive: true, force: true }); }
}
if (require.main === module) build();
module.exports = { checkLoader, build };
