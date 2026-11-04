import test from 'node:test';
import assert from 'node:assert/strict';
import { parseAuthStatus } from '../../lib/gh/auth.js';

const modern = `github.com
  ✓ Logged in to github.com account octocat (keyring)
  - Active account: true
  - Git operations protocol: https
  - Token: gho_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa
  - Token scopes: 'gist', 'read:org', 'repo', 'workflow'

ghe.example.com
  ✓ Logged in to ghe.example.com account admin (keyring)
  - Active account: false
  - Token scopes: 'repo'
`;

test('parseAuthStatus reads modern multi-host output', () => {
  const hosts = parseAuthStatus(modern);
  assert.equal(hosts.length, 2);
  assert.deepEqual(hosts[0], {
    host: 'github.com',
    account: 'octocat',
    active: true,
    scopes: ['gist', 'read:org', 'repo', 'workflow'],
  });
  assert.equal(hosts[1].host, 'ghe.example.com');
  assert.equal(hosts[1].account, 'admin');
  assert.equal(hosts[1].active, false);
});

test('parseAuthStatus supports the older "as" wording', () => {
  const hosts = parseAuthStatus(`github.com
  ✓ Logged in to github.com as octocat (keyring)
  - Token scopes: 'repo'
`);
  assert.equal(hosts.length, 1);
  assert.equal(hosts[0].account, 'octocat');
  assert.deepEqual(hosts[0].scopes, ['repo']);
});

test('parseAuthStatus handles a single host without a header', () => {
  const hosts = parseAuthStatus('✓ Logged in to github.com account octocat (keyring)');
  assert.equal(hosts.length, 1);
  assert.equal(hosts[0].host, 'github.com');
  assert.equal(hosts[0].account, 'octocat');
});

test('parseAuthStatus tolerates a UTF-8 BOM', () => {
  const hosts = parseAuthStatus('\uFEFFgithub.com\n  ✓ Logged in to github.com account octocat (keyring)\n  - Token scopes: \'repo\'\n');
  assert.equal(hosts.length, 1);
  assert.deepEqual(hosts[0].scopes, ['repo']);
});

test('parseAuthStatus returns an empty list when logged out', () => {
  assert.deepEqual(parseAuthStatus('You are not logged into any GitHub hosts.'), []);
});

test('parseAuthStatus never retains a token field', () => {
  const hosts = parseAuthStatus(modern);
  for (const host of hosts) assert.equal('token' in host, false);
});
