export type LegalDraftSection = {
  id: string;
  heading: string;
  paragraphs: readonly string[];
  points?: readonly string[];
};

export const legalOperator = 'Awoof Digital Services (RC 8449678)';

export const privacyDraft: readonly LegalDraftSection[] = [
  {
    id: 'operator',
    heading: 'Who operates Awoof',
    paragraphs: [
      `${legalOperator} operates the Awoof service from 2 Olaide Tomori Street, Ikeja, Lagos, Nigeria. This draft covers students, merchants and other people who use our website, accounts, verification and support features.`,
      'For privacy and legal requests, contact support@awoof.tech. Until the data-handling and retention review is complete, this draft is not an effective privacy policy.',
    ],
  },
  {
    id: 'information',
    heading: 'Information the service handles',
    paragraphs: [
      'Account and profile records can include your name, email address, institution, registration number or phone number when provided, role, account status and a password hash if you use a password. We do not ask for your school-account password when you sign in through Microsoft or Google.',
      'Verification features handle code challenges, school-mailbox evidence, linked provider identity information, institutional or enrollment observations when an approved source is available, verification status and expiry, and consent history. Marketplace, merchant, payment and support features can also create offer, transaction, payment-reference, integration and ticket records.',
      'The website uses browser storage for account sessions and short-lived cookies for sign-in or verification redirects. Technical request and diagnostic records help operate and protect those flows. A final policy needs an operational review of each category and provider.',
    ],
  },
  {
    id: 'verification',
    heading: 'Verification is more than a school sign-in',
    paragraphs: [
      'An Awoof account login establishes access to that account. A school email code or Microsoft/Google sign-in can establish control of a school account. Neither, on its own, establishes that a person is currently enrolled.',
      'Current-student eligibility requires separate, current enrollment evidence from a configured source. If that evidence is missing, unavailable, expired or revoked, the account must not be treated as eligible for an enrollment-only benefit. Which methods are available depends on the institution and the configured release.',
    ],
  },
  {
    id: 'purposes',
    heading: 'Why the service handles information',
    paragraphs: [
      'Awoof uses these records to create and secure accounts, perform requested verification checks, determine benefit eligibility, record consent, provide offers or transaction features, answer support requests, and detect misuse. The lawful basis for each processing purpose still needs owner and legal confirmation before publication.',
    ],
  },
  {
    id: 'merchants',
    heading: 'Merchant disclosures',
    paragraphs: [
      'A merchant verification check requires a grant scoped to that merchant and purpose. The server-side exchange can return an eligibility result, merchant-specific pseudonym, assurance method, institution identifier, verification and expiry times, campaign identifier, and receipt or benefit-authorization identifier. This is not the same as giving the merchant the student’s Awoof account ID, email address or verification documents.',
      'A merchant may separately receive information you give it directly during its own checkout. Merchants set their offers and operate their own checkout and privacy practices. Withdrawing an Awoof disclosure grant stops future checks; it does not erase a receipt already issued.',
    ],
  },
  {
    id: 'providers',
    heading: 'Schools, identity providers and service providers',
    paragraphs: [
      'When you choose an available school sign-in, Microsoft or Google authenticates that school account and returns limited identity information to Awoof. An approved institution integration may return separate enrollment evidence. Email delivery, hosting, payments and support infrastructure may process the information needed to perform their functions. The final policy needs a verified provider and transfer inventory; this draft does not assert where every provider stores data.',
    ],
  },
  {
    id: 'retention',
    heading: 'Retention and deletion',
    paragraphs: [
      'The code scrubs expired verification challenge payloads and digests after a bounded delay, while keeping non-secret tombstone identifiers needed by linked evidence. It also deletes Microsoft diagnostic events older than 30 days. Those narrow technical rules are not a complete retention schedule.',
      'Account, identity, consent, verification evidence, merchant receipts, transactions, payment references and support records may have different retention requirements. Their final periods, deletion process, backups and any legal holds need operational and legal confirmation before this page can become a policy. Do not assume that unlinking a school account or withdrawing consent deletes historical records.',
    ],
  },
  {
    id: 'choices',
    heading: 'Your choices and rights',
    paragraphs: [
      'Signed-in students can inspect verification status and consent history and withdraw applicable grants. Depending on the circumstances, you may also have rights to information, access, correction, deletion, objection and withdrawal of consent under applicable law, and to complain to the Nigeria Data Protection Commission.',
      'People who cannot sign in can contact support@awoof.tech about privacy requests. The final policy must explain how requests are authenticated and handled.',
    ],
  },
];

export const termsDraft: readonly LegalDraftSection[] = [
  {
    id: 'operator',
    heading: 'About the service',
    paragraphs: [
      `${legalOperator} operates Awoof from 2 Olaide Tomori Street, Ikeja, Lagos, Nigeria. These proposed terms describe student accounts, verification, the marketplace and merchant integrations. They are a review draft, not an agreement currently offered for acceptance.`,
      'Legal questions can be sent to support@awoof.tech. The effective date, governing-law and dispute provisions require review before these terms can be published.',
    ],
  },
  {
    id: 'accounts',
    heading: 'Accounts and school sign-in',
    paragraphs: [
      'A student may create an Awoof account using an available registration method. Keep account credentials private and provide accurate information. Awoof may require a new sign-in or verification when security, school policy or evidence expiry requires it.',
      'Microsoft or Google school sign-in authenticates with that provider. Awoof does not ask for the provider password. Schools and identity providers control their own accounts, permissions and availability.',
    ],
  },
  {
    id: 'eligibility',
    heading: 'Eligibility and offers',
    paragraphs: [
      'Awoof account access alone does not establish current enrollment. A school-account check and a current-enrollment check are distinct. An enrollment-only benefit requires valid enrollment evidence and any required merchant-specific consent at the time of the check.',
      'Merchants set the terms of their own offers, including availability, exclusions, prices and redemption rules. An Awoof verification result does not guarantee that a merchant will accept a purchase or provide a discount. Supported institutions and methods may change; a school email domain is not a promise of live integration.',
    ],
  },
  {
    id: 'merchants',
    heading: 'Merchant integrations',
    paragraphs: [
      'Participating merchants must use their own server-side credentials to exchange an authorized, short-lived verification code and apply the result to their checkout. A merchant is responsible for its offer, transaction terms and handling of information it collects directly from a customer.',
      'Awoof does not authorize placing private merchant keys in a browser or using a shared coupon or public URL as proof that a person is eligible.',
    ],
  },
  {
    id: 'use',
    heading: 'Responsible use',
    paragraphs: [
      'The proposed rules would prohibit false enrollment claims, use of another person’s account, sharing verification codes or merchant keys, attempts to bypass eligibility checks, and interference with the service. Exact enforcement, suspension, appeal and termination wording must be reviewed against the implemented account processes before these terms take effect.',
    ],
  },
  {
    id: 'payments',
    heading: 'Transactions and payments',
    paragraphs: [
      'Some offers may lead to a merchant checkout or a payment flow. The applicable price, fulfillment, refund and payment terms must be shown for the specific transaction. This draft does not assign responsibility for every transaction or promise that all advertised offers are immediately redeemable.',
    ],
  },
  {
    id: 'changes',
    heading: 'Changes and questions',
    paragraphs: [
      'Before these terms become effective, Awoof must approve the final wording, effective date, notice process and legal contact. Material updates should be identified to users through an approved notice process. For current product guidance, see the help and trust pages; neither replaces effective legal terms.',
    ],
  },
];
