'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { checkLoader } = require('../scripts/check-generated.js');

test('generated loader equals committed loader, allowing checkout CRLF only', () => {
  checkLoader('generated\n', 'generated\n');
  checkLoader('generated\r\n', 'generated\n');
});
for (const committed of ["version = '1.0.0'\n", 'unreviewed change\n', 'generated']) {
  test(`generated mismatch rejects ${JSON.stringify(committed)} with correction instructions and diff`, () => {
    assert.throws(() => checkLoader(committed, 'generated\n'), error => {
      assert.match(error.message, /npm ci && npm run build/);
      assert.equal(error.actual, 'generated\n');
      assert.equal(error.expected, committed);
      return true;
    });
  });
}
