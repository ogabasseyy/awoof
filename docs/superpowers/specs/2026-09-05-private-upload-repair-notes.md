# Private upload repair research notes

Read-only source findings from Terra, recorded by the controller for an A07/A15 implementation plan. These are not an executed plan or a claim about the live VPS. Existing vendor business documents are independent of the still-undecided manual student-document verification product.

## Current access and mutation paths

- Backend index.ts exposes all process-relative uploads via unauthenticated express.static. Vendor documents, logos/banners and product images share `/uploads/vendors/<UUID><original extension>` and the same physical directory. A known private document filename is publicly fetchable.
- Existing application mutations do not accept arbitrary asset URLs: vendor upload builds URLs from Multer filenames for the authenticated vendor; product create/update builds image URLs from productImage; product update additionally matches authenticated vendor_id. Profile, complete-registration and admin status schemas do not accept asset URL fields. This narrows the compatibility threat model but does not remedy public document delivery.
- Authentication runs before Multer, but vendor role and vendor-row lookup occur after disk writes. The signature validator is fail-open on read failure and is not attached to upload routes. All files go directly to permanent storage. MIME permits PDF even for public product images. Per-file 2 MiB limits are not a complete aggregate/parts/fields bound, and controller/DB failures and replacements leave files behind.
- Compose persists the upload root in backend_uploads and binds the backend to loopback port 5001. The real external reverse proxy/static configuration is not versioned and must be separately inspected before a production privacy claim.

## Source repair contract

Replace the blanket static mount with a controlled legacy-compatible GET /uploads/vendors/:filename. Reject malformed/traversal/ambiguous filenames before filesystem access. Resolve a canonical generated filename to its exact legacy DB URL. A reference in ANY vendor document_front_url or document_back_url is a private veto, even when corrupt legacy data also references it publicly. Otherwise serve only currently referenced logos/banners of active non-deleted vendors or images of active non-deleted products belonging to active non-deleted vendors, matching marketplace visibility. Unreferenced, stale, deleted, inactive and private paths return indistinguishable 404. Do not expose another generic filesystem route or volume path.

New documents and public assets use distinct private/public subdirectories beneath the configured persistent upload root; staging has a separate bounded temporary directory. Preserve legacy URL-shaped DB values only as server-side locators, not document API output. The controlled handler may fall back to the legacy directory only after authorization/reference classification. No blanket historical file deletion or move is authorized by this source task.

Authorised document delivery resolves vendor plus front/back server-side; never accept a caller-supplied pathname/URL. Owner means the vendor row owned by req.user.userId; there is no separate owner role. Add GET /api/vendors/documents/:side/download and admin-only GET /api/admin/vendors/:vendorId/documents/:side/download, with current live role/deletion/ownership checks. Send attachment, nosniff and private no-store headers. Admin list and vendor profile expose availability booleans, not document paths. Replace vendor settings direct anchors with authenticated blob downloads; add conditional admin table actions using the same helper; revoke object URLs after use. Preserve existing public image renderers.

Move vendor-role/profile authorization before Multer. Stage uploads, enforce field-specific content and byte limits, fail closed on read/signature errors, and clean up every partial/error path. Documents may be JPEG/PNG/WebP/PDF; logo/banner/product are images only. Explicit multipart files/fields/parts limits and aggregate byte checks are required, not only declared MIME or Content-Length. Use safe generated filenames and bounded exact paths. No image transformation/OCR dependency is needed for this repair.

Filesystem and PostgreSQL are not one atomic transaction. The executable plan must state the crash boundary honestly: validate staged bytes, move only owned staged files to final roots, update matching DB rows transactionally, remove newly moved files after DB failure, and retire old unreferenced files only after DB commit and reference checks. Do not delete a path still referenced by another public/private row. Unexpected cleanup failure must be observable and recoverable, not reported as a fully clean rollback. Decide a bounded orphan-reconciliation mechanism explicitly; do not improvise a broad recursive cleanup. Authorisation must precede filesystem mutation, and document reads must not race an unauthorised replacement into a public response.

Check pending-vendor settings previews when changing public visibility; do not claim marketplace compatibility from active fixtures alone. If authenticated owner previews are required, keep them narrowly scoped to the owner and not a new public escape hatch.

## Expected task ownership

- apps/backend/src/config/upload.ts and focused helpers/tests: safe storage roots, staged upload, validation, bounded cleanup and access classification.
- routes/vendors.routes.ts and controllers/vendor.controller.ts: role-first multipart handlers, owner downloads, availability fields and transactional row/path update.
- controllers/product.controller.ts: staged public-image lifecycle and replacement cleanup.
- index.ts: replace blanket static mount with controlled public delivery.
- routes/admin.routes.ts and controllers/admin-vendor.controller.ts: admin document actions and availability fields.
- apps/web/src/app/vendor/settings/page.tsx and admin/vendors/page.tsx plus a shared authenticated blob-download helper.
- Existing upload persistence configuration/HANDOVER only where needed to document roots, permissions and legacy safety. No live VPS migration.

## Acceptance evidence

Use actual temporary files and Express requests with synthetic authentication and real disposable database fixtures for reference/ownership decisions. Required matrix: anonymous, student, other vendor, correct vendor and admin; legacy document 404, active referenced logo/banner/product bytes, unreferenced/deleted/inactive 404, private-veto collision 404; owner/admin attachment bytes; path traversal/encoded separators no disclosure; MIME/signature mismatch, unreadable file, PDF productImage, aggregate/parts overflow all rejected with no leaked staged/final files. Include missing vendor/role rejection before write, Multer partial failure, DB/controller failure, successful replacement consistency, cross-row references and cleanup-failure observability. Public marketplace assets and pending owner settings remain usable by the correct audience.

Separately unverified production facts: reverse-proxy aliases, cached private URLs/CDN behavior, legacy collisions and historical files, volume ownership/permissions, backup inclusion and any one-time quarantine. Local source tests cannot establish those facts.
