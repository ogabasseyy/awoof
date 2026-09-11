# Unified Support + Notifications Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Unified tickets for students/vendors, shared admin desk, user_id notifications + bell, Brevo emails for support and commerce events.

**Architecture:** New `tickets` / `ticket_messages` tables; migrate legacy; shared ticket + notification services; role-scoped UIs; producers on checkout/payout/ticket actions.

**Tech Stack:** Express/TS, Postgres, Next.js App Router, Brevo, existing dashboard layout.

## Global Constraints

- Follow `docs/superpowers/specs/2026-08-26-unified-support-notifications-design.md`
- Do not commit unless user asks
- Email failures must not fail ticket/checkout HTTP responses
- Never expose `is_internal` messages to requesters

---

## File map

| File | Role |
|------|------|
| `migrations/022_unified_tickets_and_notifications.sql` | Schema + data migration |
| `services/support/ticket.service.ts` | Ticket domain logic |
| `controllers/ticket.controller.ts` | Requester + admin HTTP |
| `services/notification/notification.service.ts` | Rewrite for user_id |
| `controllers/notification.controller.ts` | Shared notification HTTP |
| `services/email/email.service.ts` | New templates |
| `routes/support.routes.ts` + admin/student/vendor mounts | Routing |
| Web: support detail pages, admin support, bell, inboxes | UI |

---

### Task 1: Migration

- [ ] Create `tickets`, `ticket_messages`
- [ ] Migrate student + vendor tickets/responses
- [ ] Notifications → `user_id`; backfill; drop `student_id` NOT NULL dependency
- [ ] Drop legacy support tables
- [ ] Run `npm run db:migrate`

### Task 2: Ticket service + APIs

- [ ] `ticket.service.ts`: create, listOwn, listAll, get, reply, patchStatus
- [ ] Controllers + routes for `/api/support/*` and `/api/admin/support/*`
- [ ] Keep thin aliases under students/vendors if needed for old paths

### Task 3: Notifications + email

- [ ] Rewrite notification service for `user_id`
- [ ] Shared `/api/notifications*` routes
- [ ] Brevo: ticket created, reply, status, purchase, new order
- [ ] Wire producers: ticket actions, checkout complete, payout save

### Task 4: Frontend support

- [ ] Student/vendor: list + detail thread + reply
- [ ] Admin: `/admin/support` list + detail + status
- [ ] Shared thread UI component

### Task 5: Frontend notifications

- [ ] Topbar bell (unread + dropdown)
- [ ] Vendor + admin inbox pages; enhance student inbox
- [ ] Poll unread while dashboard mounted

### Task 6: Verify

- [ ] Create student + vendor tickets; admin reply; bell/email
- [ ] Purchase → student notif; vendor order notif
- [ ] Analytics open ticket count uses `tickets`
