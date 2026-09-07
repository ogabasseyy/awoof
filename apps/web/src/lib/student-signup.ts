import { z } from 'zod';
import { parseAuthenticationResponse, type AuthenticationResponse } from './auth-response';

export type StudentSignupClaims = Readonly<{
  email: string;
  name: string;
  universityId: string;
  matricNumber: string | null;
  verificationConsent: true;
  noticeVersion: string;
}>;

export type SignupReceipt = Readonly<{
  email: string;
  challengeId: string;
  expiresAt: string;
  resendAvailableAt: string;
}>;

export type SignupPreflight = Readonly<{
  supported: boolean;
  verificationNotice: Readonly<{ version: string; text: string }>;
}>;

export type SignupConfirmation = StudentSignupClaims & Readonly<{
  password: string;
  challengeId: string;
  otp: string;
}>;

export type ConfirmSignupResult =
  | { kind: 'completed' }
  | { kind: 'not_started'; reason: 'active_session' | 'storage_unavailable' }
  | { kind: 'rejected'; reason: 'validation' | 'proof' | 'conflict' | 'other' }
  | { kind: 'account_created'; reason: 'session_issuance' | 'storage'; signInPath: string }
  | { kind: 'outcome_unknown'; reason: 'transport' | 'invalid_response' | 'server'; signInPath: string }
  | { kind: 'cancelled'; reason: 'aborted' | 'superseded'; serverOutcome: 'not_dispatched' | 'unknown' | 'created' };

const passwordSpecialCharacter = /[!@#$%^&*(),.?":\{\}|<>\[\]\-_=+~`]/;

export const studentSignupFormSchema = z.object({
  name: z.string().trim().min(2, 'Name must be at least 2 characters').max(255, 'Name must be at most 255 characters'),
  email: z.string().trim().toLowerCase().email('Invalid email address'),
  university: z.string().uuid('Invalid university ID'),
  matricNumber: z.string().trim().max(100, 'Matric number must be at most 100 characters').optional()
    .transform((value) => value && value.length > 0 ? value : null),
  password: z.string()
    .min(8, 'Password must be at least 8 characters long')
    .refine((value) => /[A-Z]/.test(value), 'Password must contain at least one uppercase letter')
    .refine((value) => /[a-z]/.test(value), 'Password must contain at least one lowercase letter')
    .refine((value) => /[0-9]/.test(value), 'Password must contain at least one number')
    .refine((value) => passwordSpecialCharacter.test(value), 'Password must contain at least one special character'),
  confirmPassword: z.string(),
}).superRefine((value, context) => {
  if (value.password !== value.confirmPassword) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      message: "Passwords don't match",
      path: ['confirmPassword'],
    });
  }
});

export type StudentSignupFormValues = z.output<typeof studentSignupFormSchema>;

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

function isFiniteDate(value: unknown): value is string {
  return typeof value === 'string' && Number.isFinite(Date.parse(value));
}

function isFiniteIsoDate(value: unknown): value is string {
  return typeof value === 'string'
    && /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})$/.test(value)
    && Number.isFinite(Date.parse(value));
}

function hasSuccessfulOuterResponse(value: unknown): Record<string, unknown> | null {
  const outer = asRecord(value);
  if (!outer || outer.success !== true) return null;
  return asRecord(outer.data);
}

export function parseSignupPreflight(body: unknown): SignupPreflight | null {
  const data = hasSuccessfulOuterResponse(body);
  const verificationNotice = asRecord(data?.verificationNotice);
  if (
    !data
    || typeof data.supported !== 'boolean'
    || !verificationNotice
    || typeof verificationNotice.version !== 'string'
    || verificationNotice.version.trim().length === 0
    || typeof verificationNotice.text !== 'string'
    || verificationNotice.text.trim().length === 0
  ) return null;
  return {
    supported: data.supported,
    verificationNotice: {
      version: verificationNotice.version,
      text: verificationNotice.text,
    },
  };
}

export function parseSignupReceipt(body: unknown, expectedEmail: string): SignupReceipt | null {
  const data = hasSuccessfulOuterResponse(body);
  if (
    !data
    || data.email !== expectedEmail
    || typeof data.challengeId !== 'string'
    || !z.string().uuid().safeParse(data.challengeId).success
    || !isFiniteDate(data.expiresAt)
    || !isFiniteDate(data.resendAvailableAt)
  ) return null;
  return {
    email: data.email,
    challengeId: data.challengeId,
    expiresAt: data.expiresAt,
    resendAvailableAt: data.resendAvailableAt,
  };
}

export function parseSignupAuthentication(
  status: number,
  body: unknown,
  expectedEmail: string,
): AuthenticationResponse | null {
  if (status !== 201 || !hasSuccessfulOuterResponse(body)) return null;
  const authentication = parseAuthenticationResponse(body);
  if (!authentication || authentication.user.role !== 'student' || authentication.user.email !== expectedEmail) return null;
  return authentication;
}

export function signupRetryAt(body: unknown, retryAfter: unknown, now: number): number | null {
  const retryAt = asRecord(asRecord(body)?.error)?.details;
  const detailRetryAt = asRecord(retryAt)?.retryAt;
  if (isFiniteIsoDate(detailRetryAt)) return Date.parse(detailRetryAt);
  if (!Number.isFinite(now)) return null;

  const seconds = typeof retryAfter === 'number'
    ? retryAfter
    : typeof retryAfter === 'string' && retryAfter.trim().length > 0
      ? Number(retryAfter)
      : Number.NaN;
  if (!Number.isFinite(seconds) || seconds < 0) return null;
  const timestamp = now + seconds * 1_000;
  return Number.isFinite(timestamp) ? timestamp : null;
}
