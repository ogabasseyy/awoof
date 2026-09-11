# Durable signed-out action marker

This is a bounded prerequisite to the approved student signup handoff, not a new authentication protocol or a claim that signup is implemented. It addresses the concrete gap recorded in the independent confirmation-handoff design check: a fresh signed-out snapshot currently cannot distinguish a newer remote logout from the constant previously observed signed-out envelope.

## Contract

- Keep the existing TypeScript/Next/Express/PostgreSQL stack.
- Authentication, student assurance, and merchant permission are separate.
- A permanent users.verification_status flag is compatibility/display data, not an authorization source.
- Keep storage key `awoof.session.v1`, active envelope format and every exported auth function signature unchanged.
- Add an optional opaque nonempty-string `actionId` to the signed-out v1 envelope. Every successful explicit `clearTokens()` writes a new cryptographically generated id using the existing UUID source. It contains no account identity, credentials or submitted signup claims.
- Legacy signed-out envelopes with no actionId remain valid and authoritative over leftover legacy credentials. Invalid markers remain fail-closed signed-out; no fallback migration while the envelope key exists. Do not retrofit an id during reads or rewrite storage simply to observe it.
- Observing a different signed-out action id advances the local generation and notifies subscribers once even if already signed out. Re-reading the same marker is stable. Update observed state before notification so a subscriber reading a snapshot does not recurse indefinitely.
- A new tagged marker after an unobserved active-to-signed-out round trip changes generation on the next explicit read, without depending on delivery of intermediate storage events. Initial or repeated anonymous legacy state is stable; repeated identical untagged legacy writes cannot gain a guarantee they do not encode.
- Keep current active-session replacement and own-refresh generation semantics unchanged. Keep provisional quarantine followed by durable-success notification, including retry from failed clear; do not add duplicate success notifications through read-time reconciliation.
- Failure to generate an id or persist the marker keeps the tab quarantined/signed out with the existing explicit recovery path. Do not throw through logout, invent an insecure fallback id, clear newer credentials as compensation, or restore old authority.
- No VPS deployment, merge or push as part of this implementation run.
- No new dependency, shared dependency write, real environment, live API/provider/payment call or worker-spawned agent.
- No token, password, OTP or submitted signup claims in navigation URLs, logs, screenshots or traces. Synthetic loopback127.0.0.1:3107/3108 only, isolated installed Chrome, automatic screenshots/video/traces off.
- Work only in the existing isolated source checkout after the public university picker final review passes. Preserve other changes; no concurrent source owners. Parent owns planning/report coordination, Terra owns source, Astra reviews.
- Check at least3GiB free before build/server/browser. Existing unchanged public Google font build fetch is allowed. One-off npm run build -- --webpack is approved for local validation; do not change default build settings or claim CI/VPS parity.

## Deliberate limit

This supplies durable evidence of completed updated-client logout actions at a fresh read, not atomic cross-tab compare-and-swap. Another tab can still write between separate checks/writes; callers must retain provider operation/abort/exact snapshot checks, and must not promise transactional cross-tab exclusion. The HTML storage standard explicitly advises assuming no locking mechanism, while storage events are queued in other documents. References checked2026-09-07: https://html.spec.whatwg.org/multipage/webstorage.html and https://developer.mozilla.org/en-US/docs/Web/API/Window/storage_event.

The upcoming signup handoff still needs its own real rendered cancellation and account-created recovery tests. This two-file storage task does not alter AuthContext, Axios, signup UI, backend sessions, merchant authorization, or deployed assets.
