'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync, spawnSync } = require('node:child_process');
const { validate } = require('../scripts/release-check.js');
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
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'release-check-test-'));
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
  fs.writeFileSync(path.join(source, 'package-lock.json'), JSON.stringify(fixture().lock));
  fs.writeFileSync(path.join(source, 'Cargo.toml'), fixture().cargo);
  fs.writeFileSync(path.join(source, 'Cargo.lock'), fixture().cargoLock);
  git(source, 'add', '.'); git(source, 'commit', '-m', 'fixture'); git(source, 'push', 'origin', 'main');
  const sha = git(source, 'rev-parse', 'HEAD');
  git(directory, 'clone', remote, checkout); git(checkout, 'checkout', '--detach', sha);
  const event = path.join(directory, 'event.json');
  fs.writeFileSync(event, JSON.stringify(fixture().event));
  const summary = path.join(directory, 'summary.md');
  const output = path.join(directory, 'output');
  // Intercept only the simulated transport boundary; all Git state changes use real local repositories.
  const intercept = path.join(directory, 'transport.cjs');
  fs.writeFileSync(intercept, `
    const cp = require('node:child_process');
    const fs = require('node:fs');
    const real = cp.execFileSync;
    cp.execFileSync = (file, args, options) => {
      if (file === 'gh') return JSON.stringify(JSON.parse(fs.readFileSync(process.env.GITHUB_EVENT_PATH)).release);
      return real(file, args, options);
    };
  `);
  const env = { ...process.env, NODE_OPTIONS: `--require=${JSON.stringify(intercept)}`, TEST_SOURCE: source, GITHUB_EVENT_PATH: event, GITHUB_EVENT_NAME: 'release', GITHUB_SHA: sha,
    GITHUB_RUN_ID: '42', GITHUB_RUN_ATTEMPT: '1',
    GITHUB_REPOSITORY: 'homebridge/node-icmp-ping', GITHUB_REF: fixture().ref,
    GITHUB_STEP_SUMMARY: summary, GITHUB_OUTPUT: output };
  const run = script => spawnSync(process.execPath, [path.join(root, 'scripts', script)], { cwd: checkout, env, encoding: 'utf8' });
  return { git, remote, source, checkout, sha, summary, output, env, run };
}
for (const mode of ['remote-tag', 'ancestor', 'off-main', 'missing-tag', 'moved-tag']) {
  test(`full release check with local remote: ${mode}`, t => {
    const s = sandbox(t);
    const tag = fixture().event.release.tag_name;
    if (mode !== 'missing-tag') {
      s.git(s.source, 'tag', tag);
      s.git(s.source, 'push', 'origin', `refs/tags/${tag}`);
    }
    if (['ancestor', 'off-main', 'moved-tag'].includes(mode)) {
      fs.writeFileSync(path.join(s.source, 'unrelated'), 'new source');
      s.git(s.source, 'commit', '-am', 'new commit');
      if (mode === 'ancestor') s.git(s.source, 'push', 'origin', 'main');
      if (mode === 'off-main') {
        s.env.GITHUB_SHA = s.git(s.source, 'rev-parse', 'HEAD');
        s.git(s.checkout, 'fetch', s.source, 'HEAD');
        s.git(s.checkout, 'checkout', '--detach', s.env.GITHUB_SHA);
      }
      if (mode !== 'ancestor') {
        s.git(s.source, 'tag', '-f', tag);
        s.git(s.source, 'push', '--force', 'origin', `refs/tags/${tag}`);
      }
    }
    // Checkout initially has no tag: check() must fetch it from the remote.
    assert.equal(s.git(s.checkout, 'tag', '--list'), '');
    const result = s.run('release-check.js');
    assert.equal(result.status, ['remote-tag', 'ancestor'].includes(mode) ? 0 : 1, result.stderr);
    if (result.status === 0) {
      assert.equal(fs.readFileSync(s.output, 'utf8'), 'channel=next\n');
      assert.equal(s.git(s.checkout, 'rev-parse', `${tag}^{commit}`), s.sha);
    } else {
      assert.equal(fs.existsSync(s.output), false);
      if (mode === 'moved-tag') assert.match(result.stderr, /Tag does not point/);
      if (mode === 'off-main') assert.match(result.stderr, /merge-base --is-ancestor/);
    }
  });
}
