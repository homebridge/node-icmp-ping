'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { versionArgument } = require('../scripts/prepare-version.js');
const { validateVersions } = require('../scripts/release-check.js');

for (const version of ['0.0.0', '1.0.1', '2.0.0-beta.1', '1.2.3-rc-1', '1.2.3-0']) {
  test(`accepts explicit release version ${version}`, () => assert.equal(versionArgument([version]), version));
}
for (const args of [[], ['1.0.1', 'extra'], [''], ['patch'], ['v1.0.1'], ['1.2'], ['^1.0.0'], ['01.2.3'], ['1.2.3-01'], ['1.2.3-beta..1'], ['1.2.3+build.1'], ['1.2.3\n'], [' 1.2.3'], ['--help']]) {
  test(`rejects ${JSON.stringify(args)}`, () => assert.throws(() => versionArgument(args)));
}

function fixture(t, fail = false) {
  const root = path.resolve(__dirname, '..');
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'prepare-version-'));
  t.after(() => fs.rmSync(temp, { recursive: true, force: true }));
  fs.cpSync(path.join(root, 'scripts'), path.join(temp, 'scripts'), { recursive: true });
  for (const file of ['package.json', 'package-lock.json', 'Cargo.toml', 'Cargo.lock']) fs.copyFileSync(path.join(root, file), path.join(temp, file));
  fs.writeFileSync(path.join(temp, 'binding.js'), 'original loader\n');
  fs.writeFileSync(path.join(temp, 'index.js'), "module.exports = require('./binding.js');\n");
  const cli = path.join(temp, 'node_modules/@napi-rs/cli');
  fs.mkdirSync(cli, { recursive: true });
  fs.writeFileSync(path.join(cli, 'package.json'), JSON.stringify({ version: require('../package.json').devDependencies['@napi-rs/cli'] }));
  fs.writeFileSync(path.join(cli, 'cli.mjs'), `
    import fs from 'node:fs';
    import path from 'node:path';
    import assert from 'node:assert/strict';
    assert.deepEqual(process.argv.slice(-2), ['--', '--locked']);
    assert(process.argv.includes('--release'));
    if (${fail}) process.exit(9);
    const out = process.argv[process.argv.indexOf('--output-dir') + 1];
    const pkg = JSON.parse(fs.readFileSync('package.json'));
    fs.writeFileSync(path.join(out, 'binding.js'), '// generated ' + pkg.version + '\\nmodule.exports = { ping() {} };\\n');
    fs.writeFileSync(path.join(out, 'native.d.ts'), 'temporary');
    fs.writeFileSync(path.join(out, 'icmp_ping.test.node'), 'native output');
  `);
  return temp;
}
const files = ['package.json', 'package-lock.json', 'Cargo.toml', 'Cargo.lock', 'binding.js'];
const contents = root => files.map(file => fs.readFileSync(path.join(root, file), 'utf8'));
const run = (root, args) => spawnSync(process.execPath, ['scripts/prepare-version.js', ...args], { cwd: root, encoding: 'utf8' });

for (const version of ['1.0.1', '1.1.0-beta.1']) test(`prepares all version sources and generated outputs for ${version}`, t => {
  const root = fixture(t);
  const before = contents(root);
  const result = run(root, [version]);
  assert.equal(result.status, 0, result.stderr);
  const after = contents(root);
  const [pkg, lock] = after.slice(0, 2).map(JSON.parse);
  validateVersions({ pkg, lock, cargo: after[2], cargoLock: after[3] });
  assert.equal(pkg.version, version);
  // No dependency versions or other manifest fields change.
  for (let i = 0; i < 2; i++) {
    const previous = JSON.parse(before[i]);
    previous.version = version;
    if (i === 1) previous.packages[''].version = version;
    assert.deepEqual(JSON.parse(after[i]), previous);
  }
  for (let i = 2; i < 4; i++) assert.equal(after[i], before[i].replace(/(name = "node-icmp-ping"\r?\nversion = ")[^"]+/, (_, prefix) => prefix + version));
  assert.match(after[4], new RegExp(`generated ${version.replaceAll('.', '\\.')}`));
  assert.equal(fs.readFileSync(path.join(root, 'icmp_ping.test.node'), 'utf8'), 'native output');
  assert(!fs.existsSync(path.join(root, 'native.d.ts')));
  assert(!fs.readdirSync(root).some(file => file.startsWith('.generated-')));
  assert.match(result.stdout, /Nothing was staged or committed/);
  assert.equal(run(root, [version]).status, 0); // A failed build can be retried at the same version.
  assert.deepEqual(contents(root), after);
});

test('invalid CLI input leaves every version source and loader untouched', t => {
  const root = fixture(t);
  const before = contents(root);
  assert.equal(run(root, ['patch']).status, 1);
  assert.deepEqual(contents(root), before);
});

test('generator failure exits nonzero with recovery instructions and preserves the old loader', t => {
  const root = fixture(t, true);
  const result = run(root, ['1.0.1']);
  assert.equal(result.status, 1);
  assert.match(result.stderr, /Version files remain edited.*rerun the same command/);
  const [pkg, lock, cargo, cargoLock, loader] = contents(root);
  validateVersions({ pkg: JSON.parse(pkg), lock: JSON.parse(lock), cargo, cargoLock });
  assert.equal(JSON.parse(pkg).version, '1.0.1');
  assert.equal(loader, 'original loader\n');
  assert(!fs.readdirSync(root).some(file => file.startsWith('.generated-')));
});
