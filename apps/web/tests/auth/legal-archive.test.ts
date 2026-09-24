import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { termsV1_0Archive } from '../../src/content/public/terms-v1-0-archive';
import { privacyV1_0Archive } from '../../src/content/public/privacy-v1-0-archive';

// Derived from termsDraft at approved release 889bb391b6a743ce397433e70e2a1eb6ccb2800c,
// with legalOperator/legalAddress resolved from that same release's legal-types.ts.
// Hash the complete ordered content, not TypeScript formatting. Never regenerate
// this baseline from the current archive: amendments require a new policy version.
const approvedV1Digest = '02a915dae17f488ff71758bf3d474d2856d9271170e9cc237afa08373f120003';

// Derived from privacyDraft at the same approved release, operator values
// resolved, same hashing and no-regeneration rules as above.
const approvedPrivacyV1Digest = '441cff7d3f872312a9c25c6d8f0281eed7888603954fd19ca4e1d34e909fc1fd';

test('complete archived Terms match the approved version 1.0 reading copy', () => {
  const actual = createHash('sha256').update(JSON.stringify(termsV1_0Archive)).digest('hex');
  assert.equal(actual, approvedV1Digest, 'An archived clause differs from the approved version 1.0 Terms');
});

test('complete archived privacy notice matches the approved version 1.0 reading copy', () => {
  const actual = createHash('sha256').update(JSON.stringify(privacyV1_0Archive)).digest('hex');
  assert.equal(actual, approvedPrivacyV1Digest, 'An archived clause differs from the approved version 1.0 notice');
});

test('version 1.0 terms archive snapshots operator values instead of shared constants', () => {
  const source = readFileSync(
    join(process.cwd(), 'src/content/public/terms-v1-0-archive.ts'),
    'utf8',
  );
  assert.equal(source.includes('Awoof Digital Services (registration number: 8449678)'), true);
  assert.equal(source.includes('2 Olaide Tomori Street, Ikeja, Lagos, Nigeria'), true);
  assert.equal(source.includes('legalOperator'), false);
  assert.equal(source.includes('legalAddress'), false);
  assert.match(source, /import type \{ LegalDraftSection \}/);
});

test('version 1.0 archive route uses the frozen label, not shared version constants', () => {
  const page = readFileSync(
    join(process.cwd(), 'src/app/terms/v1-0/page.tsx'),
    'utf8',
  );
  assert.equal(page.includes('termsV1_0VersionLabel'), true);
  assert.equal(page.includes('legalDraftVersion'), false);
  assert.equal(page.includes('studentPolicyVersion'), false);
});

test('version 1.0 privacy archive snapshots operator values instead of shared constants', () => {
  const source = readFileSync(
    join(process.cwd(), 'src/content/public/privacy-v1-0-archive.ts'),
    'utf8',
  );
  assert.equal(source.includes('Awoof Digital Services (registration number: 8449678)'), true);
  assert.equal(source.includes('2 Olaide Tomori Street, Ikeja, Lagos, Nigeria'), true);
  assert.equal(source.includes('legalOperator'), false);
  assert.equal(source.includes('legalAddress'), false);
  assert.match(source, /import type \{ LegalDraftSection \}/);
});

test('version 1.0 privacy archive route uses the frozen label, not shared version constants', () => {
  const page = readFileSync(
    join(process.cwd(), 'src/app/privacy/v1-0/page.tsx'),
    'utf8',
  );
  assert.equal(page.includes('privacyV1_0VersionLabel'), true);
  assert.equal(page.includes('legalDraftVersion'), false);
  assert.equal(page.includes('studentPolicyVersion'), false);
});
