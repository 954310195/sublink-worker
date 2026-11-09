#!/usr/bin/env node

const { execFileSync } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');

const KV_NAMESPACE_NAME = 'sublink-worker-SUBLINK_KV';
const SUPPORTED_TITLES = [
  KV_NAMESPACE_NAME,
  'sublink-worker-sublink-worker-SUBLINK_KV',
  'SUBLINK_KV'
];
const WRANGLER_CONFIG_PATH = path.join(__dirname, '..', 'wrangler.toml');
const WRANGLER_CLI_PATH = path.join(__dirname, '..', 'node_modules', 'wrangler', 'bin', 'wrangler.js');

function runWranglerCommand(args) {
  if (!fs.existsSync(WRANGLER_CLI_PATH)) {
    throw new Error('Local Wrangler is missing. Run npm ci before deploying.');
  }
  try {
    return execFileSync(process.execPath, [WRANGLER_CLI_PATH, ...args], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
      env: { ...process.env, WRANGLER_SEND_METRICS: 'false' }
    });
  } catch (error) {
    const details = String(error.stderr || '').trim() || String(error.stdout || '').trim() || error.message;
    throw new Error(`Wrangler ${args.join(' ')} failed: ${details}`);
  }
}

function readKvBinding(config) {
  const match = config.match(/\{[^{}]*\bbinding\s*=\s*"SUBLINK_KV"[^{}]*\}/);
  const id = match?.[0].match(/\bid\s*=\s*"([^"]*)"/);
  if (!match || !id) {
    // Appending after [assets] would put the binding in the wrong TOML table.
    throw new Error('Expected an inline SUBLINK_KV binding with an id in wrangler.toml.');
  }
  return { block: match[0], id: id[1], index: match.index };
}

function listNamespaces(runWrangler) {
  const output = runWrangler(['kv', 'namespace', 'list']);
  let namespaces;
  try {
    // The pinned Wrangler emits JSON on stdout; stderr must not enter this parser.
    namespaces = JSON.parse(output);
  } catch (_) {
    throw new Error('Wrangler returned an invalid KV namespace list; the existing binding was left unchanged.');
  }
  if (!Array.isArray(namespaces) || namespaces.some(namespace =>
    !namespace || typeof namespace.title !== 'string' || !/^[a-f0-9]{32}$/i.test(namespace.id)
  )) {
    throw new Error('Wrangler returned an unexpected KV namespace list; the existing binding was left unchanged.');
  }
  return namespaces;
}

function setupKv({ configPath = WRANGLER_CONFIG_PATH, runWrangler = runWranglerCommand, log = console.log } = {}) {
  const config = fs.readFileSync(configPath, 'utf8');
  const binding = readKvBinding(config);
  const namespaces = listNamespaces(runWrangler);

  // Keep the existing data binding even when a newer standard title also exists.
  let namespace = namespaces.find(item => item.id === binding.id);
  if (!namespace) {
    const compatible = namespaces.filter(item => SUPPORTED_TITLES.includes(item.title));
    if (compatible.length > 1) {
      throw new Error('Multiple existing KV namespaces match. Set the intended SUBLINK_KV id in wrangler.toml before deploying.');
    }
    namespace = compatible[0];
  }

  if (!namespace) {
    log(`Creating KV namespace: ${KV_NAMESPACE_NAME}`);
    runWrangler(['kv', 'namespace', 'create', KV_NAMESPACE_NAME, '--update-config=false']);
    // Listing again avoids depending on the CLI's human-readable create output.
    namespace = listNamespaces(runWrangler).find(item => item.title === KV_NAMESPACE_NAME);
    if (!namespace) {
      throw new Error('The new KV namespace was not found. Retry deployment after checking Cloudflare.');
    }
  }

  const block = binding.block.replace(/(\bid\s*=\s*")[^"]*(")/, `$1${namespace.id}$2`);
  const updated = config.slice(0, binding.index) + block + config.slice(binding.index + binding.block.length);
  if (updated !== config) {
    fs.writeFileSync(configPath, updated);
  }
  log(`Using KV namespace: ${namespace.title} (${namespace.id})`);
  return namespace;
}

if (require.main === module) {
  try {
    setupKv();
  } catch (error) {
    console.error(error.message);
    process.exitCode = 1;
  }
}

module.exports = { setupKv };
