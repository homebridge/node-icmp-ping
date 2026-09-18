'use strict';
const native = require('./binding.js');
async function ping(ip) {
  if (arguments.length !== 1 || typeof ip !== 'string') {
    throw new TypeError('ping requires exactly one IP-literal string');
  }
  return native.ping(ip);
}
module.exports = { ping };
