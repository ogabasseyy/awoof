import assert from 'node:assert/strict';
import { test } from 'node:test';
import { parseVendorStudentAnalytics } from '../../src/lib/vendor-analytics';

test('parses purchasing students from the renamed metric', () => {
  const parsed = parseVendorStudentAnalytics({ totalStudents: 11, purchasingStudents: 7, repeatCustomers: 3 });
  assert.deepEqual(parsed, { totalStudents: 11, purchasingStudents: 7, repeatCustomers: 3 });
});

test('falls back to the deprecated verifiedStudents alias on mixed-version responses', () => {
  const parsed = parseVendorStudentAnalytics({ totalStudents: 11, verifiedStudents: 7, repeatCustomers: 3 });
  assert.deepEqual(parsed, { totalStudents: 11, purchasingStudents: 7, repeatCustomers: 3 });
});

test('prefers purchasingStudents when both fields are present', () => {
  const parsed = parseVendorStudentAnalytics({
    totalStudents: 11, purchasingStudents: 7, verifiedStudents: 5, repeatCustomers: 3,
  });
  assert.equal(parsed?.purchasingStudents, 7);
});

test('rejects a missing purchasing count', () => {
  assert.equal(parseVendorStudentAnalytics({ totalStudents: 11, repeatCustomers: 3 }), null);
});

test('rejects non-integer counts', () => {
  assert.equal(parseVendorStudentAnalytics({ totalStudents: 11, purchasingStudents: 7.5, repeatCustomers: 3 }), null);
  assert.equal(parseVendorStudentAnalytics({ totalStudents: '11', purchasingStudents: 7, repeatCustomers: 3 }), null);
});

test('rejects non-record payloads', () => {
  assert.equal(parseVendorStudentAnalytics(null), null);
  assert.equal(parseVendorStudentAnalytics([]), null);
  assert.equal(parseVendorStudentAnalytics('purchasing'), null);
});

test('never treats the transaction-derived count as current verification', () => {
  const parsed = parseVendorStudentAnalytics({ totalStudents: 11, purchasingStudents: 7, repeatCustomers: 3 });
  assert.ok(parsed && !('verifiedStudents' in parsed));
});
