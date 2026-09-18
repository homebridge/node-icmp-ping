'use strict';
const fs = require('node:fs');
const assert = require('node:assert/strict');
const { execFileSync } = require('node:child_process');
const pkg = require('../package.json');
const tag = process.env.RELEASE_TAG;
assert.equal(tag, `v${pkg.version}`, 'Tag must match package version');
assert.equal(process.env.GITHUB_REF, `refs/tags/${tag}`, 'Dispatch must run on the exact release tag');

assert(fs.readFileSync('Cargo.toml', 'utf8').includes(`version = "${pkg.version}"`), 'Cargo version mismatch');
const sha = execFileSync('git', ['rev-parse', `${tag}^{commit}`], { encoding: 'utf8' }).trim();
assert.equal(sha, process.env.GITHUB_SHA, 'Tag does not point to workflow commit');
const release = JSON.parse(execFileSync('gh', ['api', `repos/${process.env.GITHUB_REPOSITORY}/releases/tags/${tag}`], { encoding: 'utf8' }));
assert.equal(release.draft, false, 'Release is still a draft');
const channel = require('./release-policy.js').channel(pkg.version, release.prerelease);
fs.appendFileSync(process.env.GITHUB_OUTPUT, `channel=${channel}\n`);
console.log(`Validated ${tag} at ${sha}; channel ${channel}`);
