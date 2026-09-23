import type { Metadata } from 'next';
import LegalDraftPage from '@/components/public/LegalDraftPage';
import { cookiesDraft } from '@/content/public/legal-drafts';

export const metadata: Metadata = {
  title: 'Cookies and Browser Storage | Awoof',
  description: 'How Awoof uses browser storage and the controls available to you.',
  alternates: { canonical: 'https://awoof.tech/cookies' },
  robots: { index: true, follow: true },
};

export default function LegalPage() {
  return <LegalDraftPage title="Cookies and Browser Storage" intro="How Awoof uses browser storage and the controls available to you." sections={cookiesDraft} />;
}
