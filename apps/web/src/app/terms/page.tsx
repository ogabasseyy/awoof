import type { Metadata } from 'next';
import LegalDraftPage from '@/components/public/LegalDraftPage';
import { termsDraft } from '@/content/public/legal-drafts';

export const metadata: Metadata = {
  title: 'Terms of Service | Awoof',
  description: 'Terms for Awoof student accounts, verification and marketplace use.',
  metadataBase: new URL('https://awoof.tech'),
  alternates: { canonical: '/terms' },
  robots: { index: true, follow: true },
};

export default function LegalPage() {
  return <LegalDraftPage title="Terms of Service" intro="Terms for Awoof student accounts, verification and marketplace use." sections={termsDraft} />;
}
