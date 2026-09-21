export const partnerIntro =
  'Offer student benefits with eligibility handled: students consent, Awoof verifies, and your business defines the benefit.';

export const merchantSteps = [
  {
    title: 'Create your business account',
    body: 'Register as a vendor and sign in to your dashboard. Your account holds your offers, your integration settings, and your reporting.',
  },
  {
    title: 'Configure integration and offers',
    body: 'Generate a private server key in vendor integration and keep it on your backend — never in a browser. List your offers and set their terms; you decide the benefit.',
  },
  {
    title: 'Students consent and verify',
    body: 'A signed-in student approves a check for your business and purpose. Awoof issues a short-lived code for your backend only.',
  },
  {
    title: 'Your server exchanges and applies the benefit',
    body: 'Exchange the code for an eligibility receipt with your server key, then apply your own benefit. The receipt says eligible, which check passed, and when it expires — nothing more.',
  },
  {
    title: 'Report on redemptions',
    body: 'Track orders and analytics from your dashboard. Receipts are history: replays return the committed receipt, never a fresh authorization.',
  },
];

export const universityBody = [
  'Universities help by making current-enrollment evidence reachable: a defined source, a named contact, and clear rules for what “enrolled now” means at that institution.',
  'A staff email address proves employment, not student enrollment, and is never treated as student proof. School-mailbox access and enrollment remain separate checks with separate answers.',
  'Awoof does not claim partnerships, integrations, or coverage it has not established. To start a conversation, create a business account and raise evidence needs through vendor support.',
];

export const developerIntro =
  'Integration concepts for the verification API that ships today: real route names, synthetic examples, and the separations that keep student data safe.';

export const developerExamples = [
  {
    title: '1. Student approves a check (student session)',
    route: 'POST /api/merchant-verification/assertions',
    body: 'Requires the student bearer token and an explicit disclosure grant for your vendor, origin, purpose, and campaign. Returns a short-lived opaque code — not an eligibility receipt.',
    request: [
      'POST /api/merchant-verification/assertions',
      'Authorization: Bearer <student JWT>',
      '',
      '{',
      '  "vendorId": "00000000-0000-4000-8000-000000000002",',
      '  "origin": "https://shop.example.test",',
      '  "purpose": "10% student discount",',
      '  "campaignId": "autumn-2026",',
      '  "disclosureGrantId": "10000000-0000-4000-8000-000000000001"',
      '}',
    ].join('\n'),
    response: [
      '201 Created',
      '',
      '{',
      '  "success": true,',
      '  "data": { "code": "CODE_FROM_STUDENT", "expiresAt": "2026-09-21T00:02:00Z" }',
      '}',
    ].join('\n'),
  },
  {
    title: '2. Merchant server exchanges the code (server key)',
    route: '/api/merchant-verification/exchange',
    body: 'Server-to-server only, with your private key. Include the campaign and an idempotency key. Applies no payment, pricing, or coupon rules — your backend applies the benefit.',
    request: [
      'POST /api/merchant-verification/exchange',
      'Authorization: Bearer YOUR_AWOOF_SERVER_KEY',
      '',
      '{',
      '  "code": "CODE_FROM_STUDENT",',
      '  "campaignId": "autumn-2026",',
      '  "idempotencyKey": "order-12345"',
      '}',
    ].join('\n'),
    response: [
      '200 OK',
      '',
      '{',
      '  "success": true,',
      '  "data": {',
      '    "receiptId": "30000000-0000-4000-8000-000000000001",',
      '    "merchantSubject": "pseudonym-scoped-to-your-business",',
      '    "eligible": true,',
      '    "assuranceMethod": "enrollment",',
      '    "institutionId": "10000000-0000-4000-8000-000000000001",',
      '    "verifiedAt": "2026-09-21T00:00:00Z",',
      '    "validUntil": "2026-09-28T00:00:00Z",',
      '    "campaignId": "autumn-2026"',
      '  }',
      '}',
    ].join('\n'),
  },
];

export const developerSeparations = [
  'Sign-in is not eligibility. A logged-in student with no passing check is not eligible.',
  'Server keys are not browser keys. Keys live on your backend; nothing secret goes in pages, apps, or URLs.',
  'Receipt history is not new authorization. Replays return the committed receipt; only a fresh approved check creates a new one.',
  'Errors are explicit: 401 invalid key or inactive merchant, 409 expired or conflicting code, 429 quota exhausted.',
];
