import type { Metadata } from 'next';
import LegalDraftPage from '@/components/public/LegalDraftPage';
import { dataProtectionDraft } from '@/content/public/legal-drafts';

export const metadata: Metadata = {
  title: 'Partner Data-protection Schedule | Awoof',
  description: 'Data-sharing and processing responsibilities for separately agreed Awoof partner integrations.',
  metadataBase: new URL('https://awoof.tech'),
  alternates: { canonical: '/legal/data-protection' },
  robots: { index: true, follow: true },
};

export default function LegalPage() {
  return <LegalDraftPage title="Partner Data-protection Schedule" intro="Data-sharing and processing responsibilities for separately agreed Awoof partner integrations." sections={dataProtectionDraft} />;
}
