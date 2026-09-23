import type { Metadata } from 'next';
import LegalDraftPage from '@/components/public/LegalDraftPage';
import { termsDraft } from '@/content/public/legal-drafts';

export const metadata: Metadata = {
  title: 'Terms of Service Draft | Awoof',
  description: 'Working draft of Awoof terms, pending owner and legal review.',
  robots: { index: false, follow: false },
};

export default function TermsDraftPage() {
  return (
    <LegalDraftPage
      title="Terms of service"
      intro="A review draft for student accounts, verification, marketplace offers and merchant integrations."
      sections={termsDraft}
    />
  );
}
