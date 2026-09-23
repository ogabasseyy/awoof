import type { Metadata } from 'next';
import LegalDraftPage from '@/components/public/LegalDraftPage';
import { cookiesDraft } from '@/content/public/legal-drafts';

export const metadata: Metadata = {
  title: 'Cookies and Browser Storage Draft | Awoof',
  description: 'Counsel review draft of Awoof browser-storage information. Not effective.',
  robots: { index: false, follow: false },
};

export default function CookiesDraftPage() {
  return <LegalDraftPage title="Cookies and browser storage" intro="How browser storage supports account access and school sign-in, and the controls available to you." sections={cookiesDraft} />;
}
