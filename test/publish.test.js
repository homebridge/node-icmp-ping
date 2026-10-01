'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { integrity, lookup, publish } = require('../scripts/publish.js');
const { version } = require('../package.json');
const { rootName } = require('../scripts/package-identity.js');
const { channel } = require('../scripts/release-policy.js');
const releaseChannel = channel(version, version.includes('-'));
const item = { name: rootName, version, channel: releaseChannel, integrity: integrity(Buffer.from('artifact')) };
const items = [item];
const state = item => ({ metadata: { name: item.name, version: item.version, dist: { integrity: item.integrity } }, tags: { [item.channel]: item.version } });
function harness(count = 0) {
  const registry = new Map(items.slice(0, count).map(item => [item.name, state(item)]));
  const writes = [];
  const reads = [];
  return { registry, writes, reads, options: {
    log() {},
    async delay() {},
    async read(item) { reads.push(item.name); return registry.get(item.name) || null; },
    async write(item) { writes.push(item.name); registry.set(item.name, state(item)); },
  } };
}
for (const count of [0, 1]) test(`resumable publication with ${count} existing packages`, async () => {
  const h = harness(count);
  await publish(item, h.options);
  assert.deepEqual(h.writes, items.slice(count).map(item => item.name));
  assert.deepEqual(h.reads, items.flatMap((item, i) => i < count ? [item.name] : [item.name, item.name]));
});
for (const index of [0]) test(`integrity mismatch at ${index} aborts`, async () => {
  const h = harness(1);
  h.registry.get(items[index].name).metadata.dist.integrity = integrity(Buffer.from('different'));
  await assert.rejects(publish(item, h.options), /integrity mismatch/);
  assert.deepEqual(h.writes, []);
});
for (const sri of [undefined, '', 'sha512-bad', 'sha256-YWJj', `${items[0].integrity} ${items[0].integrity}`, 'sha512-' + 'A'.repeat(85) + 'B==']) test(`invalid integrity ${sri}`, async () => {
  const h = harness(1);
  h.registry.get(items[0].name).metadata.dist.integrity = sri;
  await assert.rejects(publish(item, h.options), /unsupported registry integrity/);
  assert.deepEqual(h.writes, []);
});
test('dist-tag drift is not repaired', async () => {
  const h = harness(1);
  h.registry.get(items[0].name).tags[releaseChannel] = '0.0.0';
  await assert.rejects(publish(item, h.options), /Dist-tag drift/);
  assert.deepEqual(h.writes, []);
});
test('lookup failures abort before mutation', async () => {
  const h = harness();
  h.options.read = async () => { throw new Error('network'); };
  await assert.rejects(publish(item, h.options), /network/);
  assert.deepEqual(h.writes, []);
});
test('ambiguous failure with committed matching state succeeds', async () => {
  const h = harness();
  const write = h.options.write;
  h.options.write = async item => { await write(item); throw new Error('lost response'); };
  await publish(item, h.options);
  assert.deepEqual(h.writes, items.map(item => item.name));
});
for (const outcome of ['absent', 'mismatch', 'tag', 'network']) test(`failed publish read-back ${outcome} aborts without retry`, async () => {
  const h = harness();
  const read = h.options.read;
  h.options.read = async item => {
    if (outcome === 'network' && h.writes.length) throw new Error('network');
    return read(item);
  };
  h.options.write = async item => {
    h.writes.push(item.name);
    if (outcome !== 'absent') h.registry.set(item.name, state(item));
    if (outcome === 'mismatch') h.registry.get(item.name).metadata.dist.integrity = integrity(Buffer.from('wrong'));
    if (outcome === 'tag') h.registry.get(item.name).tags[releaseChannel] = '0.0.0';
    throw new Error('publish failure');
  };
  await assert.rejects(publish(item, h.options), /read-back could not verify/);
  assert.deepEqual(h.writes, [items[0].name]);
});
test('successful client exit without verified registry state fails', async () => {
  const h = harness();
  h.options.write = async item => { h.writes.push(item.name); };
  await assert.rejects(publish(item, h.options), /read-back did not establish/);
  assert.deepEqual(h.writes, [items[0].name]);
});
test('fresh registry request bypasses caches and validates exact metadata', async () => {
  const urls = [];
  const fake = async (url, options) => {
    urls.push(String(url));
    assert.equal(url.origin, 'https://registry.npmjs.org');
    assert.equal(url.pathname, '/' + encodeURIComponent(items[0].name));
    assert.equal(decodeURIComponent(url.pathname.slice(1)), items[0].name);
    assert.equal(options.cache, 'no-store');
    assert.equal(options.headers['Cache-Control'], 'no-cache, no-store');
    return { ok: true, status: 200, json: async () => ({ name: items[0].name, versions: { [version]: state(items[0]).metadata }, 'dist-tags': state(items[0]).tags }) };
  };
  assert.deepEqual(await lookup(items[0], fake), state(items[0]));
  await lookup(items[0], fake);
  assert.notEqual(urls[0], urls[1]);
});
for (const response of [
  { ok: false, status: 500, json: async () => ({}) },
  { ok: false, status: 404, json: async () => ({ error: 'other failure' }) },
  { ok: true, status: 200, json: async () => ({}) },
  { ok: true, status: 200, json: async () => { throw new Error('bad JSON'); } },
]) test(`registry failure closes safely: ${response.status}`, async () => {
  await assert.rejects(lookup(items[0], async () => response));
});
test('explicit package 404 and absent version permit publication', async () => {
  assert.equal(await lookup(items[0], async () => ({ status: 404, json: async () => ({ error: 'Not found' }) })), null);
  assert.equal(await lookup(items[0], async () => ({ ok: true, status: 200, json: async () => ({ name: items[0].name, versions: {}, 'dist-tags': {} }) })), null);
  await assert.rejects(lookup(items[0], async () => { throw new Error('network'); }), /network/);
});
test('SHA-512 SRI known byte fixture', () => {
  assert.equal(integrity(Buffer.from('abc')), 'sha512-3a81oZNherrMQXNJriBBMRLm+k6JqX6iCp7u5ktV05ohkpkqJ0/BqDa6PCOj/uu9RU1EI2Q86A4qmslPpUyknw==');
});

test('known compressed tarball fixture SRI', () => {
  const bytes = fs.readFileSync(path.join(__dirname, 'fixtures/publish.tgz'));
  assert.equal(integrity(bytes), 'sha512-MrdVBzK3rXjUKST+knO2YvW8OISOzu7ipA4har69ccgI+QWS1ZGL+/Nl8Ef8tffHCclsu0oWjSx/pbu2y21xtQ==');
});
for (const [releaseVersion, expectedChannel] of [['0.9.0-beta.1', 'next'], ['1.0.0', 'latest']]) test(`${releaseVersion} uses ${expectedChannel} for publication and read-back`, async () => {
  const release = { ...item, version: releaseVersion, channel: expectedChannel };
  const registry = new Map();
  await publish(release, {
    log() {},
    read: async item => registry.get(item.name) || null,
    write: async item => { assert.equal(item.channel, expectedChannel); registry.set(item.name, state(item)); },
  });
  assert.equal(registry.size, 1);
});
for (const [releaseVersion, prerelease, expected] of [
  ['0.9.0-beta.1', true, 'next'],
  ['1.0.0', false, 'latest'],
  ['0.9.0', false, 'latest'],
]) test(`release metadata policy for ${releaseVersion}`, () => {
  assert.equal(channel(releaseVersion, prerelease), expected);
  assert.throws(() => channel(releaseVersion, !prerelease), /prerelease flag mismatches/);
});

test('default npm writer receives an absolute tarball path from relative preflight', async t => {
  const os = require('node:os');
  const { spawnSync } = require('node:child_process');
  const temporary = fs.mkdtempSync(path.join(os.tmpdir(), 'publish-argument-'));
  t.after(() => fs.rmSync(temporary, { recursive: true, force: true }));
  // A child isolates the transport stub before publish.js captures execFileSync.
  // Only tar metadata inspection is stubbed; real preflight reads/checks retained bytes.
  const script = `
    const assert = require('node:assert/strict');
    const fs = require('node:fs');
    const path = require('node:path');
    const cp = require('node:child_process');
    const pkg = require(${JSON.stringify(require.resolve('../package.json'))});
    const filename = require(${JSON.stringify(require.resolve('../scripts/package-identity.js'))}).tarballName(pkg.name, pkg.version);
    let called = false;
    cp.execFileSync = (command, args, options) => {
      assert.equal(command, 'npm');
      assert.equal(path.isAbsolute(args[1]), true, 'npm tarball argument must be absolute');
      assert.deepEqual(args, ['publish', path.resolve('distribution', filename), '--registry', 'https://registry.npmjs.org/', '--access', 'public', '--provenance', '--tag', ${JSON.stringify(releaseChannel)}]);
      assert.equal(options.stdio, 'inherit');
      called = true;
    };
    require(${JSON.stringify(require.resolve('../scripts/check-package.js'))}).inspectTarball = () => pkg;
    const { integrity, preflight, publish } = require(${JSON.stringify(require.resolve('../scripts/publish.js'))});
    fs.mkdirSync('distribution');
    fs.writeFileSync(path.join('distribution', filename), 'retained test bytes');
    fs.writeFileSync('distribution/integrity.json', JSON.stringify({name: pkg.name, version: pkg.version, filename, integrity: integrity(Buffer.from('retained test bytes'))}));
    const item = preflight('distribution', ${JSON.stringify(releaseChannel)});
    let reads = 0;
    publish(item, { log() {}, read: async () => ++reads === 1 ? null : ({metadata: { name: item.name, version: item.version, dist: {integrity: item.integrity}}, tags: {[item.channel]: item.version}}) })
      .then(() => assert(called, 'default writer must execute'))
      .catch(error => { console.error(error); process.exitCode = 1; });
  `;
  const result = spawnSync(process.execPath, ['-e', script], { cwd: temporary, encoding: 'utf8' });
  assert.equal(result.status, 0, result.stderr);
});

for (const clientFails of [false, true]) test(`delayed registry visibility succeeds with one publish (client failure: ${clientFails})`, async () => {
  const events = [];
  let reads = 0;
  await publish(item, {
    log() {},
    read: async received => {
      assert.equal(received, item);
      events.push('read');
      return ++reads < 4 ? null : state(item);
    },
    write: async () => {
      events.push('publish');
      if (clientFails) throw new Error('lost response');
    },
    delay: async milliseconds => { events.push(milliseconds); },
  });
  assert.deepEqual(events, ['read', 'publish', 'read', 2000, 'read', 4000, 'read']);
});

test('absent read-back exhausts bounded backoff without repeating publish', async () => {
  const h = harness();
  const delays = [];
  h.options.write = async item => { h.writes.push(item.name); };
  h.options.delay = async milliseconds => { delays.push(milliseconds); };
  await assert.rejects(publish(item, h.options), /Registry read-back did not establish/);
  assert.deepEqual(delays, [2000, 4000, 8000, 16000]);
  assert.equal(h.reads.length, 6); // One preflight plus five post-mutation reads.
  assert.deepEqual(h.writes, [item.name]);
});

for (const [label, corrupt, expected] of [
  ['name', s => { s.metadata.name = 'wrong'; }, /name mismatch/],
  ['version', s => { s.metadata.version = '0.0.0'; }, /version mismatch/],
  ['integrity', s => { s.metadata.dist.integrity = integrity(Buffer.from('wrong')); }, /integrity mismatch/],
  ['malformed integrity', s => { s.metadata.dist.integrity = 'sha512-bad'; }, /unsupported registry integrity/],
  ['tag', s => { s.tags[item.channel] = '0.0.0'; }, /Dist-tag drift/],
  ['network', null, /network/],
]) test(`post-publish ${label} failure after absence stops immediately`, async () => {
  let reads = 0;
  let writes = 0;
  const delays = [];
  await assert.rejects(publish(item, {
    log() {},
    read: async () => {
      if (++reads <= 2) return null;
      if (reads > 3) return state(item); // Must never accept this later state.
      if (!corrupt) throw new Error('network');
      const invalid = state(item);
      corrupt(invalid);
      return invalid;
    },
    write: async () => { writes++; },
    delay: async milliseconds => { delays.push(milliseconds); },
  }), expected);
  assert.equal(reads, 3);
  assert.equal(writes, 1);
  assert.deepEqual(delays, [2000]);
});
