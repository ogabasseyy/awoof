/**
 * Browser parser for the vendor analytics student counts. purchasingStudents
 * counts students with a completed order; it is never current student
 * verification. verifiedStudents is the deprecated server alias, accepted
 * only as a mixed-version fallback.
 */

export type VendorStudentAnalytics = {
  totalStudents: number;
  purchasingStudents: number;
  repeatCustomers: number;
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}

function isCount(value: unknown): value is number {
  return typeof value === 'number' && Number.isInteger(value) && value >= 0;
}

/** Strictly validate server student counts for display; null means unusable. */
export function parseVendorStudentAnalytics(value: unknown): VendorStudentAnalytics | null {
  if (!isRecord(value)) return null;
  const purchasing = isCount(value.purchasingStudents)
    ? value.purchasingStudents
    : isCount(value.verifiedStudents)
      ? value.verifiedStudents
      : null;
  if (!isCount(value.totalStudents) || purchasing === null || !isCount(value.repeatCustomers)) return null;
  return { totalStudents: value.totalStudents, purchasingStudents: purchasing, repeatCustomers: value.repeatCustomers };
}
