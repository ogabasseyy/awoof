export type TrustSection = {
  heading: string;
  paragraphs: string[];
  list?: string[];
};

export const trustIntro =
  'How Awoof handles verification evidence, what merchants learn, and where the limits are.';

export const trustSections: TrustSection[] = [
  {
    heading: 'Two checks, not one',
    paragraphs: [
      'A school mailbox check proves you can access a school email address. A current-enrollment check proves you are enrolled right now. They are different evidence, expire differently, and your status always says which one passed.',
      'A passed mailbox check never upgrades itself into enrollment proof. When enrollment evidence cannot be reached, that check stays pending instead of guessing.',
    ],
  },
  {
    heading: 'What merchants learn',
    paragraphs: [
      'Merchants never see your documents, your email, or your Awoof account. For each approved check they receive an eligibility answer: whether you are eligible, which check passed, which institution it came from, and when the answer expires.',
      'Answers use a pseudonym scoped to that merchant, so one merchant cannot track you across another. Each check needs your current, explicit approval for that merchant.',
    ],
    list: [
      'You approve a check inside your signed-in account.',
      'Awoof issues a short-lived code (minutes, not days) for that merchant only.',
      'The merchant server exchanges the code for the eligibility answer using its private server key.',
      'Private keys live on servers. They must never appear in a browser, an app bundle, or a URL.',
    ],
  },
  {
    heading: 'Consent and withdrawal',
    paragraphs: [
      'A check cannot run without your current approval for that merchant and purpose. Withdrawing consent stops all future checks for that merchant.',
      'Withdrawal does not rewrite history: receipts already issued stand as a record of a check that completed, not as new authorizations.',
    ],
  },
  {
    heading: 'When a check cannot complete',
    paragraphs: [
      'Evidence sources can be unreachable: a school system is down, a mailbox provider delays a code, or a record has expired. In every case the status stays pending or expired, visibly, with a next step — retry, re-verify, or ask for help.',
      'Awoof never invents a passing result to keep a flow moving. A missing check is shown as missing.',
    ],
  },
  {
    heading: 'Limits',
    paragraphs: [
      'This page describes the verification product as designed and shipped. Awoof does not claim security certifications, audits, or accreditations it has not earned, and does not promise integrations, response times, or enforcement behavior beyond what the current release supports.',
      'There is currently no public bug-bounty or guaranteed-timeline security process. If you find a security problem, report it through in-app support after signing in so it reaches the team with your account context.',
      'Privacy and terms documents ship only with owner-approved legal content. Until then, this trust center and the help pages are the public record — not a substitute policy.',
    ],
  },
];
