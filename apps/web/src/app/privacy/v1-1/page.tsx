import type { Metadata } from 'next';
import LegalDraftPage from '@/components/public/LegalDraftPage';
import { privacyV1_1Archive, privacyV1_1VersionLabel } from '@/content/public/legal-drafts';

export const metadata: Metadata = {
  title: 'Privacy Policy (Version 1.1) | Awoof',
  description: 'Archived privacy notice that applied before the optional academic profile disclosures.',
  metadataBase: new URL('https://awoof.tech'),
  alternates: { canonical: '/privacy/v1-1' },
  robots: { index: true, follow: true },
};

export default function LegalPage() {
  return <LegalDraftPage title="Privacy Policy (Version 1.1)" intro="Archived privacy notice that applied before the optional academic profile disclosures." versionLabel={privacyV1_1VersionLabel} contextNote="This is an archived copy. The current privacy notice is linked above." sections={privacyV1_1Archive} />;
}
