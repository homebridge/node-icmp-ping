'use strict';
let native;
try {
  native = require('./binding.js');
} catch (cause) {
  // Platform and libc selection remain entirely in the generated napi-rs loader.
  const error = new Error(
    `Unable to load @homebridge/node-icmp-ping on ${process.platform}/${process.arch}. ` +
    'Bundled binaries support Linux glibc, macOS, and Windows MSVC on x64/arm64; ' +
    'musl and other platforms/architectures are unsupported. On a supported target, ' +
    'the bundled binary may be missing or incompatible. No download or compilation fallback is provided.',
    { cause },
  );
  error.code = 'ERR_ICMP_NATIVE_BINDING';
  throw error;
}
async function ping(ip) {
  if (arguments.length !== 1 || typeof ip !== 'string') {
    throw new TypeError('ping requires exactly one IP-literal string');
  }
  return native.ping(ip);
}
module.exports = { ping };
