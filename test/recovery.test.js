'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { pinned, validateDispatch, validateSource, verifyArchive } = require('../scripts/recover-v1.js');
const evidence = require('./fixtures/recovery-run.json');
function source() {
  return { ...structuredClone(evidence), artifact: { id: pinned.artifact, name: 'npm-distribution', expired: false, digest: pinned.digest,
    workflow_run: { id: pinned.run, repository_id: pinned.repositoryId, head_repository_id: pinned.repositoryId, head_sha: pinned.sha, head_branch: 'v1.0.0' } } };
}
test('original run evidence has eight builds and all 24 tested-tarball installs', () => {
  const f = source();
  validateSource(f.run, f.artifact, f.jobs);
  assert.equal(f.jobs.filter(j => j.name.startsWith('build / Install')).length, 24);
});
for (const [label, change] of [
  ['different run', f => f.run.id++], ['rerun', f => f.run.run_attempt++],
  ['different commit', f => f.run.head_sha = 'a'.repeat(40)],
  ['different workflow', f => f.run.path = '.github/workflows/ci.yml'],
  ['wrong event', f => f.run.event = 'workflow_dispatch'],
  ['fork', f => f.run.head_repository.id++],
  ['unfinished run', f => f.run.status = 'in_progress'],
  ['replacement artifact', f => f.artifact.id++], ['renamed artifact', f => f.artifact.name = 'other'],
  ['expired artifact', f => f.artifact.expired = true], ['different archive', f => f.artifact.digest = 'sha256:bad'],
  ['wrong source run', f => f.artifact.workflow_run.id++],
  ['wrong source commit', f => f.artifact.workflow_run.head_sha = 'a'.repeat(40)],
  ['missing job', f => f.jobs.pop()], ['duplicate job', f => f.jobs.push(f.jobs[0])],
  ['failed install', f => f.jobs.find(j => j.name.startsWith('build / Install')).conclusion = 'failure'],
  ['skipped build', f => f.jobs.find(j => j.name === 'build / package').conclusion = 'skipped'],
]) test(`recovery rejects ${label}`, () => {
  const f = source(); change(f); assert.throws(() => validateSource(f.run, f.artifact, f.jobs));
});
function dispatch() {
  const sha = 'b'.repeat(40);
  return { env: { GITHUB_REPOSITORY: pinned.repository, GITHUB_EVENT_NAME: 'workflow_dispatch', GITHUB_REF: 'refs/heads/main',
    GITHUB_WORKFLOW_REF: `${pinned.repository}/.github/workflows/publish.yml@refs/heads/main`, GITHUB_SHA: sha },
  event: { inputs: { confirmation: 'recover-v1.0.0' } }, head: sha, main: sha };
}
test('confirmed main dispatch is accepted', () => { const f = dispatch(); validateDispatch(f.env, f.event, f.head, f.main); });
for (const [label, change] of [
  ['fork', f => f.env.GITHUB_REPOSITORY = 'other/node-icmp-ping'],
  ['release event', f => f.env.GITHUB_EVENT_NAME = 'release'],
  ['branch', f => f.env.GITHUB_REF = 'refs/heads/other'],
  ['different workflow identity', f => f.env.GITHUB_WORKFLOW_REF = f.env.GITHUB_WORKFLOW_REF.replace('publish.yml', 'recovery.yml')],
  ['missing confirmation', f => f.event.inputs = {}],
  ['wrong checkout', f => f.head = 'c'.repeat(40)],
  ['advanced main', f => f.main = 'c'.repeat(40)],
]) test(`dispatch rejects ${label}`, () => {
  const f = dispatch(); change(f); assert.throws(() => validateDispatch(f.env, f.event, f.head, f.main));
});
test('substitute/rebuilt archive fails even if its own integrity record is consistent', () => {
  assert.throws(() => verifyArchive(Buffer.from('replacement tarball and updated integrity.json')), /archive digest mismatch/);
});

// Exercise the entry point with simulated Git/GitHub transport. Any unexpected
// command (including npm, a build or repack) is a test failure, never executed.
for (const fault of ['moved tag', 'recreated release', 'changed channel', 'changed package', 'bad archive']) test(`entry point stops before registry access: ${fault}`, () => {
  const { spawnSync } = require('node:child_process');
  const script = `
    const fs = require('node:fs');
    const cp = require('node:child_process');
    const assert = require('node:assert/strict');
    const root = ${JSON.stringify(require('node:path').resolve(__dirname, '..'))};
    const fault = ${JSON.stringify(fault)};
    const data = ${JSON.stringify(source())};
    const dispatch = ${JSON.stringify(dispatch())};
    let boundaryReached = false;
    const read = fs.readFileSync;
    fs.readFileSync = (file, ...args) => file === 'event-fixture.json' ? JSON.stringify(dispatch.event) : read(file, ...args);
    cp.execFileSync = (command, args) => {
      if (command === 'git') {
        if (args[0] === 'fetch' || args[0] === 'merge-base') return '';
        if (args[0] === 'rev-parse') {
          if (args[1] === 'refs/tags/v1.0.0^{commit}') return fault === 'moved tag' ? 'c'.repeat(40) : data.run.head_sha;
          return dispatch.head;
        }
        if (args[0] === 'show') {
          const file = args[1].split(':')[1];
          const content = read(root + '/' + file, 'utf8');
          return fault === 'changed package' && file === 'package.json' ? content + '\\n' : content;
        }
      }
      if (command === 'gh') {
        const endpoint = args[1];
        if (endpoint.includes('/releases/')) return JSON.stringify({id: fault === 'recreated release' ? 0 : 399672199, tag_name: 'v1.0.0', draft: false, prerelease: fault === 'changed channel'});
        if (endpoint.includes('/jobs?')) return JSON.stringify({total_count: data.jobs.length, jobs: data.jobs});
        if (endpoint.endsWith('/zip')) { boundaryReached = true; return Buffer.from('substituted zip'); }
        if (endpoint.includes('/artifacts/')) return JSON.stringify(data.artifact);
        return JSON.stringify(data.run);
      }
      throw new Error('Unexpected external command: ' + command);
    };
    global.fetch = () => { throw new Error('Registry must not be reached'); };
    const {recover} = require(root + '/scripts/recover-v1.js');
    recover({...dispatch.env, GITHUB_EVENT_PATH: 'event-fixture.json'}).then(() => {throw new Error('Expected rejection');}, error => {
      const expected = {'moved tag': /Original tag moved/, 'recreated release': /Live Release id changed/, 'changed channel': /Live Release prerelease changed/, 'changed package': /Recovery validation input changed/, 'bad archive': /archive digest mismatch/};
      assert.match(error.message, expected[fault]);
      assert.equal(boundaryReached, fault === 'bad archive');
    }).catch(error => {console.error(error); process.exitCode = 1;});
  `;
  const result = spawnSync(process.execPath, ['-e', script], { cwd: require('node:path').resolve(__dirname, '..'), encoding: 'utf8' });
  assert.equal(result.status, 0, result.stderr);
});
