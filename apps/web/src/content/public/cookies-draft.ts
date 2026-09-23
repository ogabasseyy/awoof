import { type LegalDraftSection } from './legal-types';

export const cookiesDraft: readonly LegalDraftSection[] = [
  { id: 'scope', heading: 'What this notice covers', paragraphs: [
    'This notice explains browser storage used by Awoof alongside the Privacy Notice. Cookies are small values a website asks your browser to store and send with relevant requests. Local and session storage are other browser mechanisms used by website code.',
  ] },
  { id: 'essential', heading: 'Account and sign-in storage', paragraphs: [
    'Account session storage helps keep you signed in and coordinate account changes between tabs. Local storage can persist after the browser closes until the application or you remove it. Ending or clearing a browser session is separate from deleting information held on Awoof’s servers.',
    'Temporary tab storage holds information needed to finish a school-account sign-in or verification attempt. Session storage is generally tied to the tab. The attempt also has a server-enforced expiry; possession of an old stored value is not permanent authorization.',
    'Short-lived callback cookies help associate an identity-provider redirect with the browser that started it. Their names may vary by attempt. They expire or are cleared as the flow completes, fails or is cancelled, depending on the flow.',
  ] },
  { id: 'optional', heading: 'Optional tracking and third-party services', paragraphs: [
    'If we introduce optional analytics or advertising storage, we will explain its purposes and provide any choice or consent mechanism required by law before enabling it. Accepting student terms does not authorize future tracking.',
    'A school sign-in or payment may take you to another provider’s website. That provider controls storage on its own site and publishes its own notice. Its role does not give Awoof access to your school password or make its cookies Awoof cookies.',
  ] },
  { id: 'controls', heading: 'Your browser controls', paragraphs: [
    'Your browser settings can block or clear cookies and website storage. Clearing storage may sign you out; blocking essential storage may prevent a sign-in or verification attempt from completing. Browser controls do not withdraw every server-side consent or erase earlier merchant disclosures. Use the applicable Awoof consent controls or contact support@awoof.tech for those requests.',
  ] },
  { id: 'contact', heading: 'Questions and updates', paragraphs: [
    'Contact support@awoof.tech for questions about browser storage or personal information. We will update this notice when the storage technologies or their purposes change.',
  ], links: [{ href: '/privacy', label: 'Read the privacy-notice draft' }] },
];
