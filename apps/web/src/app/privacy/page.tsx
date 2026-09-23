import type { Metadata } from 'next';
import LegalDraftPage from '@/components/public/LegalDraftPage';
import { privacyDraft } from '@/content/public/legal-drafts';

export const metadata: Metadata = {
  title: 'Privacy Policy Draft | Awoof',
  description: 'Working draft of Awoof privacy information, pending owner and legal review.',
  robots: { index: false, follow: false },
};

export default function PrivacyDraftPage() {
  return (
    <LegalDraftPage
      title="Privacy policy"
      intro="A review draft explaining the information involved when Awoof signs students in, checks eligibility and connects them with merchants."
      sections={privacyDraft}
    />
  );
}
