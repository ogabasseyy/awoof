/**
 * Widget Verify Page (embed in iframe)
 *
 * Used by the Awoof widget on vendor sites. Flow: NDPR consent → university → method (reg / whatsapp) → verify → get widget token → postMessage to parent.
 */

'use client';

import React, { useState, useEffect, useCallback, Suspense } from 'react';
import { useSearchParams } from 'next/navigation';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { UniversitySelect } from '@/components/forms/UniversitySelect';
import apiClient, { publicApiClient } from '@/lib/api-client';
import { storeTokens } from '@/lib/auth';

const AWOOF_MESSAGE_TYPE = 'AWOOF_VERIFICATION_SUCCESS';

type Step = 'ndpr' | 'university' | 'method' | 'reg' | 'whatsapp_request' | 'whatsapp_verify' | 'success' | 'error';

function WidgetVerifyContent() {
    const searchParams = useSearchParams();
    const apiKey = searchParams.get('apiKey') || '';
    const vendorId = searchParams.get('vendorId') || '';
    const productId = searchParams.get('productId') || '';
    const origin = searchParams.get('origin') || '';

    const [step, setStep] = useState<Step>('ndpr');
    const [ndprConsent, setNdprConsent] = useState(false);
    const [universityId, setUniversityId] = useState<string | null>(null);
    const [methods, setMethods] = useState<Array<{ methodType: string; isAvailable: boolean }>>([]);
    const [loading, setLoading] = useState(false);
    const [error, setError] = useState<string | null>(null);

    // Reg form
    const [registrationNumber, setRegistrationNumber] = useState('');
    const [studentName, setStudentName] = useState('');
    const [studentEmail, setStudentEmail] = useState('');

    // WhatsApp form
    const [phoneNumber, setPhoneNumber] = useState('');
    const [otp, setOtp] = useState('');
    const [whatsappStudentName, setWhatsappStudentName] = useState('');

    useEffect(() => {
        let validOrigin = false;
        try {
            const parsedOrigin = new URL(origin);
            const localDevelopment = process.env.NODE_ENV === 'development'
                && parsedOrigin.protocol === 'http:'
                && ['localhost', '127.0.0.1', '[::1]'].includes(parsedOrigin.hostname);
            validOrigin = (parsedOrigin.protocol === 'https:' || localDevelopment)
                && parsedOrigin.origin === origin;
        } catch {
            validOrigin = false;
        }

        if (!apiKey || !vendorId || !validOrigin) {
            setError('Missing or invalid widget configuration. Close and try again from the vendor site.');
            setStep('error');
        }
    }, [apiKey, origin, vendorId]);

    const fetchMethods = useCallback(async () => {
        if (!universityId) return;
        setLoading(true);
        setError(null);
        try {
            const res = await apiClient.get(`/verification/methods/${universityId}`);
            const list = res.data?.data?.methods ?? res.data?.methods ?? [];
            setMethods(Array.isArray(list) ? list : []);
            setStep('method');
        } catch {
            setError('Could not load verification methods.');
        } finally {
            setLoading(false);
        }
    }, [universityId]);

    const handleRegSubmit = async (e: React.FormEvent) => {
        e.preventDefault();
        if (!universityId || !registrationNumber.trim()) return;
        setLoading(true);
        setError(null);
        try {
            const res = await publicApiClient.post('/verification/registration', {
                universityId,
                registrationNumber: registrationNumber.trim(),
                studentName: studentName.trim() || undefined,
                studentEmail: studentEmail.trim() || undefined,
            });
            const data = res.data?.data ?? res.data;
            const tokens = data?.tokens;
            if (!tokens?.accessToken) {
                setError('Verification succeeded but no session. Try again.');
                return;
            }
            storeTokens(tokens);
            await requestWidgetTokenAndPostMessage(data?.studentId);
        } catch (err: unknown) {
            const msg = (err as { response?: { data?: { error?: { message?: string }; message?: string } } })?.response?.data?.error?.message
                || (err as { response?: { data?: { message?: string } } })?.response?.data?.message
                || (err as Error).message
                || 'Verification failed.';
            setError(msg);
        } finally {
            setLoading(false);
        }
    };

    const handleWhatsAppRequest = async (e: React.FormEvent) => {
        e.preventDefault();
        if (!universityId || !phoneNumber.trim()) return;
        setLoading(true);
        setError(null);
        try {
            await publicApiClient.post('/verification/whatsapp/request', {
                universityId,
                phoneNumber: phoneNumber.trim(),
            });
            setStep('whatsapp_verify');
        } catch (err: unknown) {
            const msg = (err as { response?: { data?: { error?: { message?: string } } } })?.response?.data?.error?.message
                || (err as Error).message
                || 'Failed to send OTP.';
            setError(msg);
        } finally {
            setLoading(false);
        }
    };

    const handleWhatsAppVerify = async (e: React.FormEvent) => {
        e.preventDefault();
        if (!otp.trim()) return;
        setLoading(true);
        setError(null);
        try {
            const res = await publicApiClient.post('/verification/whatsapp/verify', {
                phoneNumber: phoneNumber.trim(),
                otp: otp.trim(),
                studentName: whatsappStudentName.trim() || undefined,
            });
            const data = res.data?.data ?? res.data;
            const tokens = data?.tokens;
            if (!tokens?.accessToken) {
                setError('Verification succeeded but no session. Try again.');
                return;
            }
            storeTokens(tokens);
            await requestWidgetTokenAndPostMessage();
        } catch (err: unknown) {
            const msg = (err as { response?: { data?: { error?: { message?: string } } } })?.response?.data?.error?.message
                || (err as Error).message
                || 'Invalid or expired OTP.';
            setError(msg);
        } finally {
            setLoading(false);
        }
    };

    async function requestWidgetTokenAndPostMessage(studentId?: string) {
        try {
            const res = await apiClient.post('/verification/widget/token', {
                vendorId,
                productId: productId || undefined,
                apiKey,
                origin,
            });
            const data = res.data?.data ?? res.data;
            const token = data?.token;
            if (!token) {
                setError('Could not get verification token.');
                return;
            }
            const payload = {
                type: AWOOF_MESSAGE_TYPE,
                token,
                studentId: studentId ?? undefined,
                verifiedAt: new Date().toISOString(),
                method: step === 'reg' ? 'registration' : 'whatsapp',
            };
            if (typeof window !== 'undefined' && window.opener) {
                window.opener.postMessage(payload, origin);
            }
            window.parent.postMessage(payload, origin);
            setStep('success');
        } catch (err: unknown) {
            const msg = (err as { response?: { data?: { error?: { message?: string } } } })?.response?.data?.error?.message
                || (err as Error).message
                || 'Could not get verification token.';
            setError(msg);
        }
    }

    if (step === 'error') {
        return (
            <div className="min-h-screen flex items-center justify-center bg-slate-50 p-4">
                <div className="w-full max-w-md rounded-xl bg-white p-6 shadow-sm">
                    <p className="text-red-600">{error}</p>
                </div>
            </div>
        );
    }

    if (step === 'success') {
        return (
            <div className="min-h-screen flex items-center justify-center bg-slate-50 p-4">
                <div className="w-full max-w-md rounded-xl bg-white p-6 shadow-sm text-center">
                    <p className="text-green-600 font-medium">You’re verified. You can close this window and continue on the vendor site.</p>
                </div>
            </div>
        );
    }

    return (
        <div className="min-h-screen flex items-center justify-center bg-slate-50 p-4">
            <div className="w-full max-w-md rounded-xl bg-white p-6 shadow-sm">
                <h1 className="text-xl font-semibold text-slate-900 mb-2">Verify student status</h1>

                {step === 'ndpr' && (
                    <>
                        <p className="text-slate-600 text-sm mb-4">
                            We need your consent to verify your student status and share the result with the vendor (NDPR compliant).
                        </p>
                        <label className="flex items-start gap-2 cursor-pointer">
                            <input
                                type="checkbox"
                                checked={ndprConsent}
                                onChange={(e) => setNdprConsent(e.target.checked)}
                                className="mt-1"
                            />
                            <span className="text-sm text-slate-700">I consent to the use of my data for student verification and to share the verification result with this vendor.</span>
                        </label>
                        <Button
                            className="w-full mt-6"
                            disabled={!ndprConsent}
                            onClick={() => setStep('university')}
                        >
                            Continue
                        </Button>
                    </>
                )}

                {step === 'university' && (
                    <>
                        <p className="text-slate-600 text-sm mb-4">Select your university.</p>
                        <UniversitySelect
                            value={universityId || ''}
                            onChange={(id) => setUniversityId(id)}
                            required
                        />
                        <Button
                            className="w-full mt-6"
                            disabled={!universityId || loading}
                            onClick={fetchMethods}
                        >
                            {loading ? 'Loading...' : 'Continue'}
                        </Button>
                    </>
                )}

                {step === 'method' && (
                    <>
                        <p className="text-slate-600 text-sm mb-4">Choose how to verify.</p>
                        <div className="space-y-2">
                            {methods.some((m) => m.methodType === 'registration' && m.isAvailable) && (
                                <Button variant="outline" className="w-full" onClick={() => setStep('reg')}>
                                    Registration number
                                </Button>
                            )}
                            {methods.some((m) => m.methodType === 'whatsapp' && m.isAvailable) && (
                                <Button variant="outline" className="w-full" onClick={() => setStep('whatsapp_request')}>
                                    WhatsApp OTP
                                </Button>
                            )}
                            {methods.length === 0 && (
                                <>
                                    <Button variant="outline" className="w-full" onClick={() => setStep('reg')}>
                                        Registration number
                                    </Button>
                                    <Button variant="outline" className="w-full" onClick={() => setStep('whatsapp_request')}>
                                        WhatsApp OTP
                                    </Button>
                                </>
                            )}
                        </div>
                    </>
                )}

                {step === 'reg' && (
                    <form onSubmit={handleRegSubmit} className="space-y-4">
                        <div>
                            <Label htmlFor="regNumber">Registration number *</Label>
                            <Input id="regNumber" value={registrationNumber} onChange={(e) => setRegistrationNumber(e.target.value)} placeholder="e.g. 2019/12345" required />
                        </div>
                        <div>
                            <Label htmlFor="name">Full name (optional)</Label>
                            <Input id="name" value={studentName} onChange={(e) => setStudentName(e.target.value)} placeholder="Your name" />
                        </div>
                        <div>
                            <Label htmlFor="email">Student email (optional)</Label>
                            <Input id="email" type="email" value={studentEmail} onChange={(e) => setStudentEmail(e.target.value)} placeholder="you@university.edu" />
                        </div>
                        {error && <p className="text-sm text-red-600">{error}</p>}
                        <Button type="submit" className="w-full" disabled={loading}>
                            {loading ? 'Verifying...' : 'Verify'}
                        </Button>
                    </form>
                )}

                {step === 'whatsapp_request' && (
                    <form onSubmit={handleWhatsAppRequest} className="space-y-4">
                        <div>
                            <Label htmlFor="phone">Phone number (WhatsApp) *</Label>
                            <Input id="phone" value={phoneNumber} onChange={(e) => setPhoneNumber(e.target.value)} placeholder="+234..." required />
                        </div>
                        {error && <p className="text-sm text-red-600">{error}</p>}
                        <Button type="submit" className="w-full" disabled={loading}>
                            {loading ? 'Sending...' : 'Send OTP'}
                        </Button>
                    </form>
                )}

                {step === 'whatsapp_verify' && (
                    <form onSubmit={handleWhatsAppVerify} className="space-y-4">
                        <p className="text-slate-600 text-sm">Enter the 6-digit code sent to your WhatsApp.</p>
                        <div>
                            <Label htmlFor="otp">Verification code *</Label>
                            <Input id="otp" value={otp} onChange={(e) => setOtp(e.target.value)} placeholder="000000" maxLength={6} required />
                        </div>
                        <div>
                            <Label htmlFor="waName">Your name (optional)</Label>
                            <Input id="waName" value={whatsappStudentName} onChange={(e) => setWhatsappStudentName(e.target.value)} placeholder="Full name" />
                        </div>
                        {error && <p className="text-sm text-red-600">{error}</p>}
                        <Button type="submit" className="w-full" disabled={loading}>
                            {loading ? 'Verifying...' : 'Verify'}
                        </Button>
                    </form>
                )}
            </div>
        </div>
    );
}

export default function WidgetVerifyPage() {
    return (
        <Suspense fallback={<div className="min-h-screen flex items-center justify-center bg-slate-50"><div className="animate-pulse text-slate-500">Loading...</div></div>}>
            <WidgetVerifyContent />
        </Suspense>
    );
}
