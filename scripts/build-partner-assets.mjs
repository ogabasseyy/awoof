import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { closeSync, fstatSync, mkdirSync, mkdtempSync, openSync, readdirSync, readFileSync, rmSync, writeFileSync, constants as fsConstants } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { gzipSync } from 'node:zlib';

const repository = resolve(import.meta.dirname, '..');
export const partnerOperations = [
  ['/api/merchant-verification/assertions', 'post'],
  ['/api/merchant-verification/exchange', 'post'],
  ['/api/merchant-verification/claim-sessions', 'post'],
  ['/api/merchant-verification/claim-sessions/{id}', 'get'],
  ['/api/merchant-verification/product-claims', 'post'],
  ['/api/vendors/transactions/report', 'post'],
  ['/api/vendors/orders/{id}/status', 'put'],
];

/** Publish only the implemented merchant flow and its reachable definitions. */
export function merchantApiReference(fullSpec) {
  const paths = {};
  const components = {};
  const visited = new Set();
  function includeReference(reference) {
    if (!reference.startsWith('#/components/')) throw new Error(`Unsupported public API reference: ${reference}`);
    if (visited.has(reference)) return;
    visited.add(reference);
    const [, , category, name, ...extra] = reference.split('/');
    if (!category || !name || extra.length) throw new Error('Invalid component reference');
    const value = fullSpec.components?.[category]?.[name];
    if (!value) throw new Error(`Missing API component: ${category}/${name}`);
    components[category] ??= {};
    components[category][name] = structuredClone(value);
    inspect(value);
  }
  function inspect(value) {
    if (!value || typeof value !== 'object') return;
    if (typeof value.$ref === 'string') includeReference(value.$ref);
    if (Array.isArray(value.security)) {
      for (const requirement of value.security) {
        for (const scheme of Object.keys(requirement)) includeReference(`#/components/securitySchemes/${scheme}`);
      }
    }
    for (const item of Object.values(value)) inspect(item);
  }
  for (const [path, method] of partnerOperations) {
    const operation = fullSpec.paths?.[path]?.[method];
    if (!operation) throw new Error(`Merchant contract missing ${method.toUpperCase()} ${path}`);
    paths[path] ??= {};
    paths[path][method] = structuredClone(operation);
    inspect(operation);
  }
  rejectNullValues({ paths, components });
  return {
    openapi: fullSpec.openapi,
    info: {
      title: 'Awoof merchant integration API',
      version: fullSpec.info?.version ?? '1.0.0',
      description: 'Source contract for hosted student discount claims and merchant reporting. Private merchant keys stay on your server. Student-authenticated operations are performed by Awoof\'s hosted journey. Obtain the enabled API origin and test access during onboarding; this artifact does not establish production or provider activation.',
    },
    servers: [{
      url: '{apiBaseUrl}',
      variables: { apiBaseUrl: { default: 'http://127.0.0.1:5001', description: 'API origin supplied during onboarding, without a trailing /api. Default is local development only.' } },
    }],
    paths,
    components,
  };
}

/** Unquoted commas in YAML flow mappings split into null-valued keys; never publish that shape. */
function rejectNullValues(value, trail = 'contract') {
  if (value === null) throw new Error(`Published merchant contract has a null value at ${trail}; quote the source description`);
  if (!value || typeof value !== 'object') return;
  for (const [key, item] of Object.entries(value)) rejectNullValues(item, `${trail}.${key}`);
}

export function starterFiles(root) {
  const files = [];
  function collect(directory) {
    for (const entry of readdirSync(directory, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
      const path = join(directory, entry.name);
      if (entry.isSymbolicLink()) throw new Error('Starter downloads cannot contain symbolic links');
      if (['node_modules', 'dist', '.git', 'data', 'coverage', 'test-results'].includes(entry.name)) continue;
      if (entry.name.startsWith('.') && entry.name !== '.env.example' && entry.name !== '.gitignore') continue;
      if (entry.isDirectory()) { collect(path); continue; }
      if (!entry.isFile() || !/\.(?:mjs|js|ts|json|md)$/.test(entry.name) && entry.name !== '.env.example' && entry.name !== '.gitignore') continue;
      // Open once with O_NOFOLLOW and read through the descriptor: the file
      // cannot be swapped for a symlink between a path check and the read.
      let fd;
      try {
        fd = openSync(path, fsConstants.O_RDONLY | (fsConstants.O_NOFOLLOW ?? 0));
      } catch (error) {
        if (error?.code === 'ELOOP') throw new Error('Starter downloads cannot contain symbolic links');
        throw error;
      }
      try {
        if (!fstatSync(fd).isFile()) throw new Error('Starter downloads cannot contain symbolic links');
        // Keep the scanned bytes: the archive is written from this buffer, so
        // a file swapped or rewritten after the scan cannot enter the download.
        const content = readFileSync(fd);
        if (/(?:sk_(?:live|test)_[A-Za-z0-9]{16,}|awoof_[a-f0-9]{64}|BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY)/.test(content.toString('utf8'))) {
          throw new Error('Secret-shaped value in starter download; replace it with a placeholder');
        }
        files.push({ path: relative(root, path), content });
      } finally {
        closeSync(fd);
      }
    }
  }
  collect(join(root, 'packages/partner-sdk'));
  collect(join(root, 'examples/merchant-integration'));
  if (!files.some((file) => file.path === 'packages/partner-sdk/package.json') || !files.some((file) => file.path === 'examples/merchant-integration/package.json')) {
    throw new Error('Starter must include both self-contained package manifests');
  }
  return files;
}

/** Fixed UTC member timestamp for the public archive, as a Unix epoch. */
export const starterArchiveEpoch = Date.parse('2024-01-01T00:00:00.000Z') / 1000;

/** Build a reproducible public archive: numeric owner/group 0, a fixed member
 * timestamp, pinned ustar format and deterministic gzip metadata, so the
 * download carries no builder identity and identical sources share a checksum. */
function writeDeterministicArchive(root, files, archive) {
  const staging = mkdtempSync(join(tmpdir(), 'awoof-starter-'));
  try {
    // System tar cannot set member timestamps portably (bsdtar lacks
    // --mtime), so stage copies with a fixed timestamp instead of touching
    // the repository. Only listed files are staged; tar stores no directories.
    for (const { path: file, content } of files) {
      const destination = join(staging, file);
      mkdirSync(dirname(destination), { recursive: true });
      writeFileSync(destination, content);
    }
    execFileSync('touch', ['-t', '202401010000.00', ...files.map((file) => join(staging, file.path))],
      { stdio: 'pipe', env: { ...process.env, TZ: 'UTC' } });
    const plain = join(staging, 'merchant-starter.tar');
    const version = execFileSync('tar', ['--version'], { encoding: 'utf8' });
    // bsdtar and GNU tar spell ownership normalization differently; select by
    // implementation so the same sources build the same headers everywhere.
    const ownership = version.includes('bsdtar')
      ? ['--uid', '0', '--gid', '0', '--uname', '', '--gname', '']
      : ['--owner=0', '--group=0', '--numeric-owner'];
    // COPYFILE_DISABLE plus --no-xattrs keeps macOS tar from adding AppleDouble
    // ._* entries and extended attributes, which GNU tar lists as extra members.
    execFileSync('tar', ['--no-xattrs', '--format', 'ustar', ...ownership, '-cf', plain, '-C', staging, ...files.map((file) => file.path)],
      { stdio: 'pipe', env: { ...process.env, COPYFILE_DISABLE: '1' } });
    writeFileSync(archive, gzipSync(readFileSync(plain), { mtime: 0 }));
  } finally {
    rmSync(staging, { recursive: true, force: true });
  }
}

export function buildPartnerAssets(root = repository) {
  const output = join(root, 'apps/web/public/developers');
  const fullSpec = JSON.parse(readFileSync(join(root, 'apps/backend/dist/config/openapi.json'), 'utf8'));
  const contract = merchantApiReference(fullSpec);
  const serialized = `${JSON.stringify(contract, null, 2)}\n`;
  const files = starterFiles(root);
  mkdirSync(output, { recursive: true });
  writeFileSync(join(output, 'merchant-api.json'), serialized);
  const archive = join(output, 'merchant-starter.tar.gz');
  writeDeterministicArchive(root, files, archive);
  const sha256 = (value) => createHash('sha256').update(value).digest('hex');
  writeFileSync(join(output, 'integration-artifacts.json'), `${JSON.stringify({
    version: 1,
    deployment: 'not-verified-by-this-artifact',
    enrollmentAuthority: 'approved-current-enrollment-source-required',
    files: [
      { path: '/developers/merchant-api.json', sha256: sha256(serialized) },
      { path: '/developers/merchant-starter.tar.gz', sha256: sha256(readFileSync(archive)) },
    ],
    prospectiveConnections: {
      googleEntitlements: 'provider-contract-required',
      verveCashback: 'qualification-funding-settlement-reversal-contract-required',
      paystackMerchantPayments: 'merchant-account-configuration-and-runtime-validation-required',
    },
  }, null, 2)}\n`);
  process.stdout.write(`Built merchant API (${Object.keys(contract.paths).length} paths) and starter (${files.length} files).\n`);
}

export function checkPartnerAssets(root = repository) {
  const output = join(root, 'apps/web/public/developers');
  const sourceContract = merchantApiReference(JSON.parse(readFileSync(join(root, 'apps/backend/dist/config/openapi.json'), 'utf8')));
  const publishedContract = readFileSync(join(output, 'merchant-api.json'), 'utf8');
  if (publishedContract !== `${JSON.stringify(sourceContract, null, 2)}\n`) throw new Error('Published merchant API is stale: run npm run docs:partner');
  const expectedFiles = starterFiles(root).map((file) => file.path).sort();
  const archive = join(output, 'merchant-starter.tar.gz');
  const archivedFiles = execFileSync('tar', ['-tzf', archive], { encoding: 'utf8' }).trim().split('\n').sort();
  if (JSON.stringify(archivedFiles) !== JSON.stringify(expectedFiles)) throw new Error('Published starter file list is stale');
  for (const path of expectedFiles) {
    const bundled = execFileSync('tar', ['-xOf', archive, path]);
    if (!bundled.equals(readFileSync(join(root, path)))) throw new Error(`Published starter is stale: ${path}`);
  }
  const manifest = JSON.parse(readFileSync(join(output, 'integration-artifacts.json'), 'utf8'));
  const publishedFiles = ['merchant-api.json', 'merchant-starter.tar.gz'];
  if (manifest.files?.length !== publishedFiles.length) throw new Error('Unexpected integration artifact manifest');
  for (const name of publishedFiles) {
    const sha256 = createHash('sha256').update(readFileSync(join(output, name))).digest('hex');
    if (!manifest.files.some(file => file.path === `/developers/${name}` && file.sha256 === sha256)) throw new Error('Integration artifact checksum mismatch');
  }
  process.stdout.write('Published merchant contract and starter match their source.\n');
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  if (process.argv.includes('--check')) checkPartnerAssets(); else buildPartnerAssets();
}
