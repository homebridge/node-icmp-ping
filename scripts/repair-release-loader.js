'use strict';
const fs = require('node:fs');
const assert = require('node:assert/strict');
const { execFileSync } = require('node:child_process');
const { digest } = require('./release-loader.js');
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
  git(['fetch', '--no-tags', 'origin', '+refs/heads/main:refs/remotes/origin/main']);
  if (git(['rev-parse', 'refs/remotes/origin/main']) === env.GITHUB_SHA) {
    try {
      // Normal fast-forward only: a concurrent main update or branch rule rejects this.
      git(['push', 'origin', 'HEAD:refs/heads/main']);
      return `\`binding.js\` differed from the version committed at \`${tag}\`. The loader was regenerated and committed to \`main\` (${commit}). Nothing was published to npm. Review the generated change, manually delete the GitHub release/tag, then recreate the release.`;
    } catch (error) {
      log(`Direct main push was not confirmed: ${error.message}`);
      // Resolve an ambiguous successful push before choosing the fallback.
      git(['fetch', '--no-tags', 'origin', '+refs/heads/main:refs/remotes/origin/main']);
      try {
        git(['merge-base', '--is-ancestor', commit, 'refs/remotes/origin/main']);
        return `\`binding.js\` differed at \`${tag}\`. The regenerated loader commit ${commit} is confirmed on main. Nothing was published to npm. Review the generated change, manually delete the GitHub release/tag, then recreate the release.`;
      } catch { /* Main did not accept the commit; retain it on a recovery branch. */ }
    }
  }
  assert.match(env.GITHUB_RUN_ID, /^\d+$/);
  assert.match(env.GITHUB_RUN_ATTEMPT, /^\d+$/);
  const branch = `release-loader/${env.GITHUB_RUN_ID}-${env.GITHUB_RUN_ATTEMPT}`;
  // A unique, create-only ref: never overwrite an existing recovery branch.
  git(['push', `--force-with-lease=refs/heads/${branch}:`, 'origin', `HEAD:refs/heads/${branch}`]);
  return `\`binding.js\` differed from the version committed at \`${tag}\`. Main advanced or rejected the automated push. The regenerated loader was committed to \`${branch}\` (${commit}). Nothing was published to npm. Review and merge the loader change through a normal PR, obtain green CI, manually delete the GitHub release/tag, then recreate the release. Do not weaken branch protections. If main changed generation inputs, CI may require a fresh release attempt to regenerate from the updated source.`;
}
if (require.main === module) {
  let message;
  try { message = repair(); } catch (error) {
    console.error(error);
    message = 'Loader repair could not be confirmed. Nothing was published to npm. Download the regenerated-loader artifact from this run and review binding.js through a normal change; do not regenerate it manually or weaken branch protections. Resolve the repair, obtain green CI, then manually delete the failed GitHub release/tag and recreate the release.';
  }
  console.error(`::error::${message}`);
  if (process.env.GITHUB_STEP_SUMMARY) fs.appendFileSync(process.env.GITHUB_STEP_SUMMARY, `## Release stopped: loader mismatch\n\n${message}\n`);
  // Even a successful repair MUST fail: this run's tag still contains the old loader.
  process.exitCode = 1;
}
module.exports = { repair };
