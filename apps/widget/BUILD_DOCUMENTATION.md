# Awoof Widget SDK - Build Documentation

> **Pilot contract notice.** The modal/iframe/token flow described in the
> build-spec sections below is retired: `POST /api/verification/widget/token`
> now returns the retired-widget response, and the SDK no longer embeds an
> iframe or listens for `AWOOF_VERIFICATION_SUCCESS`. The implemented flow is
> the gated popup/code pilot described in
> [`docs/merchant-widget-pilot.md`](../../docs/merchant-widget-pilot.md), with
> a working merchant example in [`examples/vanilla.html`](examples/vanilla.html).
> Do not implement new integrations from the retired sections; they are kept
> for historical context and are marked where they conflict with the pilot.

## Overview

This document outlines the specific requirements for building the **Awoof Vendor Integration Widget** - a standalone, embeddable JavaScript SDK that allows vendors to integrate student verification directly into their websites.

---

## Current implementation status (as of build)

- **Backend**
  - `POST /api/widget/domain-check` with JSON body `{domain, apiKey, origin}` – validates that the exact request origin is in the vendor’s `widget_configs.allowed_origins`. Returns `{ allowed: true, vendorId }` or 403. POST-only: the API key must never travel in the URL query string (logs/history/Referer exposure).
  - `POST /api/widget/merchant-context` – pilot-gated merchant context for the hosted page (strict `{vendorId, origin}` request).
  - `POST /api/merchant-verification/pilot-assertions` – pilot-gated issuance of a short-lived opaque eligibility code after disclosure consent; deliberately rejects product binding.
  - `GET /api/vendors/widget-config` (authenticated vendor) – returns widget config (allowedDomains, allowedOrigins, apiKey). Creates default config if none.
  - `PUT /api/vendors/widget-config` (authenticated vendor) – update allowed domains and optional exact `allowedOrigins` (ports, development localhost); optional `regenerateApiKey`.
- **Widget package** (`apps/widget`)
  - Scaffold: Rollup UMD build, `Awoof` global, `dist/awoof.js`.
  - `Awoof.init({ apiKey, apiBaseUrl, webAppUrl, onSuccess, onError })` – calls domain-check for the exact merchant origin (bounded approval request), stores config. `webAppUrl` is the hosted pilot origin for the verification popup.
  - `Awoof.verify({ campaignId, purpose, onSuccess, onError, onCancel })` – opens a popup to `webAppUrl/widget/verify?vendorId=...&origin=...&campaignId=...&purpose=...&state=...`. Listens for `postMessage` type `AWOOF_ELIGIBILITY_CODE` from that popup only (origin + source + state + campaign binding); on receipt closes the popup and resolves `{ code, campaignId, expiresAt }`. The code is opaque: the merchant server exchanges it with its private key. Merchant pages must not send `Cross-Origin-Opener-Policy: same-origin`, which severs the opener relationship.
- **Web app** (`apps/web`)
  - `/widget/verify` – gated hosted pilot page (popup, not an iframe): pilot + student + merchant gates → eligibility precheck → disclosure consent → pilot-assertion issuance → `postMessage` to the registered merchant origin, then waits for the opener to close it. Framing is restricted by response headers.
- **Vendor dashboard**
  - Integration → Widget tab: Widget settings card with Widget API key (copy), Allowed domains (list, add/remove). Init/verify code example includes apiKey, apiBaseUrl, webAppUrl, campaignId, purpose, and server-side code exchange.
- **Still to do**
  - General-availability rollout decision (the pilot stays allowlisted and disabled by default).
  - CDN deploy and script tag URL.

---

## Application Purpose

The widget serves as:
- **Embeddable Verification Tool** - Vendors add a script tag to their website
- **Student Verification Interface** - Modal-based verification flow
- **Token Delivery System** - Sends verified token to vendor website via postMessage
- **Secure Integration** - Domain allowlist and security measures

---

## Core Features to Build

### 1. Embeddable Script

#### Integration Method
- Single script tag: `<script src='https://widget.awoof.com/awoof.js'></script>`
- Automatic initialization
- No build step required
- Works across different frameworks (React, Vue, Angular, vanilla JS)

#### Script Loading
- Asynchronous loading
- Non-blocking execution
- Error handling for failed loads
- Version management (CDN hosting)

### 2. Modal Interface

> Retired: the pilot SDK opens a popup to the hosted `/widget/verify` page
> instead of rendering a modal; see the pilot contract notice above.

#### Modal Component
- **Responsive modal** that overlays vendor website
- **Student verification form** inside modal
- **Multiple verification methods** support:
  - Portal Login redirect
  - Email input (for .edu domains)
  - Registration number input
  - Phone number input (for WhatsApp OTP)
- **Loading states** during verification
- **Error handling** and display
- **Success confirmation** before closing

#### UI/UX Requirements
- Clean, professional design
- Matches Awoof branding
- Mobile-responsive
- Accessible (keyboard navigation, screen readers)
- Smooth animations
- Close button
- Backdrop click to close (optional)

### 3. Verification Flow

> Retired: the pilot flow is popup → hosted consent → opaque eligibility code
> → merchant server-side exchange; no modal, no JWT token delivery. See the
> pilot contract notice above.

#### Step 1: Initialization
- Widget loads on vendor page
- Checks domain allowlist
- Initializes modal (hidden)
- Registers event listeners

#### Step 2: Trigger Verification
- Vendor calls widget method: `Awoof.verify()`
- Modal opens
- Shows NDPR consent screen
- Displays available verification methods

#### Step 3: Verification Process
- User selects verification method
- Widget communicates with backend API
- Shows loading state
- Handles verification response

#### Step 4: Token Delivery
- On successful verification
- Widget generates JWT token (or receives from backend)
- Sends token to vendor via `postMessage`
- Closes modal
- Triggers success callback

### 4. Domain Allowlist

#### Security Feature
- **Domain Validation** - Only allowed domains can use widget
- **Configuration** - Managed via vendor dashboard
- **API Check** - Widget validates domain on initialization
- **Error Handling** - Shows error if domain not allowed

#### Implementation
- Check `window.location.hostname`
- API call to backend to validate domain
- Cache validation result
- Re-validate periodically

### 5. postMessage Communication

#### Token Delivery
- Uses `window.postMessage` API
- Cross-origin communication
- Secure token transfer
- Event-based communication

#### Message Format

> Retired: the pilot message is `{ type: 'AWOOF_ELIGIBILITY_CODE', state,
> campaignId, purpose, code, expiresAt }`, accepted only from the opened
> popup at the expected hosted origin with matching state, campaign and
> purpose. The `code` is an opaque string for merchant server-side
> exchange, not a JWT and not an eligibility result. See the pilot
> contract notice above.

```javascript
// RETIRED - kept for historical context only
{
  type: 'AWOOF_VERIFICATION_SUCCESS',
  token: 'jwt_token_here',
  studentId: 'student_id',
  verifiedAt: 'timestamp',
  method: 'portal|email|registration|whatsapp'
}
```

#### Vendor Integration
- Vendor listens for `message` events
- Filters for Awoof messages
- Validates message origin
- Extracts token and uses for discount application

### 6. JWT Token Generation

> Retired: the pilot issues an opaque eligibility code, not a JWT; expiry is
> enforced by the merchant's server-side exchange. See the pilot contract
> notice above.

#### Token Creation
- Widget requests token from backend
- Backend generates JWT with verification data
- Token includes:
  - Student ID
  - Verification status
  - Verification method
  - Expiry timestamp (15 minutes)
  - Domain validation

#### Token Validation
- Vendor can validate token via API
- Backend verifies token signature
- Checks expiry
- Returns verification status

### 7. Webhook Replay Protection

#### Security Measures
- **HMAC Signature** - All webhook communications signed
- **Timestamp Validation** - Prevents replay attacks
- **Nonce System** - One-time use tokens
- **Signature Verification** - Backend validates all signatures

#### Implementation
- Generate HMAC signature for webhook payloads
- Include timestamp in payload
- Vendor validates signature and timestamp
- Reject old timestamps (>5 minutes)

---

## Technical Stack

### Core Technologies
- **Vanilla JavaScript** - No framework dependencies
- **ES6+ Syntax** - Modern JavaScript features
- **Bundler** - Webpack or Rollup for build
- **TypeScript** (optional) - For development

### Build Tools
- **Webpack/Rollup** - Module bundler
- **Babel** - JavaScript transpilation
- **Minification** - Production build optimization
- **Source Maps** - Debug support

### Styling
- **CSS/SCSS** - Modal styling
- **CSS-in-JS** (optional) - Dynamic styles
- **CSS Variables** - Theming support
- **Responsive Design** - Mobile-first

### API Communication
- **Fetch API** - HTTP requests to backend
- **Error Handling** - Network error management
- **Retry Logic** - Failed request retries
- **Timeout Handling** - Request timeouts

---

## Widget API (Public Interface)

### Initialization
```javascript
// Automatic initialization on script load
// Or manual initialization
Awoof.init({
  apiKey: 'vendor_api_key',
  domain: 'vendor-domain.com',
  onSuccess: (token) => {},
  onError: (error) => {}
});
```

### Verification Trigger

> Pilot contract: `Awoof.verify({ campaignId, purpose, ... })` — `campaignId`
> and `purpose` are required. The promise resolves with `{ code, campaignId,
> expiresAt }`; send `code` to your own server for private-key exchange. The
> bare `Awoof.verify()` / token-callback form below is retired.

```javascript
// Trigger verification popup (pilot contract)
Awoof.verify({
  campaignId: 'back-to-school',
  purpose: 'checkout-discount',
  onSuccess: (code, data) => {
    // Send code to your server; it exchanges the code with its private key
  },
  onError: (error) => {
    // Handle error
  },
  onCancel: () => {
    // Handle user cancellation
  }
});
```

### Configuration
```javascript
// Set widget configuration
Awoof.config({
  theme: 'light' | 'dark',
  language: 'en',
  modalTitle: 'Verify Student Status',
  // ... other options
});
```

### Event Listeners
```javascript
// Listen for verification events
Awoof.on('verification:success', (token) => {});
Awoof.on('verification:error', (error) => {});
Awoof.on('verification:cancel', () => {});
```

### Utility Methods
```javascript
// Check if student is verified
Awoof.isVerified();

// Get current token
Awoof.getToken();

// Clear verification data
Awoof.clear();

// Check domain allowlist status
Awoof.checkDomain();
```

---

## File Structure

```
widget/
├── src/
│   ├── index.js          # Main entry point
│   ├── widget.js         # Widget core class
│   ├── modal.js          # Modal component
│   ├── verification.js   # Verification logic
│   ├── api.js            # API communication
│   ├── token.js          # Token management
│   ├── security.js       # Security utilities
│   ├── utils.js          # Helper functions
│   └── styles.css        # Widget styles
├── dist/
│   ├── awoof.js          # Production build (minified)
│   ├── awoof.min.js      # Minified version
│   └── awoof.map         # Source map
├── examples/
│   ├── react-example.jsx
│   ├── vue-example.vue
│   ├── angular-example.ts
│   └── vanilla-example.html
├── package.json
├── webpack.config.js
└── README.md
```

---

## Integration Examples

> Retired: these examples use the old `AWOOF_VERIFICATION_SUCCESS`/token flow.
> For the pilot popup/code contract, follow
> [`examples/vanilla.html`](examples/vanilla.html): pass `campaignId` +
> `purpose`, receive the opaque code, and exchange it server-side with the
> private key. The snippets below are kept for historical context only.

### Vanilla JavaScript
```html
<!-- RETIRED - kept for historical context only -->
<script src="https://widget.awoof.com/awoof.js"></script>
<script>
  window.addEventListener('message', (event) => {
    if (event.data.type === 'AWOOF_VERIFICATION_SUCCESS') {
      // Use token to apply discount
      applyStudentDiscount(event.data.token);
    }
  });

  function verifyStudent() {
    Awoof.verify();
  }
</script>
<button onclick="verifyStudent()">Verify Student Status</button>
```

### React
```jsx
// RETIRED - kept for historical context only
import { useEffect } from 'react';

function App() {
  useEffect(() => {
    window.addEventListener('message', handleVerification);
    return () => window.removeEventListener('message', handleVerification);
  }, []);

  const handleVerification = (event) => {
    if (event.data.type === 'AWOOF_VERIFICATION_SUCCESS') {
      setStudentToken(event.data.token);
    }
  };

  const handleVerify = () => {
    window.Awoof?.verify();
  };

  return <button onClick={handleVerify}>Verify Student</button>;
}
```

### Vue
```vue
<!-- RETIRED - kept for historical context only -->
<template>
  <button @click="verifyStudent">Verify Student Status</button>
</template>

<script>
export default {
  mounted() {
    window.addEventListener('message', this.handleVerification);
  },
  beforeUnmount() {
    window.removeEventListener('message', this.handleVerification);
  },
  methods: {
    verifyStudent() {
      window.Awoof?.verify();
    },
    handleVerification(event) {
      if (event.data.type === 'AWOOF_VERIFICATION_SUCCESS') {
        this.$emit('verified', event.data.token);
      }
    }
  }
};
</script>
```

---

## Security Implementation

### Domain Validation
- Backend API endpoint for domain checking
- Widget validates on load
- Periodic re-validation
- Cache validation result (with expiry)

### Token Security
- JWT tokens with short expiry (15 minutes)
- Secure token storage (in memory, not localStorage)
- Token refresh mechanism
- Token revocation support

### Communication Security
- HTTPS only
- Origin validation for postMessage
- Message type validation
- Payload validation

### XSS Prevention
- Input sanitization
- Content Security Policy
- No inline scripts
- Safe DOM manipulation

---

## Error Handling

### Error Types
- **Network Errors** - API communication failures
- **Verification Errors** - Verification failures
- **Domain Errors** - Domain not allowed
- **Token Errors** - Token generation/validation failures
- **User Errors** - User cancellation or invalid input

### Error Display
- User-friendly error messages
- Retry options
- Support contact information
- Error logging (to backend)

---

## Testing Requirements

### Unit Tests
- Widget initialization
- Verification flow logic
- Token management
- Security utilities
- Error handling

### Integration Tests
- Backend API integration
- postMessage communication
- Domain validation
- Token generation and validation

### Browser Testing
- Cross-browser compatibility (Chrome, Firefox, Safari, Edge)
- Mobile browsers (iOS Safari, Chrome Mobile)
- Older browser support (if required)

### Integration Testing
- Test with different frameworks
- Test on different websites
- Test domain allowlist
- Test error scenarios

---

## Deployment

### CDN Hosting
- Host widget on CDN (Cloudflare/AWS CloudFront)
- Version management (semantic versioning)
- Cache headers
- HTTPS only

### Build Process
- Development build (with source maps)
- Production build (minified)
- Multiple formats (UMD, ES modules)

### Versioning
- Semantic versioning (v1.0.0)
- Breaking changes = major version
- Feature additions = minor version
- Bug fixes = patch version

---

## Documentation Requirements

### Developer Documentation
- Installation guide
- API reference
- Integration examples
- Configuration options
- Error handling guide
- Security best practices

### User Documentation
- How to integrate
- Framework-specific guides
- Troubleshooting
- FAQ
- Support contact

---

## Development Phases (Widget-Specific)

### Phase 1: Core Widget (Weeks 10-11)
- Widget architecture
- Basic modal implementation
- Script loading and initialization
- API communication setup

### Phase 2: Verification Integration (Week 12)
- Verification flow in modal
- Multiple method support
- Token generation and delivery
- postMessage implementation

### Phase 3: Security & Polish (Week 13)
- Domain allowlist implementation
- Security hardening
- Error handling
- UI/UX refinements

### Phase 4: Testing & Documentation (Week 13)
- Comprehensive testing
- Integration examples
- Documentation
- Browser compatibility testing

---

## Performance Requirements

### Bundle Size
- Target: < 50KB minified
- Gzipped: < 20KB
- Fast load time (< 100ms)

### Runtime Performance
- Smooth animations (60fps)
- Fast modal open/close
- Efficient API calls
- Memory management

---

**Document Version:** 1.0  
**Last Updated:** September 16, 2024  
**Part of:** Awoof MVP PRD
