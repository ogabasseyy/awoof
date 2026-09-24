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
  return <LegalDraftPage title="Partner Data-protection Schedule" intro="Data-sharing and processing responsibilities for separately agreed Awoof partner integrations." contextNote="This schedule applies only when the parties incorporate its identified version into an agreement and complete the required processing annexes before personal data is exchanged." sections={dataProtectionDraft} />;
}
