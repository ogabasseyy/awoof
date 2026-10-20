import type { Metadata } from 'next';
import LegalDraftPage from '@/components/public/LegalDraftPage';
import { privacyDraft } from '@/content/public/legal-drafts';
import { privacyPolicyVersion } from '@/content/public/legal-types';

export const metadata: Metadata = {
  title: 'Privacy Policy | Awoof',
  description: 'How Awoof uses personal information, handles verification and supports your privacy rights.',
  metadataBase: new URL('https://awoof.tech'),
  alternates: { canonical: '/privacy' },
  robots: { index: true, follow: true },
};

export default function LegalPage() {
  return <LegalDraftPage title="Privacy Policy" intro="How Awoof uses personal information, handles verification and supports your privacy rights." versionLabel={privacyPolicyVersion} contextNote="This page shows version 1.2, which adds the optional academic profile disclosures. The archived version 1.1 notice is linked above." sections={privacyDraft} />;
}
