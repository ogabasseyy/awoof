import type { Metadata } from 'next';
import LegalDraftPage from '@/components/public/LegalDraftPage';
import { merchantDraft } from '@/content/public/legal-drafts';

export const metadata: Metadata = {
  title: 'Merchant Partnership Terms Draft | Awoof',
  description: 'Proposed Awoof merchant contract for legal review. Not effective or executed.',
  robots: { index: false, follow: false },
};

export default function MerchantTermsDraftPage() {
  return <LegalDraftPage title="Merchant partnership terms" intro="Proposed commercial terms for offers, verification integrations and payment arrangements, to accompany an agreed order form." sections={merchantDraft} />;
}
