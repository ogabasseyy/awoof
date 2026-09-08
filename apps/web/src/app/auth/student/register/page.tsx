'use client';

import {
    Suspense,
    useCallback,
    useEffect,
    useLayoutEffect,
    useMemo,
    useRef,
    useState,
    type FormEvent,
} from 'react';
import { Controller, useForm } from 'react-hook-form';
import { zodResolver } from '@hookform/resolvers/zod';
import { z } from 'zod';
import Link from 'next/link';
import { useSearchParams } from 'next/navigation';
import axios from 'axios';
import { AuthShell } from '@/components/auth/AuthShell';
import { UniversitySelect } from '@/components/forms/UniversitySelect';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { PasswordInput } from '@/components/ui/PasswordInput';
import { useAuth } from '@/contexts/AuthContext';
import { publicApiClient } from '@/lib/api-client';
import {
    parseSignupPreflight,
    parseSignupReceipt,
    signupRetryAt,
    studentSignupFormSchema,
    type ConfirmSignupResult,
    type SignupPreflight,
    type SignupReceipt,
    type StudentSignupClaims,
    type StudentSignupFormValues,
} from '@/lib/student-signup';
import { useStudentAuthLinks } from '@/hooks/useStudentAuthLinks';

type StudentSignupFormInput = {
    name: string;
    email: string;
    university: string;
    matricNumber?: string;
    password: string;
    confirmPassword: string;
};

type Phase = 'details' | 'otp' | 'recovery';

type SupportState =
    | { kind: 'idle' }
    | { kind: 'checking'; key: string }
    | { kind: 'supported'; key: string; preflight: SignupPreflight }
    | { kind: 'unsupported'; key: string; preflight: SignupPreflight }
    | { kind: 'failure'; key: string };

type PendingSignup = Readonly<{
    claims: StudentSignupClaims;
    password: string;
    receipt: SignupReceipt | null;
}>;

type ConsentBinding = Readonly<{ claims: StudentSignupClaims }>;

type RecoveryState = Readonly<{
    message: string;
    signInPath: string;
}>;

type FocusIntent = Readonly<{
    target: 'email' | 'otp';
    phase: Extract<Phase, 'details' | 'otp'>;
    submissionAttempt: number;
}>;

const canonicalEmailSchema = z.string().trim().toLowerCase().email();
const universityIdSchema = z.string().uuid();

function supportIdentity(email: string | undefined, university: string | undefined): { email: string; universityId: string; key: string } | null {
    const parsedEmail = canonicalEmailSchema.safeParse(email);
    const parsedUniversity = universityIdSchema.safeParse(university);
    if (!parsedEmail.success || !parsedUniversity.success) return null;
    return {
        email: parsedEmail.data,
        universityId: parsedUniversity.data,
        key: parsedEmail.data + '\n' + parsedUniversity.data,
    };
}

function claimsFor(values: StudentSignupFormValues, preflight: SignupPreflight): StudentSignupClaims {
    return {
        email: values.email,
        name: values.name,
        universityId: values.university,
        matricNumber: values.matricNumber,
        verificationConsent: true,
        noticeVersion: preflight.verificationNotice.version,
    };
}

function sameClaims(left: StudentSignupClaims | undefined, right: StudentSignupClaims): boolean {
    return !!left
        && left.email === right.email
        && left.name === right.name
        && left.universityId === right.universityId
        && left.matricNumber === right.matricNumber
        && left.verificationConsent === right.verificationConsent
        && left.noticeVersion === right.noticeVersion;
}

function isCurrentSupport(
    support: SupportState,
    identity: ReturnType<typeof supportIdentity>,
): support is Extract<SupportState, { kind: 'supported' }> {
    return support.kind === 'supported' && identity !== null && support.key === identity.key;
}

function errorMessage(error: unknown, fallback: string): string {
    if (axios.isAxiosError(error)) {
        const responseMessage = error.response?.data?.error?.message;
        if (typeof responseMessage === 'string' && responseMessage.trim().length > 0) return responseMessage;
    }
    return fallback;
}

function StudentRegisterInner() {
    const { confirmStudentSignup } = useAuth();
    const search = useSearchParams();
    const links = useStudentAuthLinks();
    const [phase, setPhase] = useState<Phase>('details');
    const [support, setSupport] = useState<SupportState>({ kind: 'idle' });
    const [supportRevision, setSupportRevision] = useState(0);
    const [consentChecked, setConsentChecked] = useState(false);
    const [consentError, setConsentError] = useState<string | null>(null);
    const [flowError, setFlowError] = useState<string | null>(null);
    const [otpError, setOtpError] = useState<string | null>(null);
    const [otp, setOtp] = useState('');
    const [pending, setPending] = useState<PendingSignup | null>(null);
    const [isRequesting, setIsRequesting] = useState(false);
    const [isConfirming, setIsConfirming] = useState(false);
    const [isResending, setIsResending] = useState(false);
    const [resendSuccess, setResendSuccess] = useState(false);
    const [retryAt, setRetryAt] = useState<number | null>(null);
    const [recovery, setRecovery] = useState<RecoveryState | null>(null);
    const [, setCooldownRefresh] = useState(0);
    const [focusRevision, setFocusRevision] = useState(0);
    const mountedRef = useRef(false);
    const phaseRef = useRef<Phase>('details');
    const preflightAttemptRef = useRef(0);
    const preflightControllerRef = useRef<AbortController | null>(null);
    const submissionAttemptRef = useRef(0);
    const submissionControllerRef = useRef<AbortController | null>(null);
    const consentBindingRef = useRef<ConsentBinding | null>(null);
    const pendingRef = useRef<PendingSignup | null>(null);
    const emailRef = useRef<HTMLInputElement | null>(null);
    const consentRef = useRef<HTMLInputElement | null>(null);
    const otpRef = useRef<HTMLInputElement | null>(null);
    const focusIntentRef = useRef<FocusIntent | null>(null);

    const {
        register,
        handleSubmit,
        control,
        getValues,
        watch,
        formState: { errors },
    } = useForm<StudentSignupFormInput, unknown, StudentSignupFormValues>({
        resolver: zodResolver(studentSignupFormSchema),
        defaultValues: {
            name: '',
            email: '',
            university: '',
            matricNumber: '',
            password: '',
            confirmPassword: '',
        },
    });

    const name = watch('name');
    const email = watch('email');
    const university = watch('university');
    const matricNumber = watch('matricNumber');
    const identity = useMemo(() => supportIdentity(email, university), [email, university]);
    const identityKey = identity?.key ?? null;
    const emailField = register('email');

    const changePhase = useCallback((next: Phase): void => {
        phaseRef.current = next;
        setPhase(next);
    }, []);

    const updatePending = useCallback((next: PendingSignup | null): void => {
        pendingRef.current = next;
        setPending(next);
    }, []);

    const requestCommittedFocus = useCallback((target: FocusIntent['target'], nextPhase: FocusIntent['phase'], submissionAttempt: number): void => {
        focusIntentRef.current = { target, phase: nextPhase, submissionAttempt };
        setFocusRevision((revision) => revision + 1);
    }, []);

    const cancelPreflight = useCallback((): void => {
        preflightAttemptRef.current += 1;
        preflightControllerRef.current?.abort();
        preflightControllerRef.current = null;
    }, []);

    const cancelSubmission = useCallback((): void => {
        submissionAttemptRef.current += 1;
        submissionControllerRef.current?.abort();
        submissionControllerRef.current = null;
        focusIntentRef.current = null;
        setIsRequesting(false);
        setIsConfirming(false);
        setIsResending(false);
    }, []);

    const clearConsent = useCallback((): void => {
        consentBindingRef.current = null;
        setConsentChecked(false);
        setConsentError(null);
    }, []);

    useEffect(() => {
        mountedRef.current = true;
        return () => {
            mountedRef.current = false;
            preflightAttemptRef.current += 1;
            preflightControllerRef.current?.abort();
            submissionAttemptRef.current += 1;
            submissionControllerRef.current?.abort();
            pendingRef.current = null;
            focusIntentRef.current = null;
        };
    }, []);

    useLayoutEffect(() => {
        const intent = focusIntentRef.current;
        if (!intent
            || !mountedRef.current
            || phase !== intent.phase
            || phaseRef.current !== intent.phase
            || submissionAttemptRef.current !== intent.submissionAttempt) return;

        const target = intent.target === 'email' ? emailRef.current : otpRef.current;
        if (!target) return;
        focusIntentRef.current = null;
        target.focus();
    }, [focusRevision, phase]);

    useEffect(() => {
        clearConsent();
        if (phaseRef.current === 'details') {
            cancelSubmission();
            updatePending(null);
            setOtp('');
            setOtpError(null);
            setRetryAt(null);
            setResendSuccess(false);
        }
    }, [cancelSubmission, clearConsent, email, matricNumber, name, university, updatePending]);

    useEffect(() => {
        cancelPreflight();
        const attempt = preflightAttemptRef.current;
        setSupport({ kind: 'idle' });
        if (phaseRef.current !== 'details' || !identity) return;

        const controller = new AbortController();
        preflightControllerRef.current = controller;
        const isCurrent = (): boolean => mountedRef.current
            && phaseRef.current === 'details'
            && preflightAttemptRef.current === attempt
            && preflightControllerRef.current === controller
            && !controller.signal.aborted;
        const timer = window.setTimeout(() => {
            if (!isCurrent()) return;
            setSupport({ kind: 'checking', key: identity.key });
            void publicApiClient.post('/auth/verify-student-email', {
                email: identity.email,
                universityId: identity.universityId,
            }, { signal: controller.signal }).then((response) => {
                const parsed = response.status === 200 ? parseSignupPreflight(response.data) : null;
                if (!isCurrent()) return;
                clearConsent();
                if (!parsed) {
                    setSupport({ kind: 'failure', key: identity.key });
                    return;
                }
                setSupport(parsed.supported
                    ? { kind: 'supported', key: identity.key, preflight: parsed }
                    : { kind: 'unsupported', key: identity.key, preflight: parsed });
            }).catch(() => {
                if (!isCurrent()) return;
                setSupport({ kind: 'failure', key: identity.key });
            }).finally(() => {
                if (!isCurrent()) return;
                preflightControllerRef.current = null;
            });
        }, 250);

        return () => {
            window.clearTimeout(timer);
            controller.abort();
        };
    }, [cancelPreflight, clearConsent, identity, identityKey, phase, supportRevision]);

    useEffect(() => {
        if (retryAt === null) return;
        const delay = Math.max(0, retryAt - Date.now());
        const timeout = window.setTimeout(() => {
            if (mountedRef.current) setCooldownRefresh((value) => value + 1);
        }, delay);
        return () => window.clearTimeout(timeout);
    }, [retryAt]);

    const handleConsent = useCallback((checked: boolean): void => {
        if (!checked) {
            clearConsent();
            return;
        }
        const parsed = studentSignupFormSchema.safeParse(getValues());
        if (!parsed.success || !isCurrentSupport(support, identity)) {
            clearConsent();
            setConsentError('Your consent is required before we can send a verification code.');
            return;
        }
        const claims = claimsFor(parsed.data, support.preflight);
        consentBindingRef.current = { claims };
        setConsentChecked(true);
        setConsentError(null);
    }, [clearConsent, getValues, identity, support]);

    const handleInitialRequest = useCallback(async (values: StudentSignupFormValues): Promise<void> => {
        setFlowError(null);
        setOtpError(null);
        setResendSuccess(false);
        setRecovery(null);
        if (!isCurrentSupport(support, identity)) {
            setFlowError('School-email support must be confirmed before you can continue.');
            return;
        }
        const claims = claimsFor(values, support.preflight);
        if (!consentChecked || !sameClaims(consentBindingRef.current?.claims, claims)) {
            setConsentError('Your consent is required before we can send a verification code.');
            consentRef.current?.focus();
            return;
        }

        cancelSubmission();
        const attempt = ++submissionAttemptRef.current;
        const controller = new AbortController();
        submissionControllerRef.current = controller;
        const isCurrentAttempt = (): boolean => mountedRef.current
            && submissionAttemptRef.current === attempt
            && submissionControllerRef.current === controller
            && !controller.signal.aborted;
        const isCurrent = (): boolean => isCurrentAttempt() && phaseRef.current === 'details';
        const frozen: PendingSignup = { claims, password: values.password, receipt: null };
        updatePending(frozen);
        setIsRequesting(true);

        try {
            const response = await publicApiClient.post('/auth/student/register-request', {
                ...claims,
            }, { signal: controller.signal });
            const receipt = parseSignupReceipt(response.data, claims.email);
            if (!isCurrent()) return;
            if (!receipt) {
                updatePending(null);
                setFlowError('We could not start verification because the server returned an unusable receipt. Please try again.');
                return;
            }
            updatePending({ ...frozen, receipt });
            setRetryAt(Date.parse(receipt.resendAvailableAt));
            changePhase('otp');
            requestCommittedFocus('otp', 'otp', attempt);
        } catch (error: unknown) {
            if (!isCurrent()) return;
            updatePending(null);
            setFlowError(errorMessage(error, 'We could not start verification. Please try again.'));
        } finally {
            if (!isCurrentAttempt()) return;
            submissionControllerRef.current = null;
            setIsRequesting(false);
        }
    }, [
        cancelSubmission,
        changePhase,
        consentChecked,
        identity,
        requestCommittedFocus,
        support,
        updatePending,
    ]);

    const handleResend = useCallback(async (): Promise<void> => {
        const frozen = pendingRef.current;
        if (!frozen || isRequesting || isConfirming || isResending) return;
        const now = Date.now();
        if (retryAt !== null && retryAt > now) return;

        cancelSubmission();
        const attempt = ++submissionAttemptRef.current;
        const controller = new AbortController();
        submissionControllerRef.current = controller;
        const isCurrentAttempt = (): boolean => mountedRef.current
            && submissionAttemptRef.current === attempt
            && submissionControllerRef.current === controller
            && !controller.signal.aborted;
        const isCurrent = (): boolean => isCurrentAttempt() && phaseRef.current === 'otp';
        updatePending({ ...frozen, receipt: null });
        setOtp('');
        setOtpError(null);
        setFlowError(null);
        setResendSuccess(false);
        setRetryAt(null);
        setIsResending(true);

        try {
            const response = await publicApiClient.post('/auth/student/register-request', {
                ...frozen.claims,
            }, { signal: controller.signal });
            const receipt = parseSignupReceipt(response.data, frozen.claims.email);
            if (!isCurrent()) return;
            if (!receipt) {
                setFlowError('We could not send a new code. Please try again.');
                return;
            }
            updatePending({ ...frozen, receipt });
            setRetryAt(Date.parse(receipt.resendAvailableAt));
            setResendSuccess(true);
        } catch (error: unknown) {
            if (!isCurrent()) return;
            const response = axios.isAxiosError(error) ? error.response : undefined;
            // A definite cooldown rejection does not supersede the previous challenge.
            if (response?.status === 429) updatePending(frozen);
            const deadline = response?.status === 429
                ? signupRetryAt(response.data, response.headers?.['retry-after'], Date.now())
                : null;
            if (deadline !== null) {
                setRetryAt(deadline);
                setFlowError('Please wait before requesting another code.');
                return;
            }
            setFlowError('We could not send a new code. Please try again.');
        } finally {
            if (!isCurrentAttempt()) return;
            submissionControllerRef.current = null;
            setIsResending(false);
        }
    }, [cancelSubmission, isConfirming, isRequesting, isResending, retryAt, updatePending]);

    const finishRecovery = useCallback((result: Extract<ConfirmSignupResult, { kind: 'account_created' | 'outcome_unknown' }>): void => {
        updatePending(null);
        setOtp('');
        setOtpError(null);
        setResendSuccess(false);
        setRecovery({
            signInPath: result.signInPath,
            message: result.kind === 'account_created'
                ? 'Your account was created. Sign in to continue.'
                : 'We could not confirm whether your account was created. Sign in before trying again.',
        });
        changePhase('recovery');
    }, [changePhase, updatePending]);

    const handleConfirmation = useCallback(async (event: FormEvent<HTMLFormElement>): Promise<void> => {
        event.preventDefault();
        const frozen = pendingRef.current;
        if (!frozen?.receipt) {
            setOtpError('Request a new verification code before creating your account.');
            return;
        }
        if (!/^\d{6}$/.test(otp)) {
            setOtpError('Enter a six-digit code using 0–9.');
            return;
        }

        cancelSubmission();
        const attempt = ++submissionAttemptRef.current;
        const controller = new AbortController();
        submissionControllerRef.current = controller;
        const isCurrentAttempt = (): boolean => mountedRef.current
            && submissionAttemptRef.current === attempt
            && submissionControllerRef.current === controller
            && !controller.signal.aborted;
        const isCurrent = (): boolean => isCurrentAttempt() && phaseRef.current === 'otp';
        setFlowError(null);
        setOtpError(null);
        setIsConfirming(true);

        try {
            const result = await confirmStudentSignup({
                ...frozen.claims,
                password: frozen.password,
                challengeId: frozen.receipt.challengeId,
                otp,
            }, {
                signal: controller.signal,
                returnTo: search.get('redirect'),
            });
            if (!isCurrent()) return;
            if (result.kind === 'completed') {
                updatePending(null);
                setOtp('');
                return;
            }
            if (result.kind === 'account_created' || result.kind === 'outcome_unknown') {
                finishRecovery(result);
                return;
            }
            if (result.kind === 'not_started') {
                setFlowError(result.reason === 'active_session'
                    ? 'You are already signed in. Sign out before creating another student account.'
                    : 'Secure storage is unavailable on this device. We cannot start signup safely.');
                return;
            }
            if (result.kind === 'rejected') {
                if (result.reason === 'proof') {
                    setOtpError('The verification code is invalid or expired. Request a new code.');
                    return;
                }
                setFlowError(result.reason === 'conflict'
                    ? 'This account may already exist. Sign in before trying again.'
                    : 'We could not complete signup. Please review the form and try again.');
                return;
            }
            setFlowError('Signup stopped before it could be completed.');
        } finally {
            if (!isCurrentAttempt()) return;
            submissionControllerRef.current = null;
            setIsConfirming(false);
        }
    }, [
        cancelSubmission,
        confirmStudentSignup,
        finishRecovery,
        otp,
        search,
        updatePending,
    ]);

    const handleBack = useCallback((): void => {
        cancelPreflight();
        cancelSubmission();
        clearConsent();
        updatePending(null);
        setOtp('');
        setOtpError(null);
        setFlowError(null);
        setRetryAt(null);
        setResendSuccess(false);
        setRecovery(null);
        changePhase('details');
        setSupportRevision((revision) => revision + 1);
        requestCommittedFocus('email', 'details', submissionAttemptRef.current);
    }, [cancelPreflight, cancelSubmission, changePhase, clearConsent, requestCommittedFocus, updatePending]);

    const supported = isCurrentSupport(support, identity) ? support : null;
    const canResend = !isRequesting
        && !isConfirming
        && !isResending
        && (retryAt === null || retryAt <= Date.now());
    const showBackDuringRequest = phase === 'details' && isRequesting;

    return (
        <AuthShell
            role="student"
            title={phase === 'details' ? 'Create Student Account' : phase === 'otp' ? 'Enter Verification Code' : 'Signup recovery'}
            subtitle={phase === 'details'
                ? 'Join Awoof and get exclusive student discounts.'
                : phase === 'otp'
                    ? 'Enter the code sent to your school email to finish creating your account.'
                    : 'Use the ordinary sign-in link below to continue safely.'}
            maxWidthClass="max-w-lg"
            footer={(
                <p className="text-center text-sm text-slate-600">
                    Already have an account?{' '}
                    <Link href={links.loginPath} className="text-primary hover:underline font-medium">
                        Sign in
                    </Link>
                </p>
            )}
        >
            {phase === 'recovery' && recovery ? (
                <section className="space-y-4">
                    <p id="signup-recovery-error" role="alert" className="rounded-xl border border-amber-200 bg-amber-50 p-3 text-sm text-amber-800">
                        {recovery.message}
                    </p>
                    <Link href={recovery.signInPath} className="inline-flex w-full items-center justify-center rounded-full bg-primary px-4 py-3 font-semibold text-primary-foreground">
                        Sign in
                    </Link>
                </section>
            ) : phase === 'details' ? (
                <form key="student-signup-details" onSubmit={handleSubmit(handleInitialRequest)} className="space-y-5" noValidate>
                    {flowError && <p id="signup-flow-error" role="alert" className="rounded-xl border border-red-200 bg-red-50 p-3 text-sm text-red-700">{flowError}</p>}
                    <div>
                        <Label htmlFor="name" className="text-left block mb-2">Full Name</Label>
                        <Input
                            id="name"
                            type="text"
                            placeholder="John Doe"
                            {...register('name')}
                            className="w-full"
                            aria-invalid={!!errors.name}
                            aria-describedby={errors.name ? 'student-signup-name-error' : undefined}
                        />
                        {errors.name && <p id="student-signup-name-error" role="alert" className="mt-1 text-sm text-red-600 text-left">{errors.name.message}</p>}
                    </div>

                    <div>
                        <Label htmlFor="email" className="text-left block mb-2">Student Email</Label>
                        <Input
                            id="email"
                            type="email"
                            placeholder="you@university.edu.ng"
                            {...emailField}
                            ref={(node) => {
                                emailField.ref(node);
                                emailRef.current = node;
                            }}
                            className="w-full"
                            aria-invalid={!!errors.email}
                            aria-describedby={errors.email ? 'student-signup-email-error' : undefined}
                        />
                        {errors.email && <p id="student-signup-email-error" role="alert" className="mt-1 text-sm text-red-600 text-left">{errors.email.message}</p>}
                        {support.kind === 'checking' && <p role="status" className="mt-1 text-sm text-slate-600 text-left">Checking school-email support…</p>}
                        {support.kind === 'unsupported' && <p role="status" className="mt-1 text-sm text-red-600 text-left">This school email is not supported for student verification.</p>}
                        {support.kind === 'failure' && (
                            <p id="signup-support-error" role="alert" className="mt-1 text-sm text-red-600 text-left">
                                Unable to check school-email support right now.{' '}
                                <button type="button" onClick={() => setSupportRevision((revision) => revision + 1)} className="underline font-medium">
                                    Retry
                                </button>
                            </p>
                        )}
                    </div>

                    <Controller
                        name="university"
                        control={control}
                        render={({ field }) => (
                            <UniversitySelect
                                value={field.value && universityIdSchema.safeParse(field.value).success ? field.value : ''}
                                onChange={(id) => field.onChange(id || '')}
                                error={errors.university?.message}
                                required
                            />
                        )}
                    />

                    <div>
                        <Label htmlFor="matricNumber" className="text-left block mb-2">
                            Matric Number <span className="text-gray-400 ml-1 text-xs">(Optional)</span>
                        </Label>
                        <Input
                            id="matricNumber"
                            type="text"
                            placeholder="Enter your matric number"
                            {...register('matricNumber')}
                            className="w-full"
                            aria-invalid={!!errors.matricNumber}
                            aria-describedby={errors.matricNumber ? 'student-signup-matric-error' : undefined}
                        />
                        {errors.matricNumber && <p id="student-signup-matric-error" role="alert" className="mt-1 text-sm text-red-600 text-left">{errors.matricNumber.message}</p>}
                    </div>

                    <div>
                        <Label htmlFor="password" className="text-left block mb-2">Password</Label>
                        <PasswordInput
                            id="password"
                            placeholder="At least 8 characters"
                            {...register('password')}
                            className="w-full"
                            aria-invalid={!!errors.password}
                            aria-describedby={errors.password ? 'student-signup-password-error' : undefined}
                        />
                        {errors.password && <p id="student-signup-password-error" role="alert" className="mt-1 text-sm text-red-600 text-left">{errors.password.message}</p>}
                    </div>

                    <div>
                        <Label htmlFor="confirmPassword" className="text-left block mb-2">Confirm Password</Label>
                        <PasswordInput
                            id="confirmPassword"
                            placeholder="Re-enter your password"
                            {...register('confirmPassword')}
                            className="w-full"
                            aria-invalid={!!errors.confirmPassword}
                            aria-describedby={errors.confirmPassword ? 'student-signup-confirm-password-error' : undefined}
                        />
                        {errors.confirmPassword && <p id="student-signup-confirm-password-error" role="alert" className="mt-1 text-sm text-red-600 text-left">{errors.confirmPassword.message}</p>}
                    </div>

                    {supported && (
                        <fieldset className="space-y-2 rounded-xl border border-slate-200 bg-slate-50 p-4">
                            <legend className="sr-only">Student verification processing consent</legend>
                            <p id="verification-notice" className="text-left text-sm text-slate-700">
                                {supported.preflight.verificationNotice.text}
                            </p>
                            <p role="status" className="text-left text-sm text-slate-700">
                                Your school email is supported. We will send an OTP to continue.
                            </p>
                            <div className="flex items-start gap-2">
                                <input
                                    id="verification-consent"
                                    ref={consentRef}
                                    type="checkbox"
                                    checked={consentChecked}
                                    onChange={(event) => handleConsent(event.target.checked)}
                                    aria-describedby="verification-notice consent-error"
                                    className="mt-1 h-4 w-4"
                                />
                                <label htmlFor="verification-consent" className="text-left text-sm text-slate-800">
                                    I agree to student verification processing
                                </label>
                            </div>
                            <p id="consent-error" role="alert" className="text-left text-sm text-red-600">
                                {consentError ?? ''}
                            </p>
                        </fieldset>
                    )}

                    <div className="flex gap-3">
                        {showBackDuringRequest && (
                            <Button type="button" variant="outline" onClick={handleBack} className="flex-1 rounded-full h-11 font-semibold">
                                Back
                            </Button>
                        )}
                        <Button type="submit" className="flex-1 rounded-full h-11 font-semibold" disabled={isRequesting}>
                            {isRequesting ? 'Sending code…' : 'Continue'}
                        </Button>
                    </div>
                </form>
            ) : (
                <form key="student-signup-otp" onSubmit={handleConfirmation} className="space-y-5">
                    {flowError && <p id="signup-flow-error" role="alert" className="rounded-xl border border-red-200 bg-red-50 p-3 text-sm text-red-700">{flowError}</p>}
                    {resendSuccess && <p role="status" className="rounded-xl border border-green-200 bg-green-50 p-3 text-sm text-green-700">A new verification code was sent. Check your email.</p>}
                    <div>
                        <Label htmlFor="otp" className="text-left block mb-2">Verification Code</Label>
                        <Input
                            id="otp"
                            name="otp"
                            ref={otpRef}
                            type="text"
                            inputMode="numeric"
                            autoComplete="one-time-code"
                            maxLength={6}
                            value={otp}
                            onChange={(event) => {
                                setOtp(event.target.value);
                                setOtpError(null);
                            }}
                            aria-invalid={!!otpError}
                            aria-describedby="otp-help otp-error"
                            className="w-full text-center text-lg tracking-widest"
                        />
                        <p id="otp-help" className="mt-1 text-sm text-slate-600 text-left">Enter the six-digit code sent to your school email.</p>
                        <p id="otp-error" role="alert" className="mt-1 text-sm text-red-600 text-left">{otpError ?? ''}</p>
                    </div>
                    <div className="flex gap-3">
                        <Button type="button" variant="outline" onClick={handleBack} className="flex-1 rounded-full h-11 font-semibold">
                            Back
                        </Button>
                        <Button
                            type="submit"
                            className="flex-1 rounded-full h-11 font-semibold"
                            disabled={isConfirming || !pending?.receipt}
                        >
                            {isConfirming ? 'Verifying…' : 'Create Account'}
                        </Button>
                    </div>
                    <p className="text-center text-sm text-slate-600">
                        Didn&apos;t get the code?{' '}
                        <button
                            type="button"
                            onClick={() => void handleResend()}
                            disabled={!canResend}
                            className="text-primary hover:underline font-medium disabled:opacity-50 disabled:no-underline"
                        >
                            {isResending ? 'Sending…' : 'Resend code'}
                        </button>
                    </p>
                </form>
            )}
        </AuthShell>
    );
}

export default function StudentRegisterPage() {
    return (
        <Suspense fallback={<p role="status">Loading student signup…</p>}>
            <StudentRegisterInner />
        </Suspense>
    );
}
