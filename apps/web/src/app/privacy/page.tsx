import type { Metadata } from 'next';
import LegalDraftPage from '@/components/public/LegalDraftPage';
import { privacyDraft } from '@/content/public/legal-drafts';

export const metadata: Metadata = {
  title: 'Privacy Policy | Awoof',
  description: 'How Awoof uses personal information, handles verification and supports your privacy rights.',
  metadataBase: new URL('https://awoof.tech'),
  alternates: { canonical: '/privacy' },
  robots: { index: true, follow: true },
};

export default function LegalPage() {
  return <LegalDraftPage title="Privacy Policy" intro="How Awoof uses personal information, handles verification and supports your privacy rights." sections={privacyDraft} />;
}
