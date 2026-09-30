'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync, spawnSync } = require('node:child_process');
const { versionChanged, validateLoader } = require('../scripts/pr-loader.js');
const { commitLoader } = require('../scripts/commit-pr-loader.js');
const root = path.resolve(__dirname, '..');
const loader = fs.readFileSync(path.join(root, 'binding.js'), 'utf8');
const oldVersion = loader.match(/bindingPackageVersion !== '([^']+)'/)[1];
const base = { name: '@homebridge/node-icmp-ping', version: oldVersion };
const repository = 'homebridge/node-icmp-ping';
const head = { ...base, version: oldVersion === '1.0.0' ? '2.0.0' : '1.0.0' };
// Independent oracle: all 54 literal occurrences in the pinned generated file.
const generated = loader.split(oldVersion).join(head.version);
test('detects version changes independent of other PR changes', () => {
  assert.equal(versionChanged(base, { ...base, description: 'unrelated' }), false);
  assert.equal(versionChanged(base, head), true);
  assert.equal(versionChanged(head, base), true);
  assert.throws(() => versionChanged(base, { ...head, name: 'other' }));
  assert.throws(() => versionChanged(base, { ...head, version: 'bad' }));
});
for (const version of [head.version, `${head.version}-rc.2`]) test(`permits precisely the embedded substitutions for ${version}`, () => {
  const next = { ...base, version };
  const bytes = loader.split(oldVersion).join(version);
  assert.equal(loader.split(oldVersion).length - 1, 54);
  assert.equal(validateLoader(loader, bytes, base, next), true);
  assert.equal(validateLoader(bytes, bytes, base, next), false);
  assert.throws(() => validateLoader(loader, loader, base, next));
  assert.throws(() => validateLoader(loader, bytes, base, base));
});
for (const [label, mutate] of [
  ['one stale guard', text => text.replace(head.version, oldVersion)],
  ['mixed diagnostics', text => text.replace(`expected ${head.version}`, 'expected 9.9.9')],
  ['enforcement', text => text.replace("!== '0'", "=== '0'")],
  ['platform selection', text => text.replace('linux-x64-gnu', 'linux-x64-musl')],
  ['extra text', text => text + '\n// drift'],
  ['line endings', text => text.replace(/\n/g, '\r\n')],
]) test(`rejects generated ${label}`, () => assert.throws(() => validateLoader(loader, mutate(generated), base, head)));
test('rejects unknown or incomplete tracked guards and leaves unrelated version text alone', () => {
  assert.throws(() => validateLoader(loader.replace(oldVersion, '9.9.9'), generated, base, head));
  assert.throws(() => validateLoader('no guards', 'no guards', base, head));
  const comment = `\n// ${oldVersion}\n`;
  assert.equal(validateLoader(loader + comment, generated + comment, base, head), true);
  assert.throws(() => validateLoader(loader + comment, generated + comment.replace(oldVersion, head.version), base, head));
});

function apiFixture() {
  const event = { action: 'synchronize', pull_request: {
    number: 16, head: { sha: 'a'.repeat(40), ref: 'release/version', repo: { full_name: repository } },
    base: { sha: 'b'.repeat(40), ref: 'main', repo: { full_name: repository } },
  } };
  const live = { ...structuredClone(event.pull_request), state: 'open' };
  const calls = [];
  const request = async (method, route, body) => {
    calls.push({ method, route, body });
    if (route.endsWith('/pulls/16')) return live;
    if (route.includes('/contents/')) return { type: 'file', encoding: 'base64', content: Buffer.from(
      route.includes('/binding.js?') ? loader : JSON.stringify(route.endsWith(event.pull_request.base.sha) ? base : head),
    ).toString('base64') };
    if (method === 'GET' && route.includes('/git/commits/')) return { tree: { sha: 'original-tree' } };
    if (route.endsWith('/git/trees')) return { sha: 'new-tree' };
    if (route.endsWith('/git/commits')) return { sha: 'new-commit' };
    if (method === 'PATCH') return {};
    if (route.includes('/git/ref/')) return { object: { sha: 'new-commit' } };
    if (route.endsWith('/dispatches')) return null;
    throw new Error(`Unexpected API call ${method} ${route}`);
  };
  return { event, live, calls, request };
}
test('writer creates only binding.js with exact head parent, fast-forwards and dispatches updated branch', async () => {
  const f = apiFixture();
  assert.equal(await commitLoader(f.event, generated, f.request, repository), 'new-commit');
  const mutations = f.calls.filter(call => call.method !== 'GET');
  assert.equal(mutations.length, 4);
  assert.deepEqual(mutations[0].body, { base_tree: 'original-tree', tree: [{ path: 'binding.js', mode: '100644', type: 'blob', content: generated }] });
  assert.deepEqual(mutations[1].body.parents, [f.event.pull_request.head.sha]);
  assert.deepEqual(mutations[2].body, { sha: 'new-commit', force: false });
  assert.match(mutations[2].route, /heads\/release%2Fversion$/);
  assert.deepEqual(mutations[3].body, { ref: 'release/version' });
  assert.match(mutations[3].route, /actions\/workflows\/ci.yml\/dispatches$/);
});
for (const mode of ['fork', 'other-base', 'same-branch', 'closed', 'moved-head', 'moved-base', 'retargeted', 'bad-artifact', 'wrong-repository']) {
  test(`writer rejects ${mode} before mutations`, async () => {
    const f = apiFixture();
    if (mode === 'fork') f.event.pull_request.head.repo.full_name = 'outside/fork';
    if (mode === 'other-base') f.event.pull_request.base.ref = 'untrusted';
    if (mode === 'same-branch') f.event.pull_request.head.ref = 'main';
    if (mode === 'closed') f.live.state = 'closed';
    if (mode === 'moved-head') f.live.head.sha = 'c'.repeat(40);
    if (mode === 'moved-base') f.live.base.sha = 'c'.repeat(40);
    if (mode === 'retargeted') f.live.head.ref = 'different';
    await assert.rejects(commitLoader(f.event, mode === 'bad-artifact' ? generated + '\n// drift' : generated,
      f.request, mode === 'wrong-repository' ? 'outside/repo' : repository));
    assert(f.calls.every(call => call.method === 'GET'));
  });
}
for (const boundary of ['PATCH', 'confirmation', 'dispatch']) test(`writer fails closed without retry after ${boundary} failure`, async () => {
  const f = apiFixture();
  await assert.rejects(commitLoader(f.event, generated, async (method, route, body) => {
    const result = await f.request(method, route, body);
    if (method === boundary || (boundary === 'confirmation' && route.includes('/git/ref/')) ||
        (boundary === 'dispatch' && route.endsWith('/dispatches'))) throw new Error('simulated failure');
    return result;
  }, repository));
  assert.equal(f.calls.filter(call => call.method === 'PATCH').length, 1);
  assert.equal(f.calls.filter(call => call.route.endsWith('/dispatches')).length, boundary === 'dispatch' ? 1 : 0);
});

test('real git detection/validation: exact base, head, fork, and other tracked changes', t => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pr-loader-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const git = (...args) => execFileSync('git', args, { cwd: dir, encoding: 'utf8', stdio: 'pipe' }).trim();
  const write = (file, bytes) => fs.writeFileSync(path.join(dir, file), bytes);
  git('init'); git('config', 'user.name', 'Test'); git('config', 'user.email', 'test@example.invalid');
  write('package.json', JSON.stringify(base)); write('binding.js', loader); write('unrelated', 'original');
  git('add', '.'); git('commit', '-m', 'base');
  const event = apiFixture().event;
  event.pull_request.base.sha = git('rev-parse', 'HEAD');
  const env = { ...process.env, GITHUB_EVENT_NAME: 'pull_request', GITHUB_REPOSITORY: repository,
    GITHUB_EVENT_PATH: path.join(dir, 'event.json'), GITHUB_OUTPUT: path.join(dir, 'output') };
  const run = mode => {
    write('event.json', JSON.stringify(event)); write('output', '');
    return spawnSync(process.execPath, [path.join(root, 'scripts/pr-loader.js'), mode], { cwd: dir, env, encoding: 'utf8' });
  };
  event.pull_request.head.sha = git('rev-parse', 'HEAD');
  assert.equal(run('detect').status, 0);
  assert.equal(fs.readFileSync(env.GITHUB_OUTPUT, 'utf8'), 'changed=false\n');
  write('package.json', JSON.stringify(head)); write('unrelated', 'legitimate PR source change');
  git('commit', '-am', 'version plus source');
  event.pull_request.head.sha = git('rev-parse', 'HEAD');
  assert.equal(run('detect').status, 0);
  assert.equal(fs.readFileSync(env.GITHUB_OUTPUT, 'utf8'), 'changed=true\n');
  write('binding.js', generated);
  assert.equal(run('validate').status, 0);
  assert.equal(fs.readFileSync(env.GITHUB_OUTPUT, 'utf8'), 'changed=true\n');
  event.pull_request.head.repo.full_name = 'outside/fork';
  assert.match(run('validate').stderr, /Fork PR needs a loader update/);
  event.pull_request.head.repo.full_name = repository;
  write('unrelated', 'build changed this');
  assert.match(run('validate').stderr, /Generation changed tracked files/);
  git('restore', 'unrelated');
  git('commit', '-am', 'reviewed loader');
  event.pull_request.head.sha = git('rev-parse', 'HEAD');
  assert.equal(run('validate').status, 0);
  assert.equal(fs.readFileSync(env.GITHUB_OUTPUT, 'utf8'), 'changed=false\n');
});

test('workflow blocks both old-head matrices and confines writes to trusted base code', () => {
  const ci = fs.readFileSync(path.join(root, '.github/workflows/ci.yml'), 'utf8');
  assert(ci.includes("  build:\n    needs: loader-check\n    if: needs.loader-check.outputs.changed == 'false'\n    uses: ./.github/workflows/native.yml"));
  const native = fs.readFileSync(path.join(root, '.github/workflows/native.yml'), 'utf8');
  assert.doesNotMatch(native, /contents: write|actions: write/);
  assert.match(native, /  prebuild:/);
  assert.match(native, /  prebuild-musl:/);
  assert.doesNotMatch(ci, /pull_request_target/);
  assert.equal((ci.match(/contents: write/g) || []).length, 1);
  const writer = ci.split('  update-pr-loader:')[1].split('  build:')[0];
  assert.match(writer, /head.repo.full_name == github.repository/);
  assert.match(writer, /base.ref == 'main'/);
  assert.match(writer, /ref: \$\{\{ github.event.pull_request.base.sha \}\}/);
  assert.match(writer, /persist-credentials: false/);
  assert.doesNotMatch(writer, /npm (ci|install|run)|cargo|ref: .*head.sha/);
});
