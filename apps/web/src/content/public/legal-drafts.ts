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
    heading: 'Who we are and how to reach us',
    paragraphs: [
      `${legalOperator} operates Awoof from 2 Olaide Tomori Street, Ikeja, Lagos, Nigeria. This notice is for people using Awoof as students or merchants, and for people who contact our support team.`,
      'You can ask us about your personal information at support@awoof.tech, including if you cannot sign in to your account.',
    ],
  },
  {
    id: 'information',
    heading: 'Information we collect',
    paragraphs: [
      'When you create or use an account, we handle details such as your name, email address, institution, student or registration number if supplied, contact details, account role and status. If you use an Awoof password, we store a protected password hash rather than the password itself.',
      'When you request verification, we handle the school email address, code-challenge records, sign-in identity returned by a school-account provider, verification method, result and expiry. Where an enrollment source is available, we also handle the evidence and decision needed to check current-student status. Microsoft or Google handles your school-account password; you do not enter it into Awoof.',
      'If you use offers, payments, merchant tools or support, we may handle offer activity, transaction and payment references, merchant integration records, consent choices and support messages. We also receive technical information needed to run and protect the service, such as session and request records.',
    ],
  },
  {
    id: 'sources',
    heading: 'Where information comes from',
    paragraphs: [
      'Some information comes from you. A school-account provider can return identity details after you choose its sign-in. A participating institution or another approved source may provide enrollment evidence where that connection is available. Merchants and payment providers may return the status of an offer, checkout or payment. We do not assume every school has an active connection to Awoof.',
    ],
  },
  {
    id: 'verification',
    heading: 'Verification is more than a school sign-in',
    paragraphs: [
      'Signing in to Awoof shows that you can access your Awoof account. Receiving a code at a school email address or signing in with Microsoft or Google can show control of that school account. Neither step, by itself, proves that you are currently enrolled.',
      'For a benefit that requires current enrollment, Awoof needs separate, current enrollment evidence from a configured source. If that evidence is unavailable, expired or withdrawn, an account should not be treated as eligible for that benefit. Available checks differ by institution and release.',
    ],
  },
  {
    id: 'purposes',
    heading: 'How we use information',
    paragraphs: [
      'We use information to set up and secure accounts, carry out the checks you request, record verification and consent choices, determine eligibility for applicable benefits, support marketplace and payment flows, respond to requests, and investigate misuse or service problems.',
      'We ask for a processing consent before certain verification actions and a separate merchant-specific disclosure grant before a merchant check. Other account, transaction and security records may be needed to provide the service or meet legal duties. Withdrawing a consent can stop future processing based on that consent, but may not undo a completed transaction or remove records we must keep for another lawful reason.',
    ],
  },
  {
    id: 'merchants',
    heading: 'Merchant disclosures',
    paragraphs: [
      'A merchant can request an Awoof eligibility result only through the applicable merchant-specific authorization flow. If you grant that request, Awoof may return whether you are eligible, a merchant-specific identifier, the verification method, institution identifier, verification and expiry times, and a receipt or benefit-authorization identifier. The standard result does not give the merchant your Awoof account ID, school email address or verification documents.',
      'A merchant may obtain other information directly from you at its own checkout. Its offer, checkout and privacy practices are separate from Awoof’s. If you withdraw a merchant disclosure grant, that stops future checks under the grant; it does not erase results or receipts already issued.',
    ],
  },
  {
    id: 'providers',
    heading: 'Who else handles information',
    paragraphs: [
      'Depending on the feature you use, school-account providers, participating institutions, email-delivery providers, hosting providers, payment processors and support-service providers may handle information needed for their part of the service. Awoof may also disclose information when required by law or to protect the service and its users, subject to applicable law.',
      'Some providers may process information outside Nigeria. Awoof does not promise that all information stays in Nigeria. Cross-border handling must follow applicable data-protection law; contact us if you want to ask where a particular service processes your information.',
    ],
  },
  {
    id: 'storage',
    heading: 'Cookies and account security',
    paragraphs: [
      'Awoof uses browser storage for account sessions and short-lived cookies during some sign-in and verification redirects. We use technical records to help maintain and protect those flows. Please protect your account and tell us at support@awoof.tech if you believe someone else has accessed it.',
    ],
  },
  {
    id: 'retention',
    heading: 'Retention and deletion',
    paragraphs: [
      'We keep different records for different reasons: operating an account, checking eligibility, recording consent, supporting a transaction, resolving a complaint, protecting the service or meeting a legal obligation. How long a record is kept depends on its purpose and any applicable record-keeping requirement.',
      'Unlinking a school account or withdrawing consent does not automatically delete earlier transaction, consent or merchant-receipt records. You may contact us to ask what we hold and to request deletion where the law permits.',
    ],
  },
  {
    id: 'choices',
    heading: 'Your choices and rights',
    paragraphs: [
      'Signed-in students can view their verification status and consent history and withdraw applicable grants. You may also ask about access, correction, deletion or other rights available under Nigerian data-protection law. We may need to check your identity before acting on a request so that we do not disclose or change someone else’s information.',
      'People who cannot sign in can contact support@awoof.tech. If you are dissatisfied with our response, you may raise a complaint with the Nigeria Data Protection Commission.',
    ],
  },
];

export const termsDraft: readonly LegalDraftSection[] = [
  {
    id: 'operator',
    heading: 'About Awoof and these terms',
    paragraphs: [
      `${legalOperator} operates Awoof from 2 Olaide Tomori Street, Ikeja, Lagos, Nigeria. Awoof provides student-account and verification features, a place to discover offers, and tools that let participating merchants check eligibility. These terms describe how to use those services.`,
      'Questions about these terms can be sent to support@awoof.tech.',
    ],
  },
  {
    id: 'accounts',
    heading: 'Your account and school sign-in',
    paragraphs: [
      'Give accurate information when you create or update an account, keep your sign-in credentials private and tell us if you suspect unauthorized access. Do not use someone else’s account or let someone else use yours to claim a student benefit. We may ask you to sign in or verify again when evidence expires or a security check requires it.',
      'If you choose Microsoft or Google school sign-in, that provider authenticates you. Awoof does not ask for your school-account password. Your school and its identity provider control whether that account is available and which information it can return.',
    ],
  },
  {
    id: 'eligibility',
    heading: 'Eligibility and offers',
    paragraphs: [
      'Awoof account access alone does not establish current enrollment. Control of a school email account is also different from proof of current enrollment. Where a benefit requires current-student status, you must have current enrollment evidence accepted for that benefit and make any required merchant-specific disclosure choice. If a check cannot establish eligibility, you cannot use that enrollment-only benefit through Awoof.',
      'Merchants set the terms of their own offers, including prices, availability, exclusions and redemption rules. Check the offer and checkout details before proceeding. Awoof verification does not guarantee that a merchant will complete a sale or honor an offer that has ended. A school email domain does not mean its institution has a live enrollment integration.',
    ],
  },
  {
    id: 'merchants',
    heading: 'Merchant integrations',
    paragraphs: [
      'If you operate a merchant integration, use the credentials and server-side exchange provided for your own organization and only for the approved purpose. Do not put private merchant keys in a public webpage, share them with another merchant or treat a copied code or public URL as proof of eligibility.',
      'You are responsible for the offers you publish, your own customer checkout, fulfillment and refund terms, and information you collect directly from customers. An Awoof eligibility result must be used only for its permitted purpose and duration.',
    ],
  },
  {
    id: 'payments',
    heading: 'Purchases, payments and refunds',
    paragraphs: [
      'Some offers send you to a merchant’s checkout; others may use a payment flow started through Awoof. Review the price, seller, payment method and applicable terms shown for the particular purchase before you pay. A payment processor may handle the payment, and its own terms may also apply.',
      'For a merchant-hosted checkout, ask the merchant about the order, delivery or refund under its stated terms. For a purchase started through Awoof, contact support@awoof.tech with the transaction reference if you need help identifying the responsible seller or resolving a payment issue. A successful eligibility check is not a completed purchase.',
    ],
  },
  {
    id: 'use',
    heading: 'Using Awoof responsibly',
    paragraphs: [
      'Do not make a false enrollment claim, use another person’s identity, share verification codes, interfere with security checks, probe accounts or systems without permission, or use Awoof to deceive a merchant or another student. Do not use merchant tools to collect or disclose student information beyond the approved check.',
      'We may restrict a feature or account while investigating misuse, a security risk or a legal requirement. If you believe a restriction is a mistake, contact support@awoof.tech so we can review it. Access to a particular offer may also end when its eligibility evidence or merchant authorization expires.',
    ],
  },
  {
    id: 'privacy',
    heading: 'Privacy and your choices',
    paragraphs: [
      'Our privacy notice explains what information Awoof handles and how to ask about it. A school-account sign-in and a merchant-specific disclosure are separate choices. Withdrawing a merchant disclosure grant stops future checks under that grant but cannot retract a result already sent or reverse a completed purchase.',
    ],
  },
  {
    id: 'changes',
    heading: 'Changes and contact',
    paragraphs: [
      'We may update these terms as the service changes. We will show the effective date of a new version and give notice of material changes through an appropriate account or service channel before they apply. If you do not agree to a future effective version, you should stop using the affected service and contact us about your account.',
      'Contact support@awoof.tech with questions about your account, an eligibility result or these terms. Your rights under applicable law are not removed by these terms.',
    ],
  },
];
