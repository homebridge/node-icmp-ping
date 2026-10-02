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
    let fetches = 0;
    cp.execFileSync = (file, args, options) => {
      if (file === 'gh') return JSON.stringify(JSON.parse(fs.readFileSync(process.env.GITHUB_EVENT_PATH)).release);
      if (file === 'git' && args[0] === 'fetch') {
        fetches++;
        if (process.env.TEST_TRANSPORT === 'initial-fetch-failure' ||
            (fetches === 2 && process.env.TEST_TRANSPORT === 'confirm-failure')) throw new Error('simulated fetch failure');
      }
      if (file === 'git' && args[0] === 'push') {
        if (process.env.TEST_TRANSPORT === 'race') {
          const opts = { cwd: process.env.TEST_SOURCE, stdio: 'pipe' };
          fs.writeFileSync(process.env.TEST_SOURCE + '/unrelated', 'concurrent main update');
          real('git', ['commit', '-am', 'concurrent advancement'], opts);
          real('git', ['push', 'origin', 'main'], opts);
        }
        const result = real(file, args, options);
        if (process.env.TEST_TRANSPORT === 'lost-response') throw new Error('simulated lost push response');
        return result;
      }
      return real(file, args, options);
    };
  `);
  const env = { ...process.env, NODE_OPTIONS: `--require=${JSON.stringify(intercept)}`, TEST_SOURCE: source, GITHUB_EVENT_PATH: event, GITHUB_EVENT_NAME: 'release', GITHUB_SHA: sha,
    GITHUB_RUN_ID: '42', GITHUB_RUN_ATTEMPT: '1', LOADER_SHA256: digest(Buffer.from('generated\n')),
    GITHUB_REPOSITORY: 'homebridge/node-icmp-ping', GITHUB_REF: fixture().ref,
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
for (const mode of ['direct', 'protected', 'advanced', 'bad-digest', 'dirty', 'staged', 'race', 'lost-response', 'confirm-failure', 'initial-fetch-failure']) {
  test(`loader repair ${mode}: never succeeds as a release`, t => {
    const s = sandbox(t);
    s.env.TEST_TRANSPORT = mode;
    if (mode === 'protected') {
      fs.writeFileSync(path.join(s.remote, 'hooks/pre-receive'), '#!/bin/sh\nexit 1\n', { mode: 0o755 });
    }
    let expectedMain = s.sha;
    if (mode === 'advanced') {
      fs.writeFileSync(path.join(s.source, 'unrelated'), 'advanced\n');
      s.git(s.source, 'commit', '-am', 'advance main'); s.git(s.source, 'push', 'origin', 'main');
      expectedMain = s.git(s.source, 'rev-parse', 'HEAD');
    }
    if (mode === 'bad-digest') s.env.LOADER_SHA256 = '0'.repeat(64);
    if (mode === 'dirty') fs.writeFileSync(path.join(s.checkout, 'unrelated'), 'dirty\n');
    if (mode === 'staged') {
      fs.writeFileSync(path.join(s.checkout, 'unrelated'), 'staged\n');
      s.git(s.checkout, 'add', 'unrelated');
    }
    const result = s.run('repair-release-loader.js');
    if (mode === 'race') expectedMain = s.git(s.source, 'rev-parse', 'HEAD');
    assert.equal(result.status, 1, result.stderr);
    const message = fs.readFileSync(s.summary, 'utf8');
    assert.match(message, /Nothing was published to npm/);
    if (['direct', 'lost-response', 'confirm-failure'].includes(mode)) {
      assert.match(message, mode === 'confirm-failure' ? /confirming fetch failed/ : /confirmed on main/);
      assert.equal(s.git(s.remote, 'show', 'main:binding.js'), 'generated');
      assert.equal(s.git(s.remote, 'diff', '--name-only', s.sha, 'main'), 'binding.js');
      assert.equal(s.git(s.remote, 'rev-parse', 'main^'), s.sha);
    } else {
      assert.equal(s.git(s.remote, 'rev-parse', 'main'), expectedMain);
      assert.match(message, /repair could not be confirmed/);
    }
    if (!['direct', 'lost-response'].includes(mode)) {
      assert.match(message, /current main/);
      assert.match(message, /npm ci.*npm run build/);
      assert.match(message, /no push was attempted|not confirmed on main|fetch failed|digest mismatch|checkout must be clean|fetch failure/);
    }
    assert.equal(fs.readFileSync(path.join(s.checkout, 'regenerated-loader/binding.js'), 'utf8'), 'generated\n');
    assert.equal(s.git(s.remote, 'for-each-ref', '--format=%(refname)', 'refs/heads'), 'refs/heads/main');
    assert.equal(s.git(s.remote, 'tag', '--list'), '');
  });
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
// Guard the job graph as well as the scripts: repair success must never unlock build.
test('release validation still rejects version-only drift until the generated loader is committed', t => {
  const s = sandbox(t);
  const tracked = fs.readFileSync(path.join(root, 'binding.js'), 'utf8');
  const version = tracked.match(/bindingPackageVersion !== '([^']+)'/)[1];
  const next = version === '1.0.0' ? '2.0.0' : '1.0.0';
  fs.writeFileSync(path.join(s.checkout, 'binding.js'), tracked);
  fs.writeFileSync(path.join(s.checkout, 'package.json'), JSON.stringify(fixture(next, false).pkg));
  s.git(s.checkout, '-c', 'user.name=Test', '-c', 'user.email=test@example.invalid', 'commit', '-am', 'version bump');
  fs.writeFileSync(path.join(s.checkout, 'binding.js'), tracked.split(version).join(next));
  assert.equal(s.run('release-loader.js').status, 0);
  assert.match(fs.readFileSync(s.output, 'utf8'), /changed=true/);
});
test('workflow preserves the normal release path', () => {
  const workflow = fs.readFileSync(path.join(root, '.github/workflows/publish.yml'), 'utf8');
  assert.match(workflow, /on:\n  release:\n    types: \[published\]/);
  assert.doesNotMatch(workflow, /inputs\.publish|NODE_AUTH_TOKEN|NPM_TOKEN/);
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


