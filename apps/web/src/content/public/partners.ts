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
  'Integration concepts for the verification API now in integration: real route names, synthetic examples, and the separations that keep student data safe.';

export const developerExamples = [
  {
    title: '1. Student approves a check (student session)',
    route: 'POST /api/merchant-verification/assertions',
    body: 'Requires the student bearer token and an explicit disclosure grant for your vendor, origin, purpose, and campaign. Add "productId" to bind the code to one of your active products for a discounted transaction report. Returns a short-lived opaque code — not an eligibility receipt.',
    request: [
      'POST /api/merchant-verification/assertions',
      'Authorization: Bearer <student JWT>',
      '',
      '{',
      '  "vendorId": "00000000-0000-4000-8000-000000000002",',
      '  "origin": "https://shop.example.test",',
      '  "purpose": "10% student discount",',
      '  "campaignId": "autumn-2026",',
      '  "disclosureGrantId": "10000000-0000-4000-8000-000000000001",',
      '  "productId": "00000000-0000-4000-8000-000000000003"',
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
    body: 'Server-to-server only, with your private key. Include the campaign and an idempotency key. Applies no payment, pricing, or coupon rules — your backend applies the benefit. Product-bound codes also return a benefitAuthorizationId for one discounted transaction report. Codes from a protected product claim additionally require your browser nonce and merchant checkout binding.',
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
      '    "campaignId": "autumn-2026",',
      '    "benefitAuthorizationId": "40000000-0000-4000-8000-000000000001"',
      '  }',
      '}',
    ].join('\n'),
  },
  {
    title: '3. Merchant reports the discounted transaction (server key)',
    route: 'POST /api/vendors/transactions/report',
    body: 'Server-to-server only, with your vendor JWT or private key. Settles one discounted transaction against the benefit authorization from a product-bound exchange. First use rechecks current enrollment, the product binding, and the quoted price; legacy verification tokens are retired and always fail. Exact retries return the committed result; changed bindings conflict.',
    request: [
      'POST /api/vendors/transactions/report',
      'Authorization: Bearer [REDACTED]',
      '',
      '{',
      '  "benefitAuthorizationId": "40000000-0000-4000-8000-000000000001",',
      '  "paymentReference": "paystack_ref_123",',
      '  "amount": 15000,',
      '  "productId": "00000000-0000-4000-8000-000000000003",',
      '  "paymentGateway": "paystack"',
      '}',
    ].join('\n'),
    response: [
      '201 Created',
      '',
      '{',
      '  "success": true,',
      '  "data": {',
      '    "transactionId": "50000000-0000-4000-8000-000000000001",',
      '    "status": "completed",',
      '    "amount": 150,',
      '    "commission": 15,',
      '    "earnings": 135',
      '  }',
      '}',
    ].join('\n'),
  },
  {
    title: '4. Protected product claims bind one checkout (server key)',
    route: 'POST /api/merchant-verification/claim-sessions',
    body: 'For discounts redeemed on your site: set your own Secure HttpOnly browser nonce cookie, create a claim session server-to-server with its hash, then send the browser to the Awoof claim page. The student reviews and consents; Awoof hands your fixed /awoof/student-claim callback an opaque assertion only. Exchange it with your nonce and checkout binding — one redemption per checkout. A redeemed checkout ID stays permanently bound and must never be reused; an abandoned checkout becomes reusable after the 7-day retention window. Without this integration, protected claims answer 409 MERCHANT_INTEGRATION_REQUIRED and only ordinary navigation remains.',
    request: [
      'POST /api/merchant-verification/claim-sessions',
      'Authorization: Bearer [REDACTED]',
      '',
      '{',
      '  "productId": "00000000-0000-4000-8000-000000000003",',
      '  "merchantCheckoutId": "order-12345",',
      '  "browserNonceHash": "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef",',
      '  "origin": "https://shop.example.test"',
      '}',
    ].join('\n'),
    response: [
      '201 Created',
      '',
      '{',
      '  "success": true,',
      '  "data": { "claimSessionId": "60000000-0000-4000-8000-000000000001", "expiresAt": "2026-09-21T00:10:00Z" }',
      '}',
    ].join('\n'),
  },
];

export const developerSeparations = [
  'Sign-in is not eligibility. A logged-in student with no passing check is not eligible.',
  'Server keys are not browser keys. Keys live on your backend; nothing secret goes in pages, apps, or URLs.',
  'Receipt history is not new authorization. Replays return the committed receipt; only a fresh approved check creates a new one.',
  'Claim links are not redemptions. A shared handoff URL redeems nothing without your nonce-bound checkout session and a server-side exchange.',
  'Errors are explicit: 400 invalid input, 401 invalid key or inactive merchant, 403 check no longer current, 409 expired, conflicting, or unintegrated claim, 429 quota exhausted.',
];
