# Unified Support Desk + Notifications — Design Spec

**Date:** 2026-08-26  
**Status:** Approved in design review (Approach 2); awaiting user review of this written spec  
**Scope:** Rebuild support as one ticket model for students and vendors; shared admin inbox; in-app notifications + Brevo email for support and commerce events.

---

## 1. Goals & success criteria

### In scope (MVP)

1. **Unified tickets** — one `tickets` + `ticket_messages` model (replace dual student/vendor ticket tables).
2. **Requester UX** — student and vendor: create, list, open thread, reply.
3. **Admin UX** — shared Support inbox (any admin), open thread, reply, set status; internal notes.
4. **In-app notifications** — `user_id`-based notifications for student, vendor, and admin; working Topbar bell + inbox pages.
5. **Email (Brevo)** — ticket created (admins/ops), reply/status change (requester), purchase confirmation (student), new order (vendor).
6. **Commerce notification producers** — purchase completed, vendor new order, payout/split enabled.
7. **Data migration** — move existing student/vendor tickets + responses + student notifications into the new model.

### Out of scope

- Ticket assignment / claiming  
- SLA timers  
- File attachments  
- WebSockets / realtime push (poll unread for bell)  
- Third-party helpdesk (Intercom, etc.)  
- Changing auth/verification email templates beyond reuse of Brevo helpers  

### Done when

- Student and vendor can create a ticket and hold a threaded conversation with admin.  
- Admin sees one queue covering both roles and can reply + change status.  
- Bell shows real unread counts; inbox lists notifications; mark read works for all roles.  
- Emails send for the MVP events when Brevo is configured.  
- Legacy ticket tables are migrated and removed (or aliased and dropped in the same migration series).

---

## 2. Decisions locked

| Topic | Choice |
|-------|--------|
| Architecture | **Approach 2** — unified tickets (not extend dual tables) |
| Admin model | Shared inbox — any admin can act on any ticket |
| Notification events | Support + commerce (not full account surface) |
| Fee / payment | Unrelated; unchanged |
| Realtime | Polling (bell unread every ~30–60s while dashboard open) |
| Internal notes | `is_internal` on messages; hidden from requesters |
| Naming | New tables `tickets` / `ticket_messages` (avoid fighting existing `support_tickets` name during migrate) |

---

## 3. Data model

### 3.1 `tickets`

| Column | Notes |
|--------|--------|
| `id` | UUID PK |
| `requester_user_id` | FK → `users(id)` |
| `requester_role` | `student` \| `vendor` |
| `subject` | VARCHAR(255) |
| `category` | `general`, `technical`, `billing`, `account`, `integration`, `product`, `order` |
| `status` | `open`, `in-progress`, `resolved`, `closed` |
| `priority` | `low`, `normal`, `high`, `urgent` (default `normal`) |
| `resolved_at` | nullable |
| `created_at`, `updated_at` | standard |

Indexes: requester, status, created_at DESC, (status, created_at).

Initial message body lives as the **first** `ticket_messages` row (author = requester), not a separate `message` column — keeps one conversation source of truth. Create API still accepts `subject` + `message` and inserts both ticket + first message.

### 3.2 `ticket_messages`

| Column | Notes |
|--------|--------|
| `id` | UUID PK |
| `ticket_id` | FK → `tickets` CASCADE |
| `author_user_id` | FK → `users` SET NULL |
| `author_role` | `student` \| `vendor` \| `admin` |
| `body` | TEXT |
| `is_internal` | boolean default false |
| `created_at` | timestamptz |

### 3.3 `notifications` (evolve)

- Add `user_id UUID REFERENCES users(id)`  
- Backfill: `user_id` from `students.user_id` where `student_id` set  
- Make `user_id` NOT NULL; drop `student_id` FK (or keep nullable legacy briefly then drop)  
- Keep: `title`, `message`, `type`, `read`, `metadata`, `created_at`, `read_at`  
- Add optional `kind` VARCHAR for routing (e.g. `support_reply`, `purchase`, `order`) — stored also in metadata if simpler  

Indexes: `(user_id, read)` where unread; `created_at DESC`.

### 3.4 Migration from legacy

**Sources:** `support_tickets` + `support_ticket_responses`; `vendor_support_tickets` + `vendor_support_ticket_responses`.

**Steps (single migration series `022` / `023`):**

1. Create `tickets`, `ticket_messages`.  
2. Insert student tickets → map `student_id` → `users` via `students`; first message = original `message`; responses → messages.  
3. Insert vendor tickets → map `vendor_id` → `users` via `vendors`; same for responses (`vendor`/`admin` roles).  
4. Alter notifications → `user_id`; backfill; drop student-only constraint.  
5. Drop legacy support tables (and vendor support tables) after verify counts.  
6. Update admin analytics open-ticket query to `tickets` where status in (`open`,`in-progress`).

---

## 4. API contract

### Requester (student / vendor) — role-scoped mount

Prefer shared controller with role middleware:

- `POST /api/support/tickets` — create `{ subject, message, category }`  
- `GET /api/support/tickets` — list own (pagination, status filter)  
- `GET /api/support/tickets/:id` — ticket + messages (exclude `is_internal`)  
- `POST /api/support/tickets/:id/messages` — reply (blocked if `closed`)  

Mount also under existing prefixes as aliases if needed for less frontend churn:  
`/api/students/support-tickets` and `/api/vendors/support-tickets` can proxy to the same handlers during transition, then deprecate.

### Admin

- `GET /api/admin/support/tickets` — all tickets; filters: status, role, search  
- `GET /api/admin/support/tickets/:id` — full thread including internal notes  
- `POST /api/admin/support/tickets/:id/messages` — `{ body, isInternal? }`  
- `PATCH /api/admin/support/tickets/:id` — `{ status, priority? }`  

### Notifications (all roles)

- `GET /api/notifications` — list for `req.user.userId`  
- `GET /api/notifications/unread-count`  
- `PUT /api/notifications/:id/read`  
- `PUT /api/notifications/read-all`  
- `DELETE /api/notifications/:id`  

Student-only routes under `/api/students/notifications` redirect or are replaced by the shared routes.

---

## 5. Notification & email producers

| Event | In-app | Email |
|-------|--------|--------|
| Ticket created | All admins (or users with role admin) | Ops/`EMAIL_FROM` + optional each admin email |
| Admin reply (public) | Requester | Requester |
| Requester reply | All admins | Ops inbox (optional; can be in-app only to reduce noise — **MVP: in-app admins + email ops**) |
| Status → resolved/closed | Requester | Requester |
| Purchase completed | Student | Student (receipt-style) |
| New marketplace order | Vendor | Vendor |
| Payout / split enabled (subaccount saved) | Vendor | Optional (in-app required) |

Implementation: single `NotificationService.notifyUser(userId, …)` + `EmailService` templates. Call from ticket service and existing checkout/payment completion paths.

---

## 6. Frontend

### Support

- **Student:** evolve `/student/profile/support` — list + **detail route** `/student/profile/support/[id]` with thread + reply composer.  
- **Vendor:** same for `/vendor/support` + `/vendor/support/[id]`.  
- **Admin:** add Support to `adminNav` → `/admin/support` list + `/admin/support/[id]` thread, status controls, internal note toggle.

### Notifications

- Wire `Topbar` bell: fetch unread count; dropdown of latest 5–10; link to inbox.  
- Inboxes:  
  - Student: keep/enhance `/student/profile/notifications`  
  - Vendor: `/vendor/notifications` (nav item)  
  - Admin: `/admin/notifications` (nav or bell-only + page)

Preserve existing visual language (Awoof blue, dashboard layout).

---

## 7. Architecture units

| Unit | Responsibility |
|------|----------------|
| `ticket.service.ts` | Create/list/get/reply/status; ownership checks; emit notif/email |
| `ticket.controller.ts` | HTTP for requester + admin |
| `notification.service.ts` | Persist + list/mark read by `user_id` |
| `notification.controller.ts` | Shared notification HTTP |
| `email.service.ts` | New HTML templates for ticket + purchase + order |
| Migration `022_…` | Schema + data move |
| Web UI pages above | Role-specific shells, shared thread components where possible |

---

## 8. Error handling & security

- Requester can only access own tickets.  
- Admin routes: `authenticate` + `requireRole('admin')`.  
- Never return `is_internal` messages to student/vendor.  
- Closed tickets: no requester replies; admin may reopen via status patch if needed (`closed` → `open`).  
- Email failures must not fail the HTTP ticket reply (log + continue).  
- Rate-limit ticket create lightly if easy (optional).

---

## 9. Testing / verification

1. Migrate DB; row counts legacy ≈ new.  
2. Student creates ticket → appears in admin queue; admin notified.  
3. Admin replies → student sees thread + bell + email.  
4. Vendor ticket same path.  
5. Complete purchase → student notification + email; vendor gets new-order notification.  
6. Save payout with subaccount → vendor notified.  
7. Bell unread count decrements on mark read.  
8. Internal note invisible to requester.

---

## 10. Implementation notes

- Fix/remove broken student list SQL as part of rewrite (no `GROUP BY` after `LIMIT`).  
- Prefer shared `TicketThread` React component for student/vendor/admin detail (props: `canSetStatus`, `canPostInternal`).  
- Admin open-ticket analytics must count unified `tickets`.  
- Do not commit unless user asks.
