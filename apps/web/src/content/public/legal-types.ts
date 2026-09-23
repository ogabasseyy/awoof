export type LegalDraftSection = {
  id: string;
  heading: string;
  paragraphs: readonly string[];
  points?: readonly string[];
  links?: readonly { href: string; label: string }[];
};

export const legalOperator = 'Awoof Digital Services (registration number supplied: 8449678)';
export const legalAddress = '2 Olaide Tomori Street, Ikeja, Lagos, Nigeria';
export const legalDraftVersion = 'Counsel review draft · 23 September 2026 · No effective date';

export const legalDocuments = [
  { href: '/privacy', label: 'Privacy notice' },
  { href: '/terms', label: 'Student and website terms' },
  { href: '/cookies', label: 'Cookies and browser storage' },
  { href: '/legal/merchant-terms', label: 'Merchant partnership terms' },
  { href: '/legal/data-protection', label: 'Partner data-protection schedule' },
] as const;
