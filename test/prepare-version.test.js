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

function fixture(t) {
  const root = path.resolve(__dirname, '..');
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'prepare-version-'));
  t.after(() => fs.rmSync(temp, { recursive: true, force: true }));
  fs.cpSync(path.join(root, 'scripts'), path.join(temp, 'scripts'), { recursive: true });
  for (const file of ['package.json', 'package-lock.json', 'Cargo.toml', 'Cargo.lock']) fs.copyFileSync(path.join(root, file), path.join(temp, file));
  return temp;
}
const files = ['package.json', 'package-lock.json', 'Cargo.toml', 'Cargo.lock'];
const contents = root => files.map(file => fs.readFileSync(path.join(root, file), 'utf8'));
const run = (root, args) => spawnSync(process.execPath, ['scripts/prepare-version.js', ...args], { cwd: root, encoding: 'utf8' });

for (const version of ['1.0.1', '1.1.0-beta.1']) test(`prepares only authoritative version sources without build dependencies for ${version}`, t => {
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
  assert(!fs.existsSync(path.join(root, 'binding.js')));
  assert.match(result.stdout, /Nothing was staged or committed/);
  assert.equal(run(root, [version]).status, 0); // Repeating version preparation is harmless.
  assert.deepEqual(contents(root), after);
});

test('invalid CLI input leaves every version source untouched', t => {
  const root = fixture(t);
  const before = contents(root);
  assert.equal(run(root, ['patch']).status, 1);
  assert.deepEqual(contents(root), before);
});
