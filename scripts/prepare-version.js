'use strict';
const fs = require('node:fs');
const path = require('node:path');
const assert = require('node:assert/strict');
const { channel, cargoVersion, validateVersions } = require('./release-check.js');

function versionArgument(args) {
  assert.equal(args.length, 1, 'Usage: npm run prepare-version -- <version>');
  const version = args[0];
  assert(!/\s/.test(version), 'Version must not contain whitespace');
  // Use the same stable/prerelease policy as publication (no build metadata).
  channel(version, version.includes('-'));
  return version;
}

function updateCargo(text, version, lock = false) {
  cargoVersion(text, lock); // Require exactly one named root package before editing.
  const section = lock ? /(^\[\[package\]\][^\S\r\n]*\r?\n)([^[]*)/gm : /(^\[package\][^\S\r\n]*\r?\n)([^[]*)/gm;
  return text.replace(section, (all, header, body) => /^name\s*=\s*"node-icmp-ping"\s*$/m.test(body)
    ? header + body.replace(/^(version\s*=\s*")[^"]+("[^\S\r\n]*\r?$)/m, (_, prefix, suffix) => prefix + version + suffix)
    : all);
}

function prepare(args = process.argv.slice(2)) {
  const version = versionArgument(args);
  const root = path.resolve(__dirname, '..');
  const read = file => fs.readFileSync(path.join(root, file), 'utf8');
  const pkg = JSON.parse(read('package.json'));
  const lock = JSON.parse(read('package-lock.json'));
  const cargo = read('Cargo.toml');
  const cargoLock = read('Cargo.lock');
  validateVersions({ pkg, lock, cargo, cargoLock });
  pkg.version = lock.version = lock.packages[''].version = version;
  const updatedCargo = updateCargo(cargo, version);
  const updatedLock = updateCargo(cargoLock, version, true);
  validateVersions({ pkg, lock, cargo: updatedCargo, cargoLock: updatedLock });
  for (const [file, content] of Object.entries({
    'package.json': JSON.stringify(pkg, null, 2) + '\n',
    'package-lock.json': JSON.stringify(lock, null, 2) + '\n',
    'Cargo.toml': updatedCargo,
    'Cargo.lock': updatedLock,
  })) fs.writeFileSync(path.join(root, file), content);
  console.log(`Prepared ${version}. Review git diff, then commit and push a PR. Nothing was staged or committed.`);
}

if (require.main === module) {
  try { prepare(); } catch (error) { console.error(error.message); process.exitCode = 1; }
}
module.exports = { versionArgument, prepare };
