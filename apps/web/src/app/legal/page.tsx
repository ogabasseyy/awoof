import type { Metadata } from 'next';
import LegalDraftPage from '@/components/public/LegalDraftPage';
import { legalAddress, legalDocuments, legalOperator, type LegalDraftSection } from '@/content/public/legal-drafts';

export const metadata: Metadata = {
  title: 'Legal Review Pack — Drafts | Awoof',
  description: 'Awoof legal review package, proposed documents and decisions for counsel. Not effective.',
  robots: { index: false, follow: false },
};

const sections: readonly LegalDraftSection[] = [
  { id: 'scope', heading: 'Purpose and status of this package', paragraphs: [
    'These are original drafting proposals for review by Nigerian counsel and the business owner. They have not been executed or approved as effective policies. They are intended to make the legal and commercial choices concrete; they do not certify compliance or prove that a proposed operating procedure is already in place.',
    `${legalOperator}; owner-supplied address: ${legalAddress}; owner-confirmed contact: support@awoof.tech. The registration evidence describes a business name. Counsel must confirm the contracting proprietor or legal entity, correct registration designation and controller identity before release.`,
  ] },
  { id: 'documents', heading: 'Documents to read', paragraphs: [
    'Read the student terms and privacy notice together. The merchant terms need an order form and, where payments are involved, a payment schedule. The data-protection schedule needs a completed annex for each integration. The browser-storage notice supports the privacy notice.',
  ], links: legalDocuments },
  { id: 'choices', heading: 'Decisions requiring counsel and owner approval', paragraphs: [
    'The following choices are deliberately visible. They must not be treated as settled merely because proposed wording appears in a draft.',
  ], points: [
    'Confirm the actual contracting person/entity behind Awoof Digital Services and the exact registration identifier.',
    'Approve the lawful-basis map and any legitimate-interest assessment; confirm automated-decision safeguards and the rights-request procedure.',
    'Decide under-18 access and the necessary age/parental-consent process. No implemented age gate or NIN/BVN integration is represented by this package.',
    'Approve record-specific retention periods, deletion and backup procedures; verify recipients, processing locations and transfer safeguards.',
    'Confirm the seller, payee, collection authority, commission, settlement, reserves, chargebacks and refund responsibilities for each checkout model.',
    'Review the proposed paid-merchant cap of twelve months’ service fees, the higher cap for specified risks, the separate free-pilot cap and the exclusions. The student terms deliberately avoid an arbitrary financial cap.',
    'Review complaint handling, account closure, restriction challenges, material-change notices and the proposed business breach-remedy period against the team’s actual capacity.',
    'Approve Nigerian-law and court provisions, consumer notices, contract acceptance and evidence retention. There is no compulsory arbitration or blanket consumer rights waiver.',
  ] },
  { id: 'evidence', heading: 'What needs operational evidence before release', paragraphs: [
    'Source review supports account/school/enrollment separation, scoped merchant results, consent records, payment initiation and some limited cleanup rules. It does not establish production activation, approval from any university, a complete retention programme or an executed provider agreement.',
    'The release evidence must identify the deployed version, available institution methods, actual providers and locations, verified security controls, deletion tests, reachable support owner and records of legal acceptance. Noindex prevents indexing requests; it is not access control and does not make a deployed page private.',
  ] },
  { id: 'sources', heading: 'Research supporting the drafting approach', paragraphs: [
    'Nigerian legislation and regulator guidance inform the review. Competitor materials are structural comparisons only; their jurisdiction choices, retention periods, commercial promises and liability amounts have not been adopted as Nigerian legal requirements.',
  ], links: [
    { href: 'https://ndpc.gov.ng/wp-content/uploads/2024/03/Nigeria_Data_Protection_Act_2023.pdf', label: 'Nigeria Data Protection Act 2023' },
    { href: 'https://ndpc.gov.ng/wp-content/uploads/2025/07/NDP-ACT-GAID-2025-MARCH-20TH.pdf', label: 'NDPC General Application and Implementation Directive 2025' },
    { href: 'https://fccpc.gov.ng/wp-content/uploads/2022/07/FCCPA-2018.pdf', label: 'Federal Competition and Consumer Protection Act' },
    { href: 'https://www.myunidays.com/US/en-US/terms-of-service', label: 'UNiDAYS terms — structural comparison' },
    { href: 'https://www.studentbeans.com/en-us/us/accounts/info/privacy', label: 'Student Beans privacy — structural comparison' },
    { href: 'https://www.sheerid.com/vsa/', label: 'SheerID verification services agreement — structural comparison' },
    { href: 'https://www.sheerid.com/dpa/', label: 'SheerID data-processing addendum — structural comparison' },
  ] },
];

export default function LegalReviewPage() {
  return <LegalDraftPage title="Legal review pack" intro="A reading guide for counsel: five connected drafts, proposed commercial protections and the facts to confirm before approval." sections={sections} />;
}
