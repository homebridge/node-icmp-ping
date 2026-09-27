'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync, spawnSync } = require('node:child_process');
const { validate } = require('../scripts/release-check.js');
const { digest } = require('../scripts/release-loader.js');
const root = path.resolve(__dirname, '..');
function fixture(version = '0.9.0-beta.2', prerelease = true) {
  const release = { id: 123, tag_name: `v${version}`, draft: false, prerelease };
  const sha = 'a'.repeat(40);
  return { eventName: 'release', event: { action: 'published', release }, ref: `refs/tags/v${version}`,
    sha, head: sha, tagSha: sha, pkg: { name: '@homebridge/node-icmp-ping', version },
    lock: { name: '@homebridge/node-icmp-ping', version, packages: { '': { name: '@homebridge/node-icmp-ping', version } } },
    cargo: `[package]\nname = "node-icmp-ping"\nversion = "${version}"\n[dependencies]\n`,
    cargoLock: `version = 4\n[[package]]\nname = "other"\nversion = "1.0.0"\n[[package]]\nname = "node-icmp-ping"\nversion = "${version}"\n`, live: { ...release } };
}
for (const [version, prerelease, expected] of [['0.9.0-beta.2', true, 'next'], ['0.9.0', false, 'latest'], ['1.0.0-rc.1', true, 'next']]) {
  test(`published ${version} selects ${expected}`, () => assert.equal(validate(fixture(version, prerelease)), expected));
}
for (const eventName of ['push', 'pull_request', 'workflow_dispatch', 'workflow_call']) {
  test(`reject ${eventName}`, () => assert.throws(() => validate({ ...fixture(), eventName })));
}
for (const action of ['created', 'edited', 'prereleased', 'released', 'deleted']) {
  test(`reject release action ${action}`, () => {
    const f = fixture(); f.event.action = action; assert.throws(() => validate(f));
  });
}
for (const [label, change] of [
  ['draft', f => { f.event.release.draft = true; }],
  ['beta marked stable', f => { f.event.release.prerelease = false; }],
  ['wrong tag', f => { f.event.release.tag_name = 'v1.0.0'; }],
  ['wrong ref', f => { f.ref = 'refs/heads/main'; }],
  ['wrong checkout', f => { f.head = 'b'.repeat(40); }],
  ['moved tag', f => { f.tagSha = 'b'.repeat(40); }],
  ['npm lock version', f => { f.lock.version = '1.0.0'; }],
  ['npm root lock version', f => { f.lock.packages[''].version = '1.0.0'; }],
  ['Cargo manifest version', f => { f.cargo = f.cargo.replace('0.9.0-beta.2', '1.0.0'); }],
  ['Cargo lock version', f => { f.cargoLock = f.cargoLock.replace('0.9.0-beta.2', '1.0.0'); }],
  ['recreated live release', f => { f.live.id++; }],
  ['edited live channel', f => { f.live.prerelease = false; }],
  ['live draft', f => { f.live.draft = true; }],
  ['live tag', f => { f.live.tag_name = 'v1.0.0'; }],
]) test(`reject ${label}`, () => { const f = fixture(); change(f); assert.throws(() => validate(f)); });
test('stable cannot be a GitHub prerelease', () => assert.throws(() => validate(fixture('1.0.0', true))));
test('actual repository versions agree', () => {
  const pkg = require('../package.json');
  const f = fixture(pkg.version, pkg.version.includes('-'));
  Object.assign(f, { pkg, lock: require('../package-lock.json'), cargo: fs.readFileSync(path.join(root, 'Cargo.toml'), 'utf8'), cargoLock: fs.readFileSync(path.join(root, 'Cargo.lock'), 'utf8') });
  assert.equal(validate(f), pkg.version.includes('-') ? 'next' : 'latest');
});

function sandbox(t) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'release-loader-test-'));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const remote = path.join(directory, 'remote.git');
  const source = path.join(directory, 'source');
  const checkout = path.join(directory, 'checkout');
  const git = (cwd, ...args) => execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
  git(directory, 'init', '--bare', '--initial-branch=main', remote);
  git(directory, 'clone', remote, source);
  git(source, 'config', 'user.name', 'Release test');
  git(source, 'config', 'user.email', 'test@example.invalid');
  fs.writeFileSync(path.join(source, 'binding.js'), 'original\n');
  fs.writeFileSync(path.join(source, 'package.json'), JSON.stringify(fixture().pkg));
  fs.writeFileSync(path.join(source, 'unrelated'), 'original\n');
  git(source, 'add', '.'); git(source, 'commit', '-m', 'fixture'); git(source, 'push', 'origin', 'main');
  const sha = git(source, 'rev-parse', 'HEAD');
  git(directory, 'clone', remote, checkout); git(checkout, 'checkout', '--detach', sha);
  const event = path.join(directory, 'event.json');
  fs.writeFileSync(event, JSON.stringify(fixture().event));
  const summary = path.join(directory, 'summary.md');
  const output = path.join(directory, 'output');
  const env = { ...process.env, GITHUB_EVENT_PATH: event, GITHUB_EVENT_NAME: 'release', GITHUB_SHA: sha,
    GITHUB_RUN_ID: '42', GITHUB_RUN_ATTEMPT: '1', LOADER_SHA256: digest(Buffer.from('generated\n')),
    GITHUB_STEP_SUMMARY: summary, GITHUB_OUTPUT: output };
  fs.mkdirSync(path.join(checkout, 'regenerated-loader'));
  fs.writeFileSync(path.join(checkout, 'regenerated-loader/binding.js'), 'generated\n');
  const run = script => spawnSync(process.execPath, [path.join(root, 'scripts', script)], { cwd: checkout, env, encoding: 'utf8' });
  return { git, remote, source, checkout, sha, summary, output, env, run };
}
test('byte-identical loader passes; any byte change gates publication', t => {
  const s = sandbox(t);
  assert.equal(s.run('release-loader.js').status, 0);
  assert.match(fs.readFileSync(s.output, 'utf8'), /changed=false/);
  fs.writeFileSync(s.output, '');
  fs.writeFileSync(path.join(s.checkout, 'binding.js'), 'original\r\n');
  assert.equal(s.run('release-loader.js').status, 0);
  assert.match(fs.readFileSync(s.output, 'utf8'), /changed=true/);
  assert.match(fs.readFileSync(s.summary, 'utf8'), /Nothing was published/);
});
test('generation may not silently change a lockfile or unrelated source', t => {
  const s = sandbox(t);
  fs.writeFileSync(path.join(s.checkout, 'unrelated'), 'changed by build');
  assert.equal(s.run('release-loader.js').status, 1);
  assert.equal(fs.existsSync(s.output), false);
});
for (const mode of ['direct', 'protected', 'advanced', 'all-pushes-denied', 'bad-digest', 'dirty']) {
  test(`loader repair ${mode}: never succeeds as a release`, t => {
    const s = sandbox(t);
    if (mode === 'protected' || mode === 'all-pushes-denied') {
      fs.writeFileSync(path.join(s.remote, 'hooks/pre-receive'), mode === 'protected'
        ? '#!/bin/sh\nwhile read old new ref; do\n  if [ "$ref" = refs/heads/main ]; then exit 1; fi\ndone\n'
        : '#!/bin/sh\nexit 1\n', { mode: 0o755 });
    }
    let expectedMain = s.sha;
    if (mode === 'advanced') {
      fs.writeFileSync(path.join(s.source, 'unrelated'), 'advanced\n');
      s.git(s.source, 'commit', '-am', 'advance main'); s.git(s.source, 'push', 'origin', 'main');
      expectedMain = s.git(s.source, 'rev-parse', 'HEAD');
    }
    if (mode === 'bad-digest') s.env.LOADER_SHA256 = '0'.repeat(64);
    if (mode === 'dirty') fs.writeFileSync(path.join(s.checkout, 'unrelated'), 'dirty\n');
    const result = s.run('repair-release-loader.js');
    assert.equal(result.status, 1, result.stderr);
    const message = fs.readFileSync(s.summary, 'utf8');
    assert.match(message, /Nothing was published to npm/);
    if (mode === 'direct') {
      assert.match(message, /committed to `main`/);
      assert.equal(s.git(s.remote, 'show', 'main:binding.js'), 'generated');
      assert.equal(s.git(s.remote, 'diff', '--name-only', s.sha, 'main'), 'binding.js');
    } else {
      assert.equal(s.git(s.remote, 'rev-parse', 'main'), expectedMain);
      if (mode === 'protected' || mode === 'advanced') {
        assert.match(message, /release-loader\/42-1/);
        assert.equal(s.git(s.remote, 'diff', '--name-only', s.sha, 'release-loader/42-1'), 'binding.js');
      } else assert.match(message, /repair could not be confirmed/);
    }
    assert.equal(s.git(s.remote, 'tag', '--list'), '');
  });
}
// Guard the job graph as well as the scripts: repair success must never unlock build.
test('workflow has a single release publication path and explicit loader gate', () => {
  const workflow = fs.readFileSync(path.join(root, '.github/workflows/publish.yml'), 'utf8');
  assert.match(workflow, /on:\n  release:\n    types: \[published\]/);
  assert.doesNotMatch(workflow, /workflow_dispatch|inputs\.publish|NODE_AUTH_TOKEN|NPM_TOKEN/);
  assert.match(workflow, /build:\n    needs: validate\n    if: needs.validate.outputs.loader_changed == 'false'/);
  assert.match(workflow, /publish:\n    if: .*needs.validate.outputs.loader_changed == 'false'\n    needs: \[validate, build\]/);
  assert.equal((workflow.match(/contents: write/g) || []).length, 1);
  const repair = workflow.split('  repair-loader:')[1].split('  build:')[0];
  assert.match(repair, /contents: write/);
  assert.doesNotMatch(repair, /npm (ci|install|publish)|id-token: write/);
  assert.match(workflow, /environment: npm-production/);
  assert.equal((workflow.match(/id-token: write/g) || []).length, 1);
  const ci = fs.readFileSync(path.join(root, '.github/workflows/ci.yml'), 'utf8');
  assert.doesNotMatch(ci, /id-token: write|scripts\/publish.js|npm publish/);
});
