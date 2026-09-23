export type HelpSection = {
  heading: string;
  paragraphs: string[];
  list?: string[];
};

export const helpIntro =
  'Verification help that works without signing in: codes, schools, pending states, consent, and recovery.';

export const helpSections: HelpSection[] = [
  {
    heading: 'Codes and delivery',
    paragraphs: [
      'One-time codes go to the address you entered. If no code arrives within a few minutes, check spam and promotions folders, confirm the address for typos, and request a fresh code — older codes stop working once a new one is issued.',
      'Codes expire quickly by design. Enter the newest code you received; retrying an expired code will always fail.',
    ],
  },
  {
    heading: 'Your school is missing',
    paragraphs: [
      'Verification starts from a directory of supported institutions. If your school is not listed, its evidence is not currently reachable and there is no manual bypass that invents it.',
      'Double-check spelling and alternate campus names first. If the school is genuinely absent, ask for help through in-app support after signing in so the request carries your account context.',
    ],
  },
  {
    heading: 'Pending or expired status',
    paragraphs: [
      'Pending means a check started but its evidence has not arrived. Wait a little, confirm you completed every step, then retry. Expired means evidence that once passed no longer covers the present — re-verify to refresh it.',
      'Pending is never upgraded silently. If a status looks wrong after retrying, report it through in-app support with the approximate time it happened.',
    ],
  },
  {
    heading: 'Consent',
    paragraphs: [
      'Every merchant check needs your current approval for that merchant and purpose. You can withdraw approval at any time, which stops all future checks for that merchant.',
      'Withdrawal does not erase receipts from checks that already completed; those remain a history record, not ongoing permission.',
    ],
  },
  {
    heading: 'Account recovery',
    paragraphs: [
      'Password-reset codes go to the email address already on your account. If that school mailbox is gone, reset cannot reach you: verify a mailbox you control by registering again with your current school address.',
      'Receipts on the old account stay there as history. Account-specific help still needs a signed-in session so support can see your real state.',
    ],
  },
];
