import type { Metadata } from 'next';
import LegalDraftPage from '@/components/public/LegalDraftPage';
import { cookiesDraft } from '@/content/public/legal-drafts';
import { cookiesPolicyVersion } from '@/content/public/legal-types';

export const metadata: Metadata = {
  title: 'Cookies and Browser Storage | Awoof',
  description: 'How Awoof uses browser storage and the controls available to you.',
  metadataBase: new URL('https://awoof.tech'),
  alternates: { canonical: '/cookies' },
  robots: { index: true, follow: true },
};

export default function LegalPage() {
  return <LegalDraftPage title="Cookies and Browser Storage" intro="How Awoof uses browser storage and the controls available to you." versionLabel={cookiesPolicyVersion} contextNote="This page shows version 1.1, which adds the academic-profile prompt-deferral storage disclosure. The archived version 1.0 notice is linked above." sections={cookiesDraft} />;
}
