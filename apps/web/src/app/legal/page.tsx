import type { Metadata } from 'next';
import LegalDraftPage from '@/components/public/LegalDraftPage';
import { legalDocuments, legalAddress, legalOperator } from '@/content/public/legal-drafts';

export const metadata: Metadata = {
  title: 'Legal Information | Awoof',
  description: 'Privacy, student terms, browser storage and partner agreements for Awoof.',
  alternates: { canonical: 'https://awoof.tech/legal' },
  robots: { index: true, follow: true },
};

export default function LegalPage() {
  return <LegalDraftPage title="Legal information" intro="Understand your rights and the terms that apply to Awoof services." sections={[
    { id: 'operator', heading: 'About Awoof', paragraphs: [
      `${legalOperator} operates Awoof from ${legalAddress}. Contact support@awoof.tech with questions about these documents or your personal information.`,
    ] },
    { id: 'documents', heading: 'Policies and agreements', paragraphs: [
      'Read the Privacy Notice for information use and your rights, the Student Terms for account and service conditions, and the Cookies Notice for browser storage.',
      'Merchant terms apply through a separately accepted order form. The data-protection schedule requires incorporation into a partner agreement and completed processing annexes before data is exchanged. Publication does not establish a partnership or authorize access to university records.',
    ], links: legalDocuments },
    { id: 'versions', heading: 'Versions and changes', paragraphs: [
      'Each document identifies its version and date. Publishing a new version does not retrospectively change an earlier contract or substitute for consent where required. Contact support@awoof.tech to request the version applicable to your agreement.',
    ] },
  ]} />;
}
