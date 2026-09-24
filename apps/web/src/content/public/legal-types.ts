export type LegalDraftSection = {
  id: string;
  heading: string;
  paragraphs: readonly string[];
  points?: readonly string[];
  links?: readonly { href: string; label: string }[];
};

export const legalOperator = 'Awoof Digital Services (registration number: 8449678)';
export const legalAddress = '2 Olaide Tomori Street, Ikeja, Lagos, Nigeria';
export const legalDraftVersion = 'Version 1.0 · Effective 23 September 2026';
export const studentPolicyVersion = 'Version 1.1 · Effective 24 September 2026';

export const legalDocuments = [
  { href: '/privacy', label: 'Privacy notice' },
  { href: '/privacy/v1-0', label: 'Archived privacy notice (v1.0)' },
  { href: '/terms', label: 'Student and website terms' },
  { href: '/terms/v1-0', label: 'Archived student terms (v1.0)' },
  { href: '/cookies', label: 'Cookies and browser storage' },
  { href: '/legal/merchant-terms', label: 'Merchant partnership terms' },
  { href: '/legal/data-protection', label: 'Partner data-protection schedule' },
] as const;
