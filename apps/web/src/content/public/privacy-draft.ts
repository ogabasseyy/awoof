import { legalAddress, legalOperator, type LegalDraftSection } from './legal-types';

export const privacyDraft: readonly LegalDraftSection[] = [
  { id: 'operator', heading: 'Who we are and how to contact us', paragraphs: [
    `${legalOperator} operates Awoof from ${legalAddress}. References to “we”, “us” and “our” mean that operator. Contact support@awoof.tech about your information, including if you do not have an account or cannot sign in.`,
    'This notice covers visitors, students, merchant representatives and people contacting support. Awoof determines how information is used to operate its own accounts, verification records and marketplace. Schools, identity providers, merchants and payment providers also have responsibilities for their own processing. A separately agreed partner arrangement may give Awoof a narrower processing role for a particular service; the notice shown for that service will identify the responsible organization.',
  ] },
  { id: 'information', heading: 'What personal information we collect', paragraphs: [
    'The information involved depends on the features you use. Please give accurate details and only provide another person’s information if you are authorized to do so. Do not put passwords, payment-card security codes or unnecessary identity documents in support messages.',
  ], points: [
    'Account and profile: name, email, institution, student or registration number, contact details when supplied, account role, linked sign-in identities and account status. Password-based accounts use a stored password hash. Student registration records your self-declaration that you are 18 or older, the Terms of Service version accepted and the server-recorded time. We do not independently verify age through this declaration.',
    'Verification: school email, code challenges, identity information returned by an available school sign-in provider, enrollment evidence from an approved source where available, method, result, dates and expiry, and records needed to investigate an incorrect result.',
    'Consent and merchant checks: the choice made, purpose, merchant, time and policy version where recorded; withdrawal history; merchant-specific identifiers, eligibility results and receipts.',
    'Marketplace and payments: offer and order details, amounts, payment references, payment and refund status, and relevant seller or settlement records. Payment entry is handled through the payment flow; do not send card details to our support inbox.',
    'Merchant and support information: business details, authorized contacts, integration records, messages, attachments you choose to send and the actions taken on a request.',
    'Technical information: browser/session information and request, error and security records generated when the service is used.',
  ] },
  { id: 'sources', heading: 'Where we get your information', paragraphs: [
    'We receive information from you and from your use of Awoof. If you choose school sign-in, the provider returns information needed to identify that school account. If an institution connection is available, it may provide a current enrollment observation. Merchants and payment providers may return transaction or redemption information. The availability of an email domain does not by itself mean that the school has authorized an enrollment connection.',
  ] },
  { id: 'purposes', heading: 'Why we use information and our legal grounds', paragraphs: [
    'We use information for the purposes and on the legal grounds described below. Accepting our Terms or reading this notice is not, by itself, consent to optional processing. Where we ask for consent, the request describes the relevant activity and the effect of declining.',
  ], points: [
    'Account registration, authentication, requested support and transaction administration: information necessary to provide the service requested under our agreement with you, or to take steps at your request before that agreement.',
    'Optional school-account verification and a merchant-specific eligibility disclosure: the specific consent requested for that activity. A separate legal ground is required for any additional use of the result.',
    'Keeping systems secure, preventing impersonation and investigating misuse: legitimate interests in protecting users, merchants and Awoof, after assessing necessity and the impact on your rights. We do not treat this ground as permission for unrelated advertising or unlimited retention.',
    'Tax, accounting, regulatory requests and other compulsory records: compliance with an applicable legal obligation. Records needed for a particular legal claim may also be retained on an applicable legal ground.',
    'Promotional messages, if offered: a separate lawful marketing choice. Essential account or transaction messages are not a subscription to promotions; declining promotions does not itself prevent account use.',
  ] },
  { id: 'verification', heading: 'How verification and eligibility decisions work', paragraphs: [
    'An Awoof login establishes account access. A school-email code or Microsoft/Google school sign-in can establish control of that school account. Current enrollment is a separate question. An enrollment-only benefit requires current evidence accepted by the applicable institution policy; school-account control alone is insufficient.',
    'Software evaluates the evidence available, its validity and expiry, the applicable institution rules and the required consent. A missing or expired record, unavailable source or failed check can result in a pending or ineligible result and prevent a benefit from being authorized. It does not necessarily mean that you are not a student.',
    'Contact support@awoof.tech to challenge a result, explain your circumstances or request correction. Where the law gives you a right to human intervention in a decision made solely by automated means, you can request it through that address. Raising a request does not guarantee approval of a discount, and staff cannot supply enrollment evidence that an institution has not provided.',
  ] },
  { id: 'merchants', heading: 'What merchants receive', paragraphs: [
    'An authorized merchant check can return an eligibility result, a merchant-specific identifier, institution identifier, method and verification dates, expiry, and a campaign, receipt or benefit-authorization reference. The standard verification response does not include your school email, Awoof account ID or verification documents.',
    'That limited response is different from an order. If you buy something, the seller and payment provider may need additional information to take payment, fulfil the purchase or handle a complaint. A merchant also receives information you give it directly. Read its privacy notice for those activities.',
    'Withdrawing a merchant disclosure grant prevents future checks using that grant. It does not retract an earlier disclosure or erase the merchant’s lawful transaction records. Tell us if you believe a merchant has misused an Awoof result.',
  ] },
  { id: 'recipients', heading: 'Other organizations that may receive information', paragraphs: [
    'Service providers may handle information for hosting, database or file storage, delivery of account messages, payment processing and support. Microsoft or Google handles a school sign-in you choose; the school controls its own account and enrollment records. Availability varies by the service enabled for your institution.',
    'Information may also be disclosed to professional advisers, competent authorities or courts when justified by the relevant legal obligation or claim. A proposed transfer of the business would require consideration of the purpose, confidentiality and lawful basis for transferring user records. A business transaction is not permission to use your information for unrelated purposes.',
  ] },
  { id: 'transfers', heading: 'Processing outside Nigeria', paragraphs: [
    'Some providers may process information outside Nigeria. Such transfers require an applicable basis under Nigerian data-protection law, including appropriate protection or another legally available transfer condition. You may contact us for information about a particular recipient, location or transfer safeguard.',
    'Awoof does not represent that every service stores information exclusively in Nigeria. Any institution-specific location restriction must be assessed before that institution’s records are connected.',
  ] },
  { id: 'retention', heading: 'How long information is kept', paragraphs: [
    'Retention depends on the record’s purpose, whether the account or transaction remains active, an outstanding complaint or investigation, and a specific legal record-keeping requirement. A request to close an account is considered separately from records needed to settle a payment or handle a legal claim.',
  ], points: [
    'Account and linked identity records support access and account integrity while needed for those purposes; closure should trigger a review of continued retention rather than automatic indefinite storage. The registered Terms of Service acceptance (version and time, and an age declaration where recorded) is kept as the record of the agreement under which the account was provided, and may be retained after closure where needed to establish, exercise or defend a legal claim.',
    'Short-lived verification secrets are intended for the relevant verification attempt. Evidence, results and audit references may outlast the secret to explain a decision or investigate misuse.',
    'Consent and merchant receipts document the authorization and disclosure that occurred. A withdrawal is recorded alongside that history rather than rewriting it.',
    'Payment, refund, settlement and dispute records may need to remain after account closure to reconcile money and meet applicable accounting or legal requirements.',
    'Support, security and backup records require their own review and expiry arrangements. Information subject to a specific preservation obligation may be restricted and held until that obligation ends.',
  ] },
  { id: 'storage', heading: 'Cookies and browser storage', paragraphs: [
    'Awoof uses browser storage for sessions and temporary sign-in information, and cookies for certain school-account redirects. Blocking or clearing these can sign you out or interrupt a verification attempt. Our separate storage notice explains the purposes and available browser controls.',
  ], links: [{ href: '/cookies', label: 'Read the cookies and browser-storage notice' }] },
  { id: 'security', heading: 'How we protect information', paragraphs: [
    'Access controls, password hashing and checks on verification requests help protect the service. No website or transmission method can guarantee absolute security. Keep your credentials private, sign out on shared devices and report suspected unauthorized access through in-app support after signing in, so it reaches the team with your account context.',
    'Awoof remains responsible for its applicable security and breach-response obligations. Your use of the service does not waive rights relating to a security incident.',
  ] },
  { id: 'children', heading: 'Children and people requiring assistance', paragraphs: [
    'A school account does not establish a person’s age or capacity to consent. Where a child’s processing requires parental or guardian consent, that consent and an appropriate way to verify it must be in place. A parent or guardian concerned about information relating to a child can contact support@awoof.tech.',
    'Do not send NIN, BVN or other government-identifier records to our general inbox as an age check. Any additional identity check must be explained through an approved process before the information is collected.',
  ] },
  { id: 'choices', heading: 'Your rights and how to exercise them', paragraphs: [
    'Depending on the applicable legal conditions, you may ask for access and a copy, correction, erasure, restricted processing, portability, withdrawal of consent, or consideration of an objection. You may also challenge qualifying automated decisions. These rights can be subject to exceptions, including the protection of another person’s information or a lawful preservation obligation.',
    'People who cannot sign in can contact support@awoof.tech. Describe the request and the account or transaction concerned. We may ask for proportionate information to establish your identity or an authorized representative’s authority. We will explain if a request cannot be granted in full and respond within the applicable legal requirements.',
    'Available consent controls let signed-in students inspect and withdraw applicable grants. Withdrawal does not invalidate earlier lawful processing, but can make the relevant verification or benefit unavailable. Account closure and consent withdrawal are not interchangeable.',
  ] },
  { id: 'complaints', heading: 'Complaints and changes to this notice', paragraphs: [
    'Contact us if you think your information has been handled incorrectly. You can also complain to the Nigeria Data Protection Commission or seek another remedy available under applicable law; you do not have to give up those rights to use Awoof.',
    'An effective version of this notice will identify its date. Material changes to information use will be explained through an appropriate service or account notice, and new consent will be requested where required. A later notice cannot retrospectively authorize an incompatible use of information.',
  ], links: [{ href: 'https://ndpc.gov.ng/', label: 'Nigeria Data Protection Commission' }] },
];
