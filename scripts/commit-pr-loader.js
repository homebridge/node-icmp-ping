'use strict';
// Run from the immutable PR BASE checkout, never from PR code, with write access.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const { validateLoader } = require('./pr-loader.js');
async function commitLoader(event, generated, request, repository) {
  assert.equal(repository, 'homebridge/node-icmp-ping');
  const pr = event.pull_request;
  assert(pr && ['opened', 'synchronize', 'reopened'].includes(event.action));
  assert.equal(pr.head.repo.full_name, repository, 'Fork writes are forbidden');
  assert.equal(pr.base.repo.full_name, repository);
  assert.equal(pr.base.ref, 'main', 'Only the trusted main base may authorize writes');
  assert.notEqual(pr.head.ref, pr.base.ref);
  const prefix = `/repos/${repository}`;
  const live = await request('GET', `${prefix}/pulls/${pr.number}`);
  assert.equal(live.state, 'open');
  for (const side of ['head', 'base']) {
    assert.equal(live[side].sha, pr[side].sha, 'PR advanced; rerun CI on the current head/base');
    assert.equal(live[side].ref, pr[side].ref);
    assert.equal(live[side].repo.full_name, repository);
  }
  const read = async (sha, file) => {
    const data = await request('GET', `${prefix}/contents/${file}?ref=${sha}`);
    assert.equal(data.type, 'file');
    assert.equal(data.encoding, 'base64');
    return Buffer.from(data.content, 'base64').toString('utf8');
  };
  const base = JSON.parse(await read(pr.base.sha, 'package.json'));
  const head = JSON.parse(await read(pr.head.sha, 'package.json'));
  const tracked = await read(pr.head.sha, 'binding.js');
  assert(validateLoader(tracked, generated, base, head), 'No loader update needed');
  const parent = await request('GET', `${prefix}/git/commits/${pr.head.sha}`);
  const tree = await request('POST', `${prefix}/git/trees`, {
    base_tree: parent.tree.sha,
    tree: [{ path: 'binding.js', mode: '100644', type: 'blob', content: generated }],
  });
  const commit = await request('POST', `${prefix}/git/commits`, {
    message: `fix: align generated loader with package version ${head.version}`,
    tree: tree.sha, parents: [pr.head.sha],
  });
  // A concurrent branch update rejects this fast-forward; never force or retry.
  const ref = `${prefix}/git/refs/heads/${encodeURIComponent(pr.head.ref)}`;
  await request('PATCH', ref, { sha: commit.sha, force: false });
  const confirmed = await request('GET', `${prefix}/git/ref/heads/${encodeURIComponent(pr.head.ref)}`);
  assert.equal(confirmed.object.sha, commit.sha, 'Branch advanced after write; run CI on its latest head');
  // GITHUB_TOKEN pushes do not trigger pull_request/synchronize. Dispatch is
  // explicitly supported and creates checks on the updated branch commit.
  await request('POST', `${prefix}/actions/workflows/ci.yml/dispatches`, { ref: pr.head.ref });
  return commit.sha;
}
async function main() {
  assert.equal(process.env.GITHUB_EVENT_NAME, 'pull_request');
  const event = JSON.parse(fs.readFileSync(process.env.GITHUB_EVENT_PATH, 'utf8'));
  const request = async (method, route, body) => {
    const response = await fetch(`https://api.github.com${route}`, {
      method, headers: { Authorization: `Bearer ${process.env.GH_TOKEN}`, Accept: 'application/vnd.github+json',
        'Content-Type': 'application/json', 'X-GitHub-Api-Version': '2022-11-28' },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    assert(response.ok, `${method} ${route} failed (${response.status}); inspect branch and rerun CI manually if the loader commit landed`);
    return response.status === 204 ? null : response.json();
  };
  const sha = await commitLoader(event, fs.readFileSync('regenerated-loader/binding.js', 'utf8'), request, process.env.GITHUB_REPOSITORY);
  console.log(`Committed only binding.js: ${sha}; dispatched Build and test on the updated branch`);
}
if (require.main === module) main().catch(error => { console.error(error); process.exitCode = 1; });
module.exports = { commitLoader };
