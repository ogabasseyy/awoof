import type { Metadata } from 'next';
import LegalDraftPage from '@/components/public/LegalDraftPage';
import { merchantDraft } from '@/content/public/legal-drafts';

export const metadata: Metadata = {
  title: 'Merchant Partnership Terms | Awoof',
  description: 'Business terms for Awoof merchant partnerships, applicable through a separately agreed order form.',
  metadataBase: new URL('https://awoof.tech'),
  alternates: { canonical: '/legal/merchant-terms' },
  robots: { index: true, follow: true },
};

export default function LegalPage() {
  return <LegalDraftPage title="Merchant Partnership Terms" intro="Business terms for Awoof merchant partnerships, applicable through a separately agreed order form." contextNote="These terms apply only through a separately accepted order form. The partner data-protection schedule and completed processing annexes govern personal-data matters before exchange." sections={merchantDraft} />;
}
