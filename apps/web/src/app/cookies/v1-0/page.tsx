import type { Metadata } from 'next';
import LegalDraftPage from '@/components/public/LegalDraftPage';
import { cookiesV1_0Archive, cookiesV1_0VersionLabel } from '@/content/public/legal-drafts';

export const metadata: Metadata = {
  title: 'Cookies and Browser Storage (Version 1.0) | Awoof',
  description: 'Archived cookies and browser-storage notice that applied before the academic-profile prompt-deferral disclosure.',
  metadataBase: new URL('https://awoof.tech'),
  alternates: { canonical: '/cookies/v1-0' },
  robots: { index: true, follow: true },
};

export default function LegalPage() {
  return <LegalDraftPage title="Cookies and Browser Storage (Version 1.0)" intro="Archived browser-storage notice that applied before the academic-profile prompt-deferral disclosure." versionLabel={cookiesV1_0VersionLabel} contextNote="This is an archived copy. The current cookies notice is linked above." sections={cookiesV1_0Archive} />;
}
