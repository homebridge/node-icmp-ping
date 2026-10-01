'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { createHash } = require('node:crypto');
const { execFileSync } = require('node:child_process');
const { validate } = require('./release-check.js');
const { preflight, publish } = require('./publish.js');

// Reviewed, immutable identity of the tested distribution; no dispatch overrides.
const pinned = Object.freeze({
  repository: 'homebridge/node-icmp-ping', repositoryId: 1376297632,
  run: 36660590695, attempt: 1, workflow: 361615936, artifact: 11073922734,
  sha: '34d714b9e29b5dab3db4e8b4f13cfb9df2013188',
  digest: 'sha256:a78cd6cb5e491b7298b3e0ae85a144460a8dac4f29ec5a6d60936da1c2fd29d9',
  release: Object.freeze({ id: 399672199, tag_name: 'v1.0.0', draft: false, prerelease: false }),
});
function validateDispatch(env, event, head, main) {
  assert.equal(env.GITHUB_REPOSITORY, pinned.repository);
  assert.equal(env.GITHUB_EVENT_NAME, 'workflow_dispatch');
  assert.equal(env.GITHUB_REF, 'refs/heads/main');
  assert.equal(env.GITHUB_WORKFLOW_REF, `${pinned.repository}/.github/workflows/publish.yml@refs/heads/main`);
  assert.equal(event.inputs?.confirmation, 'recover-v1.0.0');
  assert.match(env.GITHUB_SHA, /^[a-f0-9]{40}$/);
  assert.equal(head, env.GITHUB_SHA, 'Checkout must match recovery workflow commit');
  assert.equal(main, head, 'Recovery commit must still be current main; review and dispatch again');
}
function validateSource(run, artifact, jobs) {
  for (const [key, value] of Object.entries({ id: pinned.run, run_attempt: pinned.attempt,
    workflow_id: pinned.workflow, event: 'release', path: '.github/workflows/publish.yml',
    head_sha: pinned.sha, head_branch: 'v1.0.0', status: 'completed', conclusion: 'failure' })) assert.equal(run[key], value, `Original run ${key} changed`);
  assert.equal(run.repository?.id, pinned.repositoryId);
  assert.equal(run.head_repository?.id, pinned.repositoryId);
  for (const [key, value] of Object.entries({ id: pinned.artifact, name: 'npm-distribution', expired: false, digest: pinned.digest })) assert.equal(artifact[key], value, `Original artifact ${key} changed`);
  for (const [key, value] of Object.entries({ id: pinned.run, repository_id: pinned.repositoryId,
    head_repository_id: pinned.repositoryId, head_sha: pinned.sha, head_branch: 'v1.0.0' })) assert.equal(artifact.workflow_run?.[key], value, `Artifact run ${key} changed`);
  const expected = ['validate', 'build / package',
    ...Object.keys(require('./package-identity.js').targets).map(target => `build / ${target}${target.endsWith('-musl') ? ' (native Alpine)' : ''}`),
    ...['ubuntu-24.04', 'ubuntu-24.04-arm', 'macos-15', 'macos-15-intel', 'windows-2025', 'windows-11-arm'].flatMap(runner => [22, 24, 26].map(node => `build / Install bundled tarball (${runner}, Node ${node}.x)`)),
    ...['x64', 'arm64'].flatMap(arch => [22, 24, 26].map(node => `build / Install bundled tarball (Alpine ${arch}, Node ${node})`)),
    'repair-loader', 'publish'];
  assert.deepEqual(jobs.map(job => job.name).sort(), expected.sort(), 'Original build/install job set changed');
  for (const job of jobs) assert.equal(job.conclusion, job.name === 'publish' ? 'failure' : job.name === 'repair-loader' ? 'skipped' : 'success', `Original job failed: ${job.name}`);
}
function verifyArchive(bytes) {
  assert.equal(`sha256:${createHash('sha256').update(bytes).digest('hex')}`, pinned.digest, 'Original artifact archive digest mismatch; never rebuild or substitute');
}
async function recover(env = process.env) {
  const git = args => execFileSync('git', args, { encoding: 'utf8' }).trim();
  const api = suffix => execFileSync('gh', ['api', `repos/${pinned.repository}/${suffix}`], { maxBuffer: 10 * 1024 * 1024 });
  const json = suffix => JSON.parse(api(suffix));
  const event = JSON.parse(fs.readFileSync(env.GITHUB_EVENT_PATH, 'utf8'));
  // Reject invalid dispatches before fetching any artifacts or contacting npm.
  validateDispatch(env, event, git(['rev-parse', 'HEAD']), git(['rev-parse', 'HEAD']));
  function checkIdentity() {
    git(['fetch', '--no-tags', 'origin', '+refs/heads/main:refs/remotes/origin/main', 'refs/tags/v1.0.0:refs/tags/v1.0.0']);
    validateDispatch(env, event, git(['rev-parse', 'HEAD']), git(['rev-parse', 'refs/remotes/origin/main']));
    git(['merge-base', '--is-ancestor', pinned.sha, 'HEAD']);
    assert.equal(git(['rev-parse', 'refs/tags/v1.0.0^{commit}']), pinned.sha, 'Original tag moved');
    // Existing release validator checks all four original version files and live release identity.
    const original = file => execFileSync('git', ['show', `${pinned.sha}:${file}`], { encoding: 'utf8' });
    assert.equal(validate({ eventName: 'release', event: { action: 'published', release: pinned.release },
      ref: 'refs/tags/v1.0.0', sha: pinned.sha, head: pinned.sha, tagSha: pinned.sha,
      pkg: JSON.parse(original('package.json')), lock: JSON.parse(original('package-lock.json')),
      cargo: original('Cargo.toml'), cargoLock: original('Cargo.lock'), live: json(`releases/${pinned.release.id}`) }), 'latest');
    // Fail closed if current package validation inputs have advanced beyond this recovery.
    for (const file of ['package.json', 'package-lock.json', 'Cargo.toml', 'Cargo.lock', 'binding.js']) {
      assert.equal(fs.readFileSync(file, 'utf8'), original(file), `Recovery validation input changed: ${file}`);
    }
  }
  checkIdentity();
  const jobs = json(`actions/runs/${pinned.run}/attempts/${pinned.attempt}/jobs?per_page=100`);
  assert.equal(jobs.total_count, jobs.jobs.length, 'Incomplete original job evidence');
  validateSource(json(`actions/runs/${pinned.run}`), json(`actions/artifacts/${pinned.artifact}`), jobs.jobs);
  const bytes = api(`actions/artifacts/${pinned.artifact}/zip`);
  verifyArchive(bytes); // Hard failure, not download-artifact's digest warning.
  const temporary = fs.mkdtempSync(path.join(os.tmpdir(), 'npm-v1-recovery-'));
  try {
    const archive = path.join(temporary, 'original.zip');
    fs.writeFileSync(archive, bytes);
    const files = ['homebridge-node-icmp-ping-1.0.0.tgz', 'integrity.json'];
    const listing = execFileSync('unzip', ['-Z1', archive], { encoding: 'utf8' }).trim().split('\n');
    assert.deepEqual(listing.sort(), files.slice().sort(), 'Unexpected original archive entries');
    const distribution = path.join(temporary, 'distribution');
    fs.mkdirSync(distribution);
    for (const file of files) fs.writeFileSync(path.join(distribution, file), execFileSync('unzip', ['-p', archive, file], { maxBuffer: 10 * 1024 * 1024 }));
    const item = preflight(distribution, 'latest');
    checkIdentity(); // Recheck live release/tag after download, immediately before registry preflight.
    console.log(`Recovering ${pinned.release.tag_name} at ${pinned.sha} from run ${pinned.run}, artifact ${pinned.artifact}, ${pinned.digest}; tarball ${item.integrity}`);
    await publish(item);
  } finally { fs.rmSync(temporary, { recursive: true, force: true }); }
}
if (require.main === module) recover().catch(error => { console.error(error); process.exitCode = 1; });
module.exports = { pinned, validateDispatch, validateSource, verifyArchive, recover };
