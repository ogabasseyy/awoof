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
  'Build a checkout-bound student benefit with hosted consent, a merchant backend and transaction reporting. This guide describes source contracts; deployment and merchant/provider activation require separate validation.';

export const developerExamples = [
  {
    title: 'Advanced: assertion issuance inside the student journey',
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
      '  "campaignId": "order-12345",',
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
    title: '2. Exchange from the merchant callback',
    route: '/api/merchant-verification/exchange',
    body: 'Server-to-server only, with your private key. Include the campaign and an idempotency key. Applies no payment, pricing, or coupon rules — your backend applies the benefit. Product-bound codes also return a benefitAuthorizationId for one discounted transaction report. Codes from a protected product claim additionally require your browser nonce and merchant checkout binding.',
    request: [
      'POST /api/merchant-verification/exchange',
      'Authorization: Bearer YOUR_AWOOF_SERVER_KEY',
      '',
      '{',
      '  "code": "CODE_FROM_STUDENT",',
      '  "campaignId": "order-12345",',
      '  "idempotencyKey": "exchange-order-12345",',
      '  "browserNonce": "NONCE_FROM_HTTPONLY_COOKIE",',
      '  "merchantCheckoutId": "order-12345"',
      '}',
    ].join('\n'),
    response: [
      '200 OK',
      '',
      '{',
      '  "success": true,',
      '  "data": {',
      '    "receiptId": "30000000-0000-4000-8000-000000000001",',
      '    "merchantSubject": "20000000-0000-4000-8000-000000000001",',
      '    "eligible": true,',
      '    "assuranceMethod": "enrollment",',
      '    "institutionId": "10000000-0000-4000-8000-000000000001",',
      '    "verifiedAt": "2026-09-21T00:00:00Z",',
      '    "validUntil": "2026-09-28T00:00:00Z",',
      '    "campaignId": "order-12345",',
      '    "benefitAuthorizationId": "40000000-0000-4000-8000-000000000001",',
      '    "benefitValidUntil": "2026-09-21T00:02:00Z"',
      '  }',
      '}',
    ].join('\n'),
  },
  {
    title: '3. Confirm payment and report the transaction',
    route: 'POST /api/vendors/transactions/report',
    body: 'Server-to-server only, with your vendor JWT or private key. Request amount is integer NGN kobo (15000 = ₦150); response amount, commission and earnings are NGN major units. paystack_merchant requires a separately configured merchant-account secret on Awoof and verified payment metadata. Settles one discounted transaction against the benefit authorization from a product-bound exchange. First use rechecks current enrollment, the product binding, and the quoted price; legacy verification tokens are retired and always fail. Exact retries return the committed result; changed bindings conflict.',
    request: [
      'POST /api/vendors/transactions/report',
      'Authorization: Bearer [REDACTED]',
      '',
      '{',
      '  "benefitAuthorizationId": "40000000-0000-4000-8000-000000000001",',
      '  "paymentReference": "paystack_ref_123",',
      '  "amount": 15000,',
      '  "productId": "00000000-0000-4000-8000-000000000003",',
      '  "paymentGateway": "paystack_merchant"',
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
    title: '1. Create a protected claim session',
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
  'Student sign-in and recovery routes are not a merchant integration surface. They are not documented here as a public partner API while provider rollout remains disabled and unvalidated.',
  'Server keys are not browser keys. Keys live on your backend; nothing secret goes in pages, apps, or URLs.',
  'Receipt history is not new authorization. Replays return the committed receipt; only a fresh approved check creates a new one.',
  'Claim links are not redemptions. A shared handoff URL redeems nothing without your nonce-bound checkout session and a server-side exchange.',
  'Errors are explicit: 400 invalid input, 401 invalid key or inactive merchant, 403 check no longer current, 409 expired, conflicting, or unintegrated claim, 429 quota exhausted.',
];


export const developerGuideSections = [
  {
    id: 'setup', title: 'Before you start',
    paragraphs: [
      'Register a vendor account and keep the Awoof Platform payment method (Vendor Website selection is unavailable while merchant verification is being replaced). Generate the private reporting/server key in API Configuration. The key is displayed once; save it in server environment configuration. Rotating it revokes the previous key. A browser/widget key is a different credential and cannot authenticate these server calls.',
      'Create an active offer under Manage Deals and map its Awoof product UUID to one SKU and the advertised list/student prices in your own order database. Record your vendor UUID, product UUID, benefit terms and approved sharing purpose. A receipt alone does not set your price: your checkout must enforce the configured student quote.',
      'In vendor integration, save allowed HTTPS hostnames under Checkout origins. This authorizes exact HTTPS origins at port 443. An origin includes scheme, host and any port; subdomains are different origins. For nonstandard development ports, arrange exact development-origin configuration with the operator; the dashboard does not configure arbitrary ports. Product redirect configuration must point to an approved merchant destination.',
      'Use the operator-provided Awoof API base and hosted web base for the same environment. API examples use paths beginning /api; never append /api twice. The SDK and reference merchant live in packages/partner-sdk and examples/merchant-integration in the repository. Start with their README and synthetic local mode before configuring a real backend.',
    ],
  },
  {
    id: 'hosted-checkout', title: 'Hosted checkout and the fixed callback',
    paragraphs: [
      'Your server creates a new unpredictable nonce (for example, Node randomBytes(32).toString("base64url")), stores it with a unique merchantCheckoutId in the merchant session, and sets a Secure; HttpOnly; SameSite=Lax cookie scoped to your merchant origin. Bind it to the initiating browser and trusted order; do not trust checkout IDs supplied by the callback query. Hash the raw nonce with SHA-256 into 64 lowercase hexadecimal characters for browserNonceHash. Keep the raw nonce on your server/cookie, never in the hosted URL.',
      'Create the claim session with your private key, mapped productId, checkout ID, nonce hash and exact registered origin. Preserve these inputs across an ambiguous timeout instead of creating another checkout. Redirect the browser to AWOOF_WEB_BASE/marketplace/{productId}?claimSession={claimSessionId}. Use the returned session ID and encode URL components. The claim session lasts 10 minutes.',
      'The Awoof page handles student login, review and explicit merchant disclosure consent. Students without passing current enrollment evidence cannot claim the protected benefit. The merchant server does not collect or exchange a student JWT. The advanced assertion endpoint below belongs to the authenticated student journey, not your merchant backend.',
      'The browser returns to YOUR_REGISTERED_ORIGIN/awoof/student-claim?assertion={code}. This fixed callback is derived from the saved origin, not a merchant-supplied return URL. The opaque assertion lasts 2 minutes. Read its single assertion query value, recover your own nonce/order session, and exchange server-to-server with campaignId exactly equal to merchantCheckoutId, the raw browserNonce, that same merchantCheckoutId and a stable exchange idempotencyKey.',
      'Check the eligible receipt and persist receiptId and benefitAuthorizationId against the trusted checkout before redirecting to a clean merchant URL. Never log assertion queries, cookies, keys or handoff URLs; set Cache-Control: no-store and Referrer-Policy: no-referrer on the callback. Missing or mismatched cookies fail closed. Never reuse a redeemed checkout ID; abandoned sessions may become reusable after the 7-day retention window, but a fresh unique order ID is simpler.',
    ],
  },
  {
    id: 'payment', title: 'Payment modes and amount units',
    paragraphs: [
      'Use paystack_merchant for an independent merchant Paystack account only after the operator configures the server-only merchant-ID-to-secret mapping for the intended test/live environment. Awoof never receives that secret through the browser or transaction-report payload. Initialize the merchant payment on your server with metadata awoofVendorId, awoofProductId and awoofBenefitAuthorizationId matching this checkout. The configured verifier checks successful status, NGN currency, exact kobo amount and all three bindings; missing configuration or a mismatch rejects settlement.',
      'The existing paystack mode verifies through the Awoof platform account. A subaccount code or Vendor Website setting does not configure independent merchant-account verification. Use other only for merchant-attested reporting after your own server confirms payment; Awoof does not independently verify that provider. None of these modes proves enrollment or funds cashback.',
      'Report amount as integer minor NGN units: ₦150 is 15000 kobo. Claim-session advertised prices and report response amount/commission/earnings are major NGN units. Snapshot the expected student quote and initialize/report that exact amount, not the original list price or a browser-supplied total. A successful report records one benefit transaction; it does not charge the card, apply the discount in your cart or promise payout.',
      'A product-bound exchange returns benefitValidUntil: the actual payment-report authorization deadline, at most two minutes from exchange and bounded by enrollment evidence expiry. It is separate from validUntil, which describes enrollment evidence. Persist both. Do not start a fresh payment after the benefit deadline; missing deadline information must not be replaced with the longer evidence expiry. First reporting must still pass current authority and expiry checks. Already initiated or paid orders need reconciliation if the deadline lapses; an old receipt or a repeated report does not extend authorization.',
      'The runnable reference supports independent merchant Paystack test initialization and cookie-bound return verification. Enter the payment email on the merchant checkout; it is sent to Paystack, not obtained from Awoof. The example accepts only test credentials and verifies test-domain payments before reporting. Provider UI, account configuration and test approval remain separate from the local synthetic walkthrough.',
    ],
  },
  {
    id: 'operations', title: 'Retries, reconciliation and reversals',
    paragraphs: [
      'Persist claim-session inputs, exchange idempotencyKey, assertion result, authorization, product, payment reference, amount and gateway in your order record. Retry a timed-out exchange with exactly the same inputs/key. An exact report retry returns the committed transaction; a changed reference, amount, product or payment-source category (platform Paystack, merchant Paystack or merchant-attested) conflicts. Arbitrary labels within the merchant-attested category normalize to the same source; preserve the original label in your own order record. Receipt history does not issue a fresh benefit after expiry or consent withdrawal. First settlement still checks current enrollment and the quoted price. Exact historical retries still require a currently valid reporting key, even if payment credentials were later removed.',
      'Return the browser to an order-status page after payment. Browser redirects and supplied payment references are not evidence of success. Receive payment events on your own backend, authenticate the raw payload using your selected provider contract, deduplicate durable event/order records, and confirm the reference, account, environment, amount and currency against the trusted order. For Paystack use its documented raw-body HMAC SHA-512 signature check and transaction verification.',
      'After confirmed payment, enqueue the Awoof report durably and retry transient failures with the original payload. Reconcile unresolved orders against provider verification and the report response; keep failed or ambiguous orders pending for investigation. Awoof enrollment expiry can reject a first report even after payment, so define your merchant resolution process before launch rather than silently granting a new authorization.',
      'Handle refunds, disputes and late/out-of-order provider events in your merchant order ledger. After confirming the actual provider refund, use vendor dashboard order status or PUT /api/vendors/orders/:id/status with status refunded to update a completed external-payment order. This bookkeeping route requires the signed-in vendor JWT, not the private reporting key. It reverses the recorded student savings and restores consumed stock; it does not request a PSP refund. Repeating a transaction report does not reverse it. Use vendor support and agreed reconciliation for unrecorded or legacy cases. Do not assume automatic provider reversal, settlement or card-network cashback.',
    ],
  },
  {
    id: 'release', title: 'Test and launch checklist',
    paragraphs: [
      'The reference merchant includes a disposable local synthetic simulator. Its eligibility and payment fixtures are not institutional evidence, a production sandbox, provider approval or a live payment. Run its test command, complete eligible/ineligible/expired cases, then exercise your real backend with approved test data and the separately configured provider test account.',
      'Before launch, test missing/changed nonce, wrong checkout/campaign/product, expired assertion, rejected enrollment, consent withdrawal, duplicate callbacks, timeout retries, changed report payload, missing merchant PSP configuration and wrong metadata/currency/amount. Verify the cart applies the student quote once and reports/reconciles exactly once. Test refund/dispute operations separately.',
      'Source code, passing local tests, deployed routes, institution authority and merchant/provider activation are different milestones. Live use needs an approved enrollment authority, accepted merchant terms and completed data-sharing annexes, configured origins/products/keys, deployment validation, real-provider test evidence and an operational owner. This page claims no Google, Verve or Paystack partnership or active sponsored offer.',
    ],
  },
];

export const partnerConnections = [
  { title: 'Directory or code/link offer', body: 'Use an approved public destination or merchant-owned code/link fulfillment. Listing an offer does not establish entitlement, enrollment authority or completed redemption. The merchant owns benefit terms and checkout enforcement.' },
  { title: 'Native Awoof Verify', body: 'Use hosted consent, checkout-bound exchange and merchant transaction reporting. Approved current-enrollment evidence is required independently of identity. API source availability does not establish a live institutional integration.' },
  { title: 'Google connection', body: 'Prospective entitlement/offer adapter: unconfigured until Google supplies an acceptance and fulfillment contract. Google sign-in or hosted-domain control is account identity, not enrollment. Availability and eligibility follow the specific official offer; no Google offer is activated by this guide.' },
  { title: 'Verve connection', body: 'Prospective campaign adapter: unconfigured until card qualification, merchant/acquirer access, funding, caps, settlement and reversal contracts are approved. Verve card acceptance through a PSP does not activate a reward or student campaign.' },
  { title: 'Paystack connection', body: 'Payment confirmation uses the account-specific mode described in the developer guide. Provider API/payment success is distinct from enrollment, benefit authorization and redemption. A native cashback/distribution partnership remains unconfigured without its own approved contract.' },
];
