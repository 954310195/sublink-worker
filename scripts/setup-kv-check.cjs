const assert = require('node:assert/strict');
const { test } = require('node:test');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { setupKv } = require('./setup-kv.cjs');

const oldId = 'a'.repeat(32);
const standardId = 'b'.repeat(32);
const newId = 'c'.repeat(32);
const standardTitle = 'sublink-worker-SUBLINK_KV';
const legacyTitle = 'SUBLINK_KV';

function fixture(t, id = oldId) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'sublink-kv-'));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const configPath = path.join(directory, 'wrangler.toml');
  const original = `name = "sublink-worker"\nkv_namespaces = [\n  { binding = "SUBLINK_KV", id = "${id}" }\n]\n[assets]\ndirectory = "./public"\n`;
  fs.writeFileSync(configPath, original);
  return { configPath, original };
}

function runSetup(configPath, runWrangler) {
  return setupKv({ configPath, runWrangler, log: () => {} });
}

test('keeps the bound namespace when both legacy and standard namespaces exist', t => {
  const { configPath, original } = fixture(t);
  const calls = [];
  const result = runSetup(configPath, args => {
    calls.push(args);
    return JSON.stringify([
      { id: standardId, title: standardTitle },
      { id: oldId, title: legacyTitle }
    ]);
  });
  assert.equal(result.id, oldId);
  assert.equal(fs.readFileSync(configPath, 'utf8'), original);
  assert.deepEqual(calls, [['kv', 'namespace', 'list']]);
});

test('reuses a uniquely named legacy namespace when the checked-in id is stale', t => {
  const { configPath, original } = fixture(t);
  const result = runSetup(configPath, () => JSON.stringify([{ id: standardId, title: legacyTitle }]));
  assert.equal(result.id, standardId);
  assert.equal(fs.readFileSync(configPath, 'utf8'), original.replace(oldId, standardId));
});

test('creates only the explicit standard title and reads its id from a new list', t => {
  const { configPath, original } = fixture(t);
  const calls = [];
  const result = runSetup(configPath, args => {
    calls.push(args);
    if (args[2] === 'create') return 'Human-readable creation output changed.';
    return calls.length === 1 ? '[]' : JSON.stringify([{ id: newId, title: standardTitle }]);
  });
  assert.equal(result.id, newId);
  assert.deepEqual(calls, [
    ['kv', 'namespace', 'list'],
    ['kv', 'namespace', 'create', standardTitle, '--update-config=false'],
    ['kv', 'namespace', 'list']
  ]);
  assert.equal(fs.readFileSync(configPath, 'utf8'), original.replace(oldId, newId));
});

test('does not create or change bindings when the namespace query fails', t => {
  const { configPath, original } = fixture(t);
  let calls = 0;
  assert.throws(() => runSetup(configPath, () => {
    calls += 1;
    throw new Error('Not authorized');
  }), /Not authorized/);
  assert.equal(calls, 1);
  assert.equal(fs.readFileSync(configPath, 'utf8'), original);
});

for (const output of ['not JSON', '{}', '[{"id":"invalid","title":"SUBLINK_KV"}]']) {
  test(`rejects an invalid list without creating a namespace: ${output}`, t => {
    const { configPath, original } = fixture(t);
    let calls = 0;
    assert.throws(() => runSetup(configPath, () => { calls += 1; return output; }), /namespace list/);
    assert.equal(calls, 1);
    assert.equal(fs.readFileSync(configPath, 'utf8'), original);
  });
}

test('does not guess between namespaces when the configured id is missing', t => {
  const { configPath, original } = fixture(t);
  assert.throws(() => runSetup(configPath, () => JSON.stringify([
    { id: standardId, title: standardTitle },
    { id: newId, title: legacyTitle }
  ])), /Multiple existing KV namespaces/);
  assert.equal(fs.readFileSync(configPath, 'utf8'), original);
});

test('rejects unsupported binding syntax before contacting Cloudflare or appending TOML', t => {
  const { configPath } = fixture(t);
  const original = 'name = "sublink-worker"\n[assets]\ndirectory = "./public"\n';
  fs.writeFileSync(configPath, original);
  assert.throws(() => runSetup(configPath, () => { throw new Error('Must not be called'); }), /inline SUBLINK_KV/);
  assert.equal(fs.readFileSync(configPath, 'utf8'), original);
});
