'use strict';
const fs = require('node:fs');
const path = require('node:path');
const assert = require('node:assert/strict');
const { execFileSync } = require('node:child_process');
const pkg = require('../package.json');
const { createHash, randomUUID } = require('node:crypto');

function integrity(bytes) {
  return `sha512-${createHash('sha512').update(bytes).digest('base64')}`;
}

function preflight(directory, channel) {
  const expectedChannel = require('./release-policy.js').channel(pkg.version, pkg.version.includes('-'));
  assert.equal(channel, expectedChannel, 'Unsafe release channel');
  const files = fs.readdirSync(directory).filter(f => f.endsWith('.tgz'));
  assert.equal(files.length, 7, 'Expected root and six platform tarballs');
  const root = `${pkg.name}-${pkg.version}.tgz`;
  assert(files.includes(root));
  const packages = files.map(filename => {
    const tarball = path.join(directory, filename);
    const metadata = JSON.parse(execFileSync('tar', ['-xOf', tarball, 'package/package.json'], { encoding: 'utf8' }));
    assert.equal(metadata.version, pkg.version);
    assert.equal(filename, `${metadata.name}-${metadata.version}.tgz`);
    if (filename !== root) {
      const listing = execFileSync('tar', ['-tf', tarball], { encoding: 'utf8' });
      assert(listing.includes('.node'), `Missing native binding: ${filename}`);
    } else { assert.equal(Object.keys(metadata.optionalDependencies).length, 6); }
    return { name: metadata.name, version: metadata.version, channel, tarball, integrity: integrity(fs.readFileSync(tarball)), metadata };
  });
  const rootPackage = packages.find(p => p.name === pkg.name);
  const natives = packages.filter(p => p !== rootPackage);
  assert.equal(new Set(packages.map(p => p.name)).size, 7, 'Duplicate package names');
  for (const native of natives) {
    assert.equal(rootPackage.metadata.optionalDependencies[native.name], native.version, 'Root must require every intended native package');
  }
  return [...natives, rootPackage];
}

// Read the full packument directly, bypassing npm's local cache and requesting
// revalidation from intermediaries. A unique URL prevents cached release decisions.
async function lookup(item, fetchRegistry = fetch) {
  const url = new URL(encodeURIComponent(item.name), 'https://registry.npmjs.org/');
  url.searchParams.set('release-check', randomUUID());
  const response = await fetchRegistry(url, {
    cache: 'no-store', redirect: 'error', signal: AbortSignal.timeout(30000),
    headers: { Accept: 'application/json', 'Cache-Control': 'no-cache, no-store', Pragma: 'no-cache' },
  });
  const body = await response.json();
  if (response.status === 404 && body && body.error === 'Not found') return null;
  assert(response.ok, `Registry lookup failed for ${item.name}: HTTP ${response.status}`);
  assert(body && body.name === item.name && body.versions && typeof body.versions === 'object' && !Array.isArray(body.versions), `Invalid registry metadata for ${item.name}`);
  assert(body['dist-tags'] && typeof body['dist-tags'] === 'object' && !Array.isArray(body['dist-tags']), `Invalid registry tags for ${item.name}`);
  if (!Object.hasOwn(body.versions, item.version)) return null;
  return { metadata: body.versions[item.version], tags: body['dist-tags'] };
}

function verify(item, state) {
  const label = `${item.name}@${item.version}`;
  assert(state, `Registry read-back did not establish ${label}`);
  assert.equal(state.metadata?.name, item.name, `Registry name mismatch for ${label}`);
  assert.equal(state.metadata?.version, item.version, `Registry version mismatch for ${label}`);
  const sri = state.metadata?.dist?.integrity;
  assert(typeof sri === 'string' && /^sha512-[A-Za-z0-9+/]{86}==$/.test(sri) &&
    `sha512-${Buffer.from(sri.slice(7), 'base64').toString('base64')}` === sri,
  `Missing, malformed or unsupported registry integrity for ${label}`);
  assert.equal(sri, item.integrity, `Registry integrity mismatch for ${label}; investigate the original distribution artifact`);
  assert.equal(state.tags[item.channel], item.version, `Dist-tag drift for ${label}: expected ${item.channel} to point to ${item.version}; no automatic repair`);
}

async function publish(packages, { read = lookup, write = item => {
  execFileSync('npm', ['publish', item.tarball, '--registry', 'https://registry.npmjs.org/', '--access', 'public', '--provenance', '--tag', item.channel], { stdio: 'inherit' });
}, log = console.log } = {}) {
  for (const item of packages) {
    const existing = await read(item);
    if (existing) {
      verify(item, existing);
      log(`Verified already published ${item.name}@${item.version}`);
      continue;
    }
    let publishError;
    try { await write(item); } catch (error) { publishError = error; }
    // Even a failed client response may have followed a committed publication.
    // Never retry the mutation here; fresh registry state is the sole proof.
    try { verify(item, await read(item)); } catch (error) {
      if (publishError) throw new Error(`npm publish failed and read-back could not verify ${item.name}@${item.version}: ${error.message}`, { cause: publishError });
      throw error;
    }
    log(`Verified publication ${item.name}@${item.version}`);
  }
}

if (require.main === module) {
  Promise.resolve().then(() => publish(preflight('distribution', process.env.CHANNEL))).catch(error => {
    console.error(error);
    process.exitCode = 1;
  });
}
module.exports = { integrity, preflight, lookup, verify, publish };
