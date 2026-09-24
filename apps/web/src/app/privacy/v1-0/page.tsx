import type { Metadata } from 'next';
import LegalDraftPage from '@/components/public/LegalDraftPage';
import { privacyV1_0Archive, privacyV1_0VersionLabel } from '@/content/public/legal-drafts';

export const metadata: Metadata = {
  title: 'Privacy Policy (Version 1.0) | Awoof',
  description: 'Archived privacy notice that applied before the age-declaration collection and retention updates.',
  metadataBase: new URL('https://awoof.tech'),
  alternates: { canonical: '/privacy/v1-0' },
  robots: { index: true, follow: true },
};

export default function LegalPage() {
  return <LegalDraftPage title="Privacy Policy (Version 1.0)" intro="Archived privacy notice that applied before the age-declaration collection and retention updates." versionLabel={privacyV1_0VersionLabel} contextNote="This is an archived copy. The current privacy notice is linked above." sections={privacyV1_0Archive} />;
}
