import type { Metadata } from 'next';
import LegalDraftPage from '@/components/public/LegalDraftPage';
import { dataProtectionDraft } from '@/content/public/legal-drafts';

export const metadata: Metadata = {
  title: 'Partner Data-protection Schedule Draft | Awoof',
  description: 'Proposed partner data-sharing and processing schedule for legal review. Not executed.',
  robots: { index: false, follow: false },
};

export default function DataProtectionDraftPage() {
  return <LegalDraftPage title="Partner data-protection schedule" intro="Proposed responsibilities for merchants and institutions, with separate provisions for sharing between controllers and processing on instructions." sections={dataProtectionDraft} />;
}
