import { legalAddress, legalOperator, type LegalDraftSection } from './legal-types';

export const termsDraft: readonly LegalDraftSection[] = [
  { id: 'operator', heading: 'Who provides Awoof and when these terms apply', paragraphs: [
    `${legalOperator}, at ${legalAddress}, provides the Awoof website, student accounts, verification features and marketplace. “Awoof”, “we” and “us” refer to that operator. You can contact us at support@awoof.tech.`,
    'These student and website terms apply to the services made available to you. A merchant’s business use is governed by a separately accepted merchant agreement. Offer-specific conditions apply to the relevant purchase but cannot remove rights that the law protects.',
    'These terms apply when you accept them as part of registration or another service-agreement process. Publishing them does not retrospectively change an earlier agreement. The Privacy Notice explains information use; a request for consent, where needed, is a separate choice.',
  ] },
  { id: 'eligibility', heading: 'Who can use the service', paragraphs: [
    'You must have the legal capacity to enter the applicable agreement or, where Awoof makes such an arrangement available, use an approved process involving your parent or legal guardian as required by law. Do not misrepresent your age or identity. A school email address alone does not establish age or capacity.',
    'Access to a particular benefit may depend on current enrollment, the institution, location, age restrictions for that offer, and the merchant’s stated conditions. Registration does not promise access to every offer or verification method.',
  ] },
  { id: 'accounts', heading: 'Your account and school sign-in', paragraphs: [
    'Provide accurate information, keep it up to date and keep credentials and verification codes private. Do not create an account for another person without authority, transfer your account, or let another person use it to obtain a personal benefit. Tell us promptly if you suspect unauthorized access. We will assess disputed activity rather than treating every action using your credentials as conclusively authorized.',
    'School sign-in is handled by the available identity provider. Awoof does not ask you to enter your Microsoft or Google password into Awoof. Your school and provider control their own accounts and may restrict or withdraw access. Linking a school account does not transfer ownership of it to Awoof.',
  ] },
  { id: 'verification', heading: 'Verification, expiry and disputed results', paragraphs: [
    'Awoof account access alone does not establish current enrollment. A school-account check and an enrollment check answer different questions. An enrollment-only benefit requires valid current enrollment evidence under the applicable policy and the required merchant-specific authorization.',
    'A result reflects the source, method and time of the check. It can expire, be withdrawn or require a fresh check. We cannot guarantee that every institution provides a usable source, that an external provider will remain available or that submitted information will establish eligibility.',
    'A pending or unsuccessful result is not necessarily a finding that you are not a student. Contact support@awoof.tech to query a result or correct inaccurate information. No decision under these terms removes a right to challenge processing or request human intervention where applicable law provides it.',
  ] },
  { id: 'offers', heading: 'Offers, merchants and purchases', paragraphs: [
    'Merchants set the terms of their own offers, including price, availability, stock, eligible products, exclusions, redemption limits and expiry. Check these details before buying. A successful verification does not reserve stock, complete a purchase or guarantee future discounts.',
    'The seller identified for the purchase is responsible for its goods or services, product descriptions, delivery, warranties and the remedies it owes you. Merchant offers and external links do not mean that Awoof guarantees every product or endorses all content on another website.',
    'Awoof remains responsible for the services it supplies and obligations the law places on it. These terms do not disclaim those obligations merely because a merchant or payment provider is involved.',
  ] },
  { id: 'payments', heading: 'Payments, cancellations and refunds', paragraphs: [
    'For merchant-hosted checkout, the merchant handles the sale through its payment arrangements. For a checkout started through Awoof, Awoof can initiate payment and record its status, while the identified seller supplies the purchase. A separate payment provider processes the payment. Applicable charges must be shown before you confirm it.',
    'A payment pending confirmation should not be treated as either a successful purchase or a failed charge. Check its status and contact support with the reference before repeating an uncertain payment. We will help investigate transactions initiated through Awoof and direct order or delivery questions to the responsible seller.',
    'Cancellation, return and refund rights depend on the transaction and applicable law. A merchant’s policy cannot remove mandatory consumer remedies. A valid refund must be handled through the relevant payment arrangement; bank or provider processing time may affect when it appears. These terms do not create a blanket “no refunds” rule or a right to retain an erroneous payment.',
    'A dispute should include the order or payment reference and a description of what happened. Contact the merchant for its fulfilment obligations and in-app support after signing in for Awoof’s involvement, so the report reaches the team with your account context. You retain access to lawful bank, payment-provider, regulator and court remedies.',
  ] },
  { id: 'use', heading: 'Acceptable use and personal benefits', paragraphs: [
    'Use Awoof lawfully and within the access given to you. Do not impersonate another person, submit fabricated enrollment evidence, sell or redistribute personal verification results, automate abusive redemptions, bypass restrictions, disrupt systems, introduce malicious code or access another person’s information without authorization.',
    'Do not reproduce or commercially exploit restricted service data or use an Awoof result for an unrelated identity, credit, employment or other high-impact decision without a separate authorized service and legal basis. Reporting a suspected vulnerability does not itself authorize testing outside access you have been expressly given.',
  ] },
  { id: 'ownership', heading: 'Awoof content, branding and your submissions', paragraphs: [
    'Awoof and its licensors retain rights in the software, design, branding and materials they provide. You receive permission to use the service for its intended purpose while complying with these terms. You may not imply an official partnership, reproduce branding for endorsement or resell access without permission. Rights granted by law or an applicable open-source licence are preserved.',
    'You retain rights in information or materials you provide. You authorize the limited use needed to operate the feature you requested, respond to you and meet applicable legal obligations. This does not give Awoof ownership of your identity records or unrestricted rights to use them for publicity or unrelated marketing. Personal information is handled under the Privacy Notice and applicable law.',
  ] },
  { id: 'availability', heading: 'Availability and changes to the service', paragraphs: [
    'We aim to provide the service with reasonable care and skill. Maintenance, connectivity problems, security incidents and changes at schools, merchants or providers can interrupt a feature. No term promises uninterrupted service, permanent support for a particular school or a minimum value of savings.',
    'We may update or withdraw a feature for operational, security or legal reasons. Where reasonably practicable, we will explain a material change affecting an active service. This does not cancel accrued purchase, refund or statutory rights. A paid service, if introduced, requires its charges and material conditions to be presented before acceptance.',
  ] },
  { id: 'suspension', heading: 'Suspension, closure and what happens next', paragraphs: [
    'We may restrict access where reasonably necessary to address suspected misuse, unreliable eligibility evidence, a security risk or a legal requirement. We will give a reason and a way to query the decision when doing so is lawful and would not compromise another person or an investigation. Urgent protection may require a restriction before notice.',
    'You can request account closure at support@awoof.tech. Closure ends account access but does not automatically reverse purchases or delete every record. Outstanding transactions, lawful retention and the rights described in the Privacy Notice are handled separately. Contract provisions concerning accrued obligations, ownership, lawful record retention and disputes continue where their purpose requires it.',
  ] },
  { id: 'liability', heading: 'Our responsibility and limits on liability', paragraphs: [
    'Please read this section carefully: it describes the allocation of responsibility and must be considered alongside your statutory rights. Awoof is responsible for loss for which it is legally liable, including its own failure to supply the service with the care required by law.',
    'To the extent legally permitted, Awoof is not liable for loss caused solely by an independent merchant’s fulfilment failure, a school’s inaccurate source record or an external provider’s failure where Awoof did not cause or contribute to that loss and has met its own obligations. Awoof does not guarantee anticipated savings, business profits or a particular commercial outcome. Losses too remote to be recoverable under applicable law are not recoverable under these terms.',
    'Nothing excludes or limits liability that cannot lawfully be excluded or limited, including applicable consumer remedies, fraud, fraudulent misrepresentation, gross negligence, or rights arising under data-protection law. A limitation in a merchant agreement does not reduce a student’s statutory rights.',
  ] },
  { id: 'privacy', heading: 'Privacy and separate consent choices', paragraphs: [
    'Our Privacy Notice explains information use and your rights. A school-account sign-in, enrollment check and merchant disclosure may involve different choices. Withdrawal can stop future consent-based checks, but cannot recall information already lawfully disclosed or reverse a completed purchase. We do not make accepting all future data uses a condition of these terms.',
  ], links: [{ href: '/privacy', label: 'Read the privacy notice' }] },
  { id: 'disputes', heading: 'Complaints, governing law and disputes', paragraphs: [
    'Send a complaint to support@awoof.tech with enough information to identify the account, order or issue. We will consider it and seek a practical resolution. You can still approach the appropriate regulator, seek urgent relief or exercise any other mandatory right without first completing an exclusive Awoof process.',
    'These terms are governed by Nigerian law, subject to mandatory protections that apply to you. Disputes may be brought before a court of competent jurisdiction in Nigeria or another forum that applicable mandatory law permits. These terms do not impose compulsory private arbitration, waive collective rights or shorten a statutory period for bringing a claim.',
  ] },
  { id: 'changes', heading: 'Updates, notices and general provisions', paragraphs: [
    'We will identify the effective date of an approved version and give appropriate notice of material changes before they take effect, except where a change is immediately required by law or an urgent security need. New terms do not retrospectively alter a completed transaction. Where fresh acceptance is legally required, we will obtain it; a privacy-policy update does not replace a separate consent request.',
    'Notices may be sent through the account or the contact details you provide. If a provision cannot lawfully apply, the remaining provisions continue so far as they can operate fairly and legally. Failure to enforce a provision immediately is not a permanent waiver. A transfer of the business does not remove accrued rights or applicable data-protection obligations.',
  ] },
];
