'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { checkLoader } = require('../scripts/check-generated.js');

test('generated loader equals committed loader, allowing checkout CRLF only', () => {
  checkLoader('generated\n', 'generated\n');
  checkLoader('generated\r\n', 'generated\n');
});
for (const committed of ["version = '1.0.0'\n", 'unreviewed change\n', 'generated']) {
  test(`generated mismatch rejects ${JSON.stringify(committed)} with correction instructions and diff`, () => {
    assert.throws(() => checkLoader(committed, 'generated\n'), error => {
      assert.match(error.message, /npm ci && npm run build/);
      assert.equal(error.actual, 'generated\n');
      assert.equal(error.expected, committed);
      return true;
    });
  });
}

for (const mismatch of [false, true]) test(`build gate preserves tracked source (mismatch: ${mismatch})`, t => {
  const fs = require('node:fs');
  const os = require('node:os');
  const path = require('node:path');
  const { spawnSync } = require('node:child_process');
  const root = path.resolve(__dirname, '..');
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'generated-check-'));
  t.after(() => fs.rmSync(temp, { recursive: true, force: true }));
  fs.cpSync(path.join(root, 'scripts'), path.join(temp, 'scripts'), { recursive: true });
  for (const file of ['package.json', 'package-lock.json', 'Cargo.toml', 'Cargo.lock']) fs.copyFileSync(path.join(root, file), path.join(temp, file));
  const original = 'module.exports = { ping() {} };\n';
  fs.writeFileSync(path.join(temp, 'binding.js'), original);
  fs.writeFileSync(path.join(temp, 'index.js'), "module.exports = require('./binding.js');\n");
  const cli = path.join(temp, 'node_modules/@napi-rs/cli');
  fs.mkdirSync(cli, { recursive: true });
  fs.writeFileSync(path.join(cli, 'package.json'), JSON.stringify({ version: require('../package.json').devDependencies['@napi-rs/cli'] }));
  const sourceFiles = ['binding.js', 'index.js', 'package.json', 'package-lock.json', 'Cargo.toml', 'Cargo.lock'];
  const before = sourceFiles.map(file => fs.readFileSync(path.join(temp, file)));
  const script = `
    const fs = require('node:fs');
    const path = require('node:path');
    const assert = require('node:assert/strict');
    require('node:child_process').execFileSync = (command, args, options) => {
      assert.equal(command, process.execPath);
      assert.deepEqual(args.slice(-2), ['--', '--locked']);
      assert.equal(fs.realpathSync(options.cwd), fs.realpathSync(${JSON.stringify(temp)}));
      const output = args[args.indexOf('--output-dir') + 1];
      assert.notEqual(output, options.cwd);
      fs.writeFileSync(path.join(output, 'binding.js'), ${JSON.stringify(original + (mismatch ? '// generator changed\n' : ''))});
      fs.writeFileSync(path.join(output, 'native.d.ts'), 'temporary declaration');
    };
    require('./scripts/check-generated.js').build([]);
  `;
  const result = spawnSync(process.execPath, ['-e', script], { cwd: temp, encoding: 'utf8' });
  assert.equal(result.status, mismatch ? 1 : 0, result.stderr);
  if (mismatch) assert.match(result.stderr, /Committed binding.js differs/);
  assert.deepEqual(sourceFiles.map(file => fs.readFileSync(path.join(temp, file))), before);
  assert.equal(fs.readdirSync(temp).some(file => file.startsWith('.generated-')), false);
  assert.equal(fs.existsSync(path.join(temp, 'native.d.ts')), false);
});
