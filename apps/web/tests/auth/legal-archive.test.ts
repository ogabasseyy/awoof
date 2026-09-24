import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import { join } from 'node:path';

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
