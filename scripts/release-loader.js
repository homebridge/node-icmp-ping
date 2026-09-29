'use strict';
const fs = require('node:fs');
const assert = require('node:assert/strict');
const { execFileSync } = require('node:child_process');
const { createHash } = require('node:crypto');
const { loaderForVersion } = require('./loader-version.js');
const digest = bytes => createHash('sha256').update(bytes).digest('hex');
function inspect() {
  const modified = execFileSync('git', ['diff', 'HEAD', '--name-only'], { encoding: 'utf8' }).trim().split('\n').filter(Boolean);
  assert(modified.every(file => file === 'binding.js'), 'Generation changed tracked files other than binding.js; stop and investigate');
  const committed = execFileSync('git', ['show', 'HEAD:binding.js']);
  const generated = fs.readFileSync('binding.js');
  const { version } = JSON.parse(fs.readFileSync('package.json', 'utf8'));
  const changed = !generated.equals(Buffer.from(loaderForVersion(committed.toString(), version)));
  if (process.env.GITHUB_OUTPUT) fs.appendFileSync(process.env.GITHUB_OUTPUT,
    `changed=${changed}\nsha256=${digest(generated)}\n`);
  if (changed) {
    console.error('binding.js differs. Release build and npm publication are blocked; retaining regenerated loader for repair.');
    if (process.env.GITHUB_STEP_SUMMARY) fs.appendFileSync(process.env.GITHUB_STEP_SUMMARY,
      '## Release blocked: generated loader differs\nNothing was published to npm. See the repair-loader job for the generated commit or recovery instructions.\n');
  }
  return changed;
}
if (require.main === module) inspect();
module.exports = { inspect, digest };
