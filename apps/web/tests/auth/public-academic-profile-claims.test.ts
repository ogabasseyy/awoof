import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import { join } from 'node:path';
import { helpSections } from '../../src/content/public/help';
import { trustSections } from '../../src/content/public/trust';
import { developerSeparations } from '../../src/content/public/partners';

function academicHelpSection() {
  const section = helpSections.find((entry) => entry.heading === 'Optional academic details');
  assert.ok(section, 'Help must include an "Optional academic details" section');
  return section;
}

test('help states the exact optional-academic-details heading', () => {
  const headings = helpSections.map((entry) => entry.heading);
  assert.ok(headings.includes('Optional academic details'));
});

test('help states profile completion never verifies enrollment or changes eligibility', () => {
  const text = academicHelpSection().paragraphs.join('\n');
  assert.match(text, /never verifies your enrollment/);
  assert.match(text, /never changes your eligibility/);
});

test('help states merchants never receive academic answers', () => {
  const text = academicHelpSection().paragraphs.join('\n');
  assert.match(
    text,
    /Merchants never receive your course, entry year, entry route, or expected graduation year/,
  );
});

test('help states estimates appear only for reviewed rules and are otherwise unavailable', () => {
  const text = academicHelpSection().paragraphs.join('\n');
  assert.match(text, /only where a reviewed duration rule covers your exact programme and entry route/);
  assert.match(text, /no estimate is shown instead of a guess/);
});

test('academic help makes no verification, review, support, or benefit promise', () => {
  const text = academicHelpSection().paragraphs.join('\n');
  for (const forbidden of [
    'manual review',
    'supported school',
    'unlock',
    'instant verification',
    'proves enrollment',
    'confirms your enrollment',
    'verification complete',
  ]) {
    assert.equal(text.toLowerCase().includes(forbidden), false, `academic help must not claim: ${forbidden}`);
  }
});

test('help never offers a manual-review queue for academic details', () => {
  const text = helpSections.map((entry) => entry.paragraphs.join('\n')).join('\n');
  assert.equal(text.includes('Submit for manual review'), false);
});

test('trust states merchants never receive optional academic answers', () => {
  const section = trustSections.find((entry) => entry.heading === 'What merchants learn');
  assert.ok(section, 'Trust must keep the "What merchants learn" section');
  const text = section.paragraphs.join('\n');
  assert.match(text, /Eligibility answers never include your documents/);
  assert.match(
    text,
    /Merchants never receive optional academic answers such as course, entry year, entry route, or expected graduation year/,
  );
});

test('developer guide separates academic-profile routes from merchant integration', () => {
  assert.ok(
    developerSeparations.includes(
      'Academic answers are not merchant data. Optional course, entry, and graduation details never appear in receipts, and the student academic-profile routes are not a merchant integration surface.',
    ),
  );
});

test('merchant integration content exposes no academic field names', () => {
  const source = readFileSync(join(process.cwd(), 'src/content/public/partners.ts'), 'utf8');
  for (const field of [
    'courseLabel',
    'programmeId',
    'entryYear',
    'entryRoute',
    'expectedGraduationYear',
    'graduationYearOrigin',
    'estimateBasis',
    'claimedInstitution',
  ]) {
    assert.equal(source.includes(field), false, `partners content must not expose ${field}`);
  }
});

test('verification page links the optional profile with exact text and guidance', () => {
  const page = readFileSync(join(process.cwd(), 'src/app/student/verification/page.tsx'), 'utf8');
  assert.equal(page.includes('/student/profile/complete?redirect=%2Fstudent%2Fverification'), true);
  assert.equal(page.includes('Complete your student profile (optional)'), true);
  assert.equal(page.includes('Optional details never change your verification status.'), true);
});

test('profile hub links the optional profile with exact text', () => {
  const page = readFileSync(join(process.cwd(), 'src/app/student/profile/page.tsx'), 'utf8');
  assert.equal(page.includes('/student/profile/complete?redirect=%2Fstudent%2Fprofile'), true);
  assert.equal(page.includes('Complete your student profile'), true);
});
