'use strict';
const fs = require('node:fs');
const assert = require('node:assert/strict');
const { execFileSync } = require('node:child_process');
const { digest } = require('./release-loader.js');
function recovery(reason) {
  return `Loader repair could not be confirmed: ${reason}. Nothing was published to npm. No recovery branch was created. Download regenerated-loader/binding.js from this run if available and preserve the release commit and artifact digest. First fetch and inspect current main for a repair commit (a failed push response may still mean the push succeeded); do not blindly apply or retry the old artifact. In a clean checkout of current main, run npm ci and the canonical npm run build to regenerate binding.js from current source, then review and commit only binding.js through the normal reviewed change process if needed. The retained artifact is a comparison aid, not proof of the current loader. Obtain green nonpublishing CI on the reviewed updated main, then manually delete the failed GitHub Release and tag and recreate the matching release. If no artifact exists, resolve generation/upload failure first. Do not weaken branch protections. This regeneration is exceptional recovery only.`;
}
function repair(env = process.env, log = console.log) {
  const git = args => execFileSync('git', args, { encoding: 'utf8' }).trim();
  const event = JSON.parse(fs.readFileSync(env.GITHUB_EVENT_PATH, 'utf8'));
  const pkg = JSON.parse(fs.readFileSync('package.json', 'utf8'));
  assert.equal(env.GITHUB_EVENT_NAME, 'release');
  assert.equal(event.action, 'published');
  assert.equal(event.release.draft, false);
  require('./release-policy.js').channel(pkg.version, event.release.prerelease);
  const tag = `v${pkg.version}`;
  assert.equal(event.release.tag_name, tag);
  assert.equal(git(['rev-parse', 'HEAD']), env.GITHUB_SHA, 'Repair checkout differs from release');
  assert.equal(git(['status', '--porcelain', '--untracked-files=no']), '', 'Repair checkout must be clean');
  const loader = fs.readFileSync('regenerated-loader/binding.js');
  assert.equal(digest(loader), env.LOADER_SHA256, 'Generated loader artifact digest mismatch');
  assert(!loader.equals(execFileSync('git', ['show', 'HEAD:binding.js'])), 'Expected a loader mismatch');
  fs.writeFileSync('binding.js', loader);
  git(['add', '--', 'binding.js']);
  assert.equal(git(['diff', '--cached', '--name-only']), 'binding.js', 'Only binding.js may be committed');
  git(['-c', 'user.name=github-actions[bot]', '-c', 'user.email=41898282+github-actions[bot]@users.noreply.github.com',
    'commit', '-m', `fix: regenerate release loader for ${tag}`]);
  const commit = git(['rev-parse', 'HEAD']);
  const fetchMain = () => git(['fetch', '--no-tags', 'origin', '+refs/heads/main:refs/remotes/origin/main']);
  fetchMain();
  if (git(['rev-parse', 'refs/remotes/origin/main']) !== env.GITHUB_SHA) {
    return recovery('main advanced beyond the release commit; no push was attempted');
  }
  let pushError;
  try {
    // Normal fast-forward only: a concurrent main update or branch rule rejects this.
    git(['push', 'origin', 'HEAD:refs/heads/main']);
  } catch (error) {
    pushError = error;
    log(`Direct main push was not confirmed: ${error.message}`);
  }
  // Confirm even a successful response; never retry an ambiguous mutation.
  try {
    fetchMain();
  } catch {
    return recovery(`confirming fetch failed after attempting repair commit ${commit}; main may already contain it`);
  }
  try {
    git(['merge-base', '--is-ancestor', commit, 'refs/remotes/origin/main']);
  } catch {
    return recovery(`repair commit ${commit} is not confirmed on main${pushError ? '; direct push failed or its response was lost' : ''}`);
  }
  return `\`binding.js\` differed at \`${tag}\`. The regenerated loader commit ${commit} is confirmed on main. Nothing was published to npm. Review the generated change and obtain green nonpublishing CI on updated main, manually delete the failed GitHub Release and tag, then recreate the matching release.`;
}
if (require.main === module) {
  let message;
  try { message = repair(); } catch (error) {
    console.error(error);
    message = recovery(error.message);
  }
  console.error(`::error::${message}`);
  if (process.env.GITHUB_STEP_SUMMARY) fs.appendFileSync(process.env.GITHUB_STEP_SUMMARY, `## Release stopped: loader mismatch\n\n${message}\n`);
  // Even a successful repair MUST fail: this run's tag still contains the old loader.
  process.exitCode = 1;
}
module.exports = { repair };
