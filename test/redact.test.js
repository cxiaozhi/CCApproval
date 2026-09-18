'use strict';
/** Credentials must never reach the audit log; ordinary content must survive. */
const assert = require('assert');
const { redactString, redactValue, MARK } = require('../src/redact');

const FAKE_SK = 'sk-FAKEfakeFAKEfake1234';

// --- must be redacted ---
const secrets = [
  ['bearer header', `curl -H "Authorization: Bearer ${FAKE_SK}" https://x`, FAKE_SK],
  ['json field', `"ANTHROPIC_AUTH_TOKEN": "${FAKE_SK}"`, FAKE_SK],
  ['assignment', `--token=${FAKE_SK}`, FAKE_SK],
  ['export', 'export GITHUB_TOKEN=ghp_abcdefghijklmnopqrstuvwx', 'ghp_abcdefghijklmnopqrstuvwx'],
  ['aws', 'AWS_KEY=AKIAIOSFODNN7EXAMPLE', 'AKIAIOSFODNN7EXAMPLE'],
  ['password field', 'mysql -p --password=hunter2secret', 'hunter2secret'],
];
for (const [label, input, secret] of secrets) {
  const out = redactString(input);
  assert.ok(!out.includes(secret), `${label}: secret survived → ${out}`);
  assert.ok(out.includes(MARK), `${label}: nothing was masked → ${out}`);
  console.log('✔ masked: ' + label);
}

// --- must survive untouched ---
const ordinary = [
  'git status',
  'npm test 2>&1 | tail -5',
  'echo "hello world"',
  'grep -i token src/index.js',          // no assignment, no credential shape
  'node -e "console.log(1)"',
];
for (const input of ordinary) {
  assert.strictEqual(redactString(input), input, `over-redacted: ${input}`);
}
console.log('✔ kept: ' + ordinary.length + ' ordinary commands untouched');

// --- object walk: `author` must not trip the `auth` pattern ---
const obj = redactValue({
  command: `curl -H "Authorization: Bearer ${FAKE_SK}" x`,
  author: 'chen_da_lei',
  token: FAKE_SK,
  nested: { apiKey: FAKE_SK, note: 'plain text' },
  file_path: 'F:/workspace/x.js',
});
assert.ok(!JSON.stringify(obj).includes(FAKE_SK), 'object walk leaked the secret');
assert.strictEqual(obj.author, 'chen_da_lei', '`author` was wrongly redacted');
assert.strictEqual(obj.token, MARK, 'token field not masked');
assert.strictEqual(obj.nested.apiKey, MARK, 'nested apiKey not masked');
assert.strictEqual(obj.nested.note, 'plain text', 'ordinary nested value changed');
assert.strictEqual(obj.file_path, 'F:/workspace/x.js', 'file_path changed');
console.log('✔ object walk: nested secrets masked, `author` and ordinary values intact');

console.log('\n✔ redact tests passed (' + (secrets.length + ordinary.length + 1) + ' checks)');
