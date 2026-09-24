import type { Metadata } from 'next';
import LegalDraftPage from '@/components/public/LegalDraftPage';
import { termsV1_0Archive } from '@/content/public/legal-drafts';
import { legalDraftVersion } from '@/content/public/legal-types';

export const metadata: Metadata = {
  title: 'Terms of Service (Version 1.0) | Awoof',
  description: 'Archived student and website terms accepted by accounts created under version 1.0.',
  metadataBase: new URL('https://awoof.tech'),
  alternates: { canonical: '/terms/v1-0' },
  robots: { index: true, follow: true },
};

export default function LegalPage() {
  return <LegalDraftPage title="Terms of Service (Version 1.0)" intro="Archived student and website terms accepted by accounts created under version 1.0." versionLabel={legalDraftVersion} contextNote="This is an archived copy. New student accounts accept the current Terms of Service linked above." sections={termsV1_0Archive} />;
}
