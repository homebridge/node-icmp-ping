'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const loader = fs.readFileSync(require.resolve('../binding.js'), 'utf8');
const entry = fs.readFileSync(require.resolve('../index.js'), 'utf8');

function load(platform, arch, { musl = false, missing = false, report = false } = {}) {
  const requested = [];
  const binding = { ping() {} };
  const suffix = platform === 'linux' ? `-${musl ? 'musl' : 'gnu'}` : platform === 'win32' ? '-msvc' : '';
  const filename = `./icmp_ping.${platform}-${arch}${suffix}.node`;
  const supported = ['linux', 'darwin', 'win32'].includes(platform) && ['x64', 'arm64'].includes(arch);
  const process = { platform, arch, env: {}, report: { getReport: () => ({ header: musl ? {} : { glibcVersionRuntime: '2.39' }, sharedObjects: musl ? [`/lib/ld-musl-${arch === 'arm64' ? 'aarch64' : 'x86_64'}.so.1`] : [] }) } };
  const requireBinding = name => {
    requested.push(name);
    if (name === 'fs') return { readFileSync: () => { if (report) throw new Error('ldd unavailable'); return musl ? 'musl libc' : 'GNU libc'; } };
    if (name === filename && supported && !missing) return binding;
    throw new Error(`Cannot find module '${name}'`);
  };
  let error;
  let api;
  try {
    const context = { process, module: { exports: {} }, require: requireBinding };
    vm.runInNewContext(loader, context);
    const root = { process, module: { exports: {} }, require: name => { assert.equal(name, './binding.js'); return context.module.exports; } };
    vm.runInNewContext(entry, root);
    api = root.module.exports;
  } catch (cause) {
    try { vm.runInNewContext(entry, { process, module: { exports: {} }, require: () => { throw cause; } }); } catch (caught) { error = caught; }
  }
  return { requested, error, api, filename };
}
for (const platform of ['linux', 'darwin', 'win32']) for (const arch of ['x64', 'arm64']) {
  test(`generated loader selects bundled ${platform}/${arch}`, () => {
    const result = load(platform, arch);
    assert.ifError(result.error);
    assert.equal(typeof result.api.ping, 'function');
    assert(result.requested.includes(result.filename));
    // macOS first probes a universal binary/package; keep upstream behavior.
    assert(!result.requested.includes(`@homebridge/node-icmp-ping-${platform}-${arch}`));
  });
}
for (const report of [false, true]) for (const arch of ['x64', 'arm64']) test(`musl ${arch}, report=${report}, never loads glibc`, () => {
  const result = load('linux', arch, { musl: true, report });
  assert.ifError(result.error);
  assert.equal(typeof result.api.ping, 'function');
  assert(!result.requested.some(name => name.startsWith('@homebridge/')));
  assert(result.requested.includes(`./icmp_ping.linux-${arch}-musl.node`));
  assert(!result.requested.some(name => name.includes('-gnu')));
});
for (const [platform, arch] of [['linux', 's390x'], ['freebsd', 'x64'], ['plan9', 'x64'], ['darwin', 'ia32']]) test(`unsupported ${platform}/${arch} fails explicitly`, () => {
  const result = load(platform, arch);
  assert.equal(result.error.code, 'ERR_ICMP_NATIVE_BINDING');
  assert.match(result.error.message, /unsupported/);
});
test('missing supported binary preserves the generated error as cause', () => {
  const result = load('linux', 'x64', { missing: true });
  assert.equal(result.error.code, 'ERR_ICMP_NATIVE_BINDING');
  assert.match(result.error.message, /missing or incompatible/);
  assert.match(result.error.cause.message, /native binding/);
});
test('generated libc report fallback still selects glibc', () => {
  assert.ifError(load('linux', 'arm64', { report: true }).error);
});

for (const arch of ['x64', 'arm64']) test(`missing musl ${arch} never falls back to glibc`, () => {
  const result = load('linux', arch, { musl: true, missing: true });
  assert.equal(result.error.code, 'ERR_ICMP_NATIVE_BINDING');
  assert.match(result.error.message, /missing or incompatible/);
  assert(result.error.cause);
  assert(!result.requested.some(name => name.includes('-gnu')));
});
