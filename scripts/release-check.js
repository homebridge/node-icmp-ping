'use strict';
const fs = require('node:fs');
const assert = require('node:assert/strict');
const { execFileSync } = require('node:child_process');
const { channel } = require('./release-policy.js');

// These deliberately accept only this repository's explicit package sections.
// Do not accidentally match a dependency's version in either Cargo file.
function cargoVersion(text, lock = false) {
  const sections = text.split(lock ? /^\[\[package\]\]\s*$/m : /^\[package\]\s*$/m).slice(1);
  const packages = sections.map(section => section.split(/^\[/m)[0])
    .filter(section => /^name\s*=\s*"node-icmp-ping"\s*$/m.test(section));
  assert.equal(packages.length, 1, 'Expected exactly one root Cargo package');
  const match = packages[0].match(/^version\s*=\s*"([^"]+)"\s*$/m);
  assert(match, 'Missing root Cargo version');
  return match[1];
}
function validate({ event, eventName, ref, sha, head, tagSha, pkg, lock, cargo, cargoLock, live }) {
  assert.equal(eventName, 'release', 'Only GitHub Release events can publish');
  assert.equal(event.action, 'published', 'Only published Releases can publish');
  const release = event.release;
  assert(release && Number.isSafeInteger(release.id), 'Missing Release identity');
  assert.equal(release.draft, false, 'Release is still a draft');
  const intended = channel(pkg.version, release.prerelease);
  assert.equal(release.tag_name, `v${pkg.version}`, 'Tag must match package version');
  assert.equal(ref, `refs/tags/${release.tag_name}`, 'Release ref must match exact tag');
  assert.match(sha, /^[a-f0-9]{40}$/, 'Invalid release commit');
  assert.equal(head, sha, 'Checkout does not match event commit');
  assert.equal(tagSha, sha, 'Tag does not point to workflow commit');
  assert.equal(lock.name, pkg.name, 'npm lockfile name mismatch');
  assert.equal(lock.version, pkg.version, 'npm lockfile version mismatch');
  assert.equal(lock.packages?.['']?.version, pkg.version, 'npm lockfile root version mismatch');
  assert.equal(lock.packages?.['']?.name, pkg.name, 'npm lockfile root name mismatch');
  assert.equal(cargoVersion(cargo), pkg.version, 'Cargo version mismatch');
  assert.equal(cargoVersion(cargoLock, true), pkg.version, 'Cargo lockfile version mismatch');
  for (const field of ['id', 'tag_name', 'draft', 'prerelease']) {
    assert.equal(live[field], release[field], `Live Release ${field} changed; stop and investigate`);
  }
  return intended;
}
function check(env = process.env) {
  const git = args => execFileSync('git', args, { encoding: 'utf8' }).trim();
  const event = JSON.parse(fs.readFileSync(env.GITHUB_EVENT_PATH, 'utf8'));
  // Validate untrusted event fields before passing them to Git or the API.
  assert.equal(env.GITHUB_EVENT_NAME, 'release', 'Only GitHub Release events can publish');
  assert.equal(event.action, 'published', 'Only published Releases can publish');
  const pkg = JSON.parse(fs.readFileSync('package.json', 'utf8'));
  channel(pkg.version, event.release?.prerelease);
  assert.equal(event.release?.tag_name, `v${pkg.version}`, 'Tag must match package version');
  assert(Number.isSafeInteger(event.release.id), 'Missing Release identity');
  assert.equal(env.GITHUB_REPOSITORY, 'homebridge/node-icmp-ping', 'Unexpected release repository');
  const tag = event.release.tag_name;
  git(['fetch', '--no-tags', 'origin', `refs/tags/${tag}:refs/tags/${tag}`, '+refs/heads/main:refs/remotes/origin/main']);
  const live = JSON.parse(execFileSync('gh', ['api', `repos/${env.GITHUB_REPOSITORY}/releases/${event.release.id}`], { encoding: 'utf8' }));
  const result = validate({ event, eventName: env.GITHUB_EVENT_NAME, ref: env.GITHUB_REF,
    sha: env.GITHUB_SHA, head: git(['rev-parse', 'HEAD']), tagSha: git(['rev-parse', `refs/tags/${tag}^{commit}`]),
    pkg, lock: JSON.parse(fs.readFileSync('package-lock.json', 'utf8')),
    cargo: fs.readFileSync('Cargo.toml', 'utf8'), cargoLock: fs.readFileSync('Cargo.lock', 'utf8'), live });
  git(['merge-base', '--is-ancestor', env.GITHUB_SHA, 'refs/remotes/origin/main']);
  if (env.GITHUB_OUTPUT) fs.appendFileSync(env.GITHUB_OUTPUT, `channel=${result}\n`);
  console.log(`Validated ${tag} at ${env.GITHUB_SHA} on main; channel ${result}`);
  return result;
}
if (require.main === module) check();
module.exports = { validate, cargoVersion, check };
