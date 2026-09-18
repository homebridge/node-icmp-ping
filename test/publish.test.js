'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const { integrity, preflight, lookup, publish } = require('../scripts/publish.js');
const items = Array.from({ length: 7 }, (_, i) => ({ name: i === 6 ? 'node-icmp-ping' : `native-${i}`, version: '1.0.0', channel: 'latest', integrity: integrity(Buffer.from(`artifact-${i}`)) }));
const state = item => ({ metadata: { name: item.name, version: item.version, dist: { integrity: item.integrity } }, tags: { [item.channel]: item.version } });
function harness(count = 0) {
  const registry = new Map(items.slice(0, count).map(item => [item.name, state(item)]));
  const writes = [];
  const reads = [];
  return { registry, writes, reads, options: {
    log() {},
    async read(item) { reads.push(item.name); return registry.get(item.name) || null; },
    async write(item) { writes.push(item.name); registry.set(item.name, state(item)); },
  } };
}
for (const count of [0, 2, 7]) test(`resumable publication with ${count} existing packages`, async () => {
  const h = harness(count);
  await publish(items, h.options);
  assert.deepEqual(h.writes, items.slice(count).map(item => item.name));
  assert.deepEqual(h.reads, items.flatMap((item, i) => i < count ? [item.name] : [item.name, item.name]));
});
for (const index of [0, 6]) test(`integrity mismatch at ${index} aborts`, async () => {
  const h = harness(7);
  h.registry.get(items[index].name).metadata.dist.integrity = integrity(Buffer.from('different'));
  await assert.rejects(publish(items, h.options), /integrity mismatch/);
  assert.deepEqual(h.writes, []);
});
for (const sri of [undefined, '', 'sha512-bad', 'sha256-YWJj', `${items[0].integrity} ${items[0].integrity}`, 'sha512-' + 'A'.repeat(85) + 'B==']) test(`invalid integrity ${sri}`, async () => {
  const h = harness(1);
  h.registry.get(items[0].name).metadata.dist.integrity = sri;
  await assert.rejects(publish(items, h.options), /unsupported registry integrity/);
  assert.deepEqual(h.writes, []);
});
test('dist-tag drift is not repaired', async () => {
  const h = harness(1);
  h.registry.get(items[0].name).tags.latest = '0.9.0';
  await assert.rejects(publish(items, h.options), /Dist-tag drift/);
  assert.deepEqual(h.writes, []);
});
test('lookup failures abort before mutation', async () => {
  const h = harness();
  h.options.read = async () => { throw new Error('network'); };
  await assert.rejects(publish(items, h.options), /network/);
  assert.deepEqual(h.writes, []);
});
test('ambiguous failure with committed matching state succeeds', async () => {
  const h = harness();
  const write = h.options.write;
  h.options.write = async item => { await write(item); throw new Error('lost response'); };
  await publish(items, h.options);
  assert.deepEqual(h.writes, items.map(item => item.name));
});
for (const outcome of ['absent', 'mismatch', 'tag', 'network']) test(`failed publish read-back ${outcome} aborts without retry or root`, async () => {
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
    if (outcome === 'tag') h.registry.get(item.name).tags.latest = '0.9.0';
    throw new Error('publish failure');
  };
  await assert.rejects(publish(items, h.options), /read-back could not verify/);
  assert.deepEqual(h.writes, [items[0].name]);
});
test('successful exit without verified native blocks root', async () => {
  const h = harness();
  h.options.write = async item => { h.writes.push(item.name); };
  await assert.rejects(publish(items, h.options), /read-back did not establish/);
  assert.deepEqual(h.writes, [items[0].name]);
});
test('fresh registry request bypasses caches and validates exact metadata', async () => {
  const urls = [];
  const fake = async (url, options) => {
    urls.push(String(url));
    assert.equal(options.cache, 'no-store');
    assert.equal(options.headers['Cache-Control'], 'no-cache, no-store');
    return { ok: true, status: 200, json: async () => ({ name: items[0].name, versions: { '1.0.0': state(items[0]).metadata }, 'dist-tags': { latest: '1.0.0' } }) };
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
test('preflight inspects all compressed tarballs and orders root last', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'publish-test-'));
  try {
    const source = path.join(dir, 'source');
    const distribution = path.join(dir, 'distribution');
    fs.mkdirSync(path.join(source, 'package'), { recursive: true });
    fs.mkdirSync(distribution);
    const optionalDependencies = Object.fromEntries(items.slice(0, 6).map(item => [item.name, item.version]));
    for (const item of [...items].reverse()) {
      fs.writeFileSync(path.join(source, 'package/package.json'), JSON.stringify({ name: item.name, version: item.version, optionalDependencies }));
      fs.writeFileSync(path.join(source, 'package/binding.node'), 'fixture');
      execFileSync('tar', ['-czf', path.join(distribution, `${item.name}-${item.version}.tgz`), '-C', source, 'package']);
    }
    const result = preflight(distribution, 'latest');
    assert.equal(result.length, 7);
    assert.equal(result[6].name, 'node-icmp-ping');
    for (const item of result) {
      const digest = execFileSync('openssl', ['dgst', '-sha512', '-binary', item.tarball]);
      assert.equal(item.integrity, `sha512-${digest.toString('base64')}`);
    }
    assert.throws(() => preflight(distribution, 'next'), /Unsafe release channel/);
    fs.writeFileSync(result[6].tarball, 'corrupt');
    assert.throws(() => preflight(distribution, 'latest'));
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});
test('SHA-512 SRI known byte fixture', () => {
  assert.equal(integrity(Buffer.from('abc')), 'sha512-3a81oZNherrMQXNJriBBMRLm+k6JqX6iCp7u5ktV05ohkpkqJ0/BqDa6PCOj/uu9RU1EI2Q86A4qmslPpUyknw==');
});

test('known compressed tarball fixture SRI', () => {
  const bytes = fs.readFileSync(path.join(__dirname, 'fixtures/publish.tgz'));
  assert.equal(integrity(bytes), 'sha512-MrdVBzK3rXjUKST+knO2YvW8OISOzu7ipA4har69ccgI+QWS1ZGL+/Nl8Ef8tffHCclsu0oWjSx/pbu2y21xtQ==');
});
test('prerelease uses next for publication and read-back', async () => {
  const prerelease = items.map(item => ({ ...item, version: '1.0.0-beta.1', channel: 'next' }));
  const registry = new Map();
  await publish(prerelease, {
    log() {},
    read: async item => registry.get(item.name) || null,
    write: async item => { assert.equal(item.channel, 'next'); registry.set(item.name, state(item)); },
  });
  assert.equal(registry.size, 7);
});
test('root cannot be accepted before every native is verified', async () => {
  const h = harness(7);
  h.registry.get(items[5].name).tags.latest = '0.9.0';
  await assert.rejects(publish(items, h.options), /Dist-tag drift/);
  assert(!h.reads.includes(items[6].name));
  assert.deepEqual(h.writes, []);
});
