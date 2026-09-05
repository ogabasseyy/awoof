/**
 * Admin Settings & Profile
 *
 * Profile info (from /auth/me) and change password (/auth/update-password).
 */

'use client';

import { useState, useEffect } from 'react';
import { User, Lock, Save, Percent } from 'lucide-react';
import ProtectedRoute from '@/components/ProtectedRoute';
import { useAuth } from '@/contexts/AuthContext';
import { DashboardLayout } from '@/components/dashboard';
import type { User as AuthUser } from '@/lib/auth';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import apiClient from '@/lib/api-client';
import { primaryNavItems, secondaryNavItems } from '../adminNav';

interface MeData {
    id: string;
    email: string;
    role: string;
    verificationStatus?: string;
    profile?: unknown;
}

type TabId = 'profile' | 'password' | 'platform';

export default function AdminSettingsPage() {
    const { user, logout } = useAuth();
    const [activeTab, setActiveTab] = useState<TabId>('profile');
    const [me, setMe] = useState<MeData | null>(null);
    const [loading, setLoading] = useState(true);
    const [error, setError] = useState<string | null>(null);
    const [success, setSuccess] = useState<string | null>(null);

    // Password form
    const [currentPassword, setCurrentPassword] = useState('');
    const [newPassword, setNewPassword] = useState('');
    const [confirmPassword, setConfirmPassword] = useState('');
    const [savingPassword, setSavingPassword] = useState(false);

    // Platform settings
    const [platformFeePercent, setPlatformFeePercent] = useState<number>(10);
    const [loadingPlatform, setLoadingPlatform] = useState(true);
    const [platformLoadError, setPlatformLoadError] = useState<string | null>(null);
    const [savingPlatform, setSavingPlatform] = useState(false);

    useEffect(() => {
        let cancelled = false;
        (async () => {
            try {
                setLoading(true);
                setError(null);
                const res = await apiClient.get('/auth/me');
                if (!cancelled) setMe(res.data.data ?? null);
            } catch (e) {
                if (!cancelled) {
                    setError('Failed to load profile');
                    setMe(null);
                }
            } finally {
                if (!cancelled) setLoading(false);
            }
        })();
        return () => {
            cancelled = true;
        };
    }, []);

    // Fetch platform settings
    useEffect(() => {
        let cancelled = false;
        (async () => {
            try {
                setLoadingPlatform(true);
                setPlatformLoadError(null);
                const res = await apiClient.get('/admin/settings/platform');
                if (!cancelled && res.data?.data?.platform_fee_percent != null) {
                    setPlatformFeePercent(Number(res.data.data.platform_fee_percent));
                }
            } catch {
                if (!cancelled) setPlatformLoadError('Could not load the current platform fee. Refresh to retry.');
            } finally {
                if (!cancelled) setLoadingPlatform(false);
            }
        })();
        return () => { cancelled = true; };
    }, []);

    const handleSavePlatformFee = async (e: React.FormEvent) => {
        e.preventDefault();
        setError(null);
        setSuccess(null);
        setSavingPlatform(true);
        try {
            await apiClient.put('/admin/settings/platform', { platform_fee_percent: platformFeePercent });
            setSuccess('Platform fee updated.');
        } catch (err: unknown) {
            const ax = err as { response?: { data?: { error?: { message?: string } } } };
            setError(ax.response?.data?.error?.message ?? 'Failed to update platform fee');
        } finally {
            setSavingPlatform(false);
        }
    };

    const handleLogout = async () => {
        await logout();
    };

    const handleChangePassword = async (e: React.FormEvent) => {
        e.preventDefault();
        setError(null);
        setSuccess(null);
        if (newPassword !== confirmPassword) {
            setError('New password and confirmation do not match');
            return;
        }
        if (newPassword.length < 8) {
            setError('New password must be at least 8 characters');
            return;
        }
        setSavingPassword(true);
        try {
            await apiClient.post('/auth/update-password', {
                oldPassword: currentPassword,
                newPassword,
            });
            setSuccess('Password updated successfully.');
            setCurrentPassword('');
            setNewPassword('');
            setConfirmPassword('');
        } catch (err: unknown) {
            const ax = err as { response?: { data?: { error?: { message?: string } } } };
            setError(ax.response?.data?.error?.message ?? 'Failed to update password');
        } finally {
            setSavingPassword(false);
        }
    };

    if (loading) {
        return (
            <ProtectedRoute requiredRole="admin">
                <DashboardLayout
                    navItems={primaryNavItems}
                    secondaryNavItems={secondaryNavItems}
                    pageTitle="Settings"
                    user={user as AuthUser}
                    onLogout={handleLogout}
                    logoutLabel="Logout"
                >
                    <p className="text-slate-500">Loading settings...</p>
                </DashboardLayout>
            </ProtectedRoute>
        );
    }

    return (
        <ProtectedRoute requiredRole="admin">
            <DashboardLayout
                navItems={primaryNavItems}
                secondaryNavItems={secondaryNavItems}
                pageTitle="Settings"
                user={user as AuthUser}
                onLogout={handleLogout}
                logoutLabel="Logout"
            >
                <div className="space-y-6">
                    {/* Tabs */}
                    <div className="border-b border-slate-200">
                        <nav className="-mb-px flex gap-6">
                            <button
                                type="button"
                                onClick={() => { setActiveTab('profile'); setError(null); setSuccess(null); }}
                                className={`whitespace-nowrap border-b-2 px-1 py-4 text-sm font-medium ${activeTab === 'profile'
                                        ? 'border-slate-900 text-slate-900'
                                        : 'border-transparent text-slate-500 hover:border-slate-300 hover:text-slate-700'
                                    }`}
                            >
                                <User className="mr-2 inline h-4 w-4" />
                                Profile
                            </button>
                            <button
                                type="button"
                                onClick={() => { setActiveTab('password'); setError(null); setSuccess(null); }}
                                className={`whitespace-nowrap border-b-2 px-1 py-4 text-sm font-medium ${activeTab === 'password'
                                        ? 'border-slate-900 text-slate-900'
                                        : 'border-transparent text-slate-500 hover:border-slate-300 hover:text-slate-700'
                                    }`}
                            >
                                <Lock className="mr-2 inline h-4 w-4" />
                                Password
                            </button>
                            <button
                                type="button"
                                onClick={() => { setActiveTab('platform'); setError(null); setSuccess(null); }}
                                className={`whitespace-nowrap border-b-2 px-1 py-4 text-sm font-medium ${activeTab === 'platform'
                                        ? 'border-slate-900 text-slate-900'
                                        : 'border-transparent text-slate-500 hover:border-slate-300 hover:text-slate-700'
                                    }`}
                            >
                                <Percent className="mr-2 inline h-4 w-4" />
                                Platform fee
                            </button>
                        </nav>
                    </div>

                    {error && (
                        <div className="rounded-lg border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-700">
                            {error}
                        </div>
                    )}
                    {success && (
                        <div className="rounded-lg border border-green-200 bg-green-50 px-4 py-3 text-sm text-green-700">
                            {success}
                        </div>
                    )}

                    {activeTab === 'profile' && (
                        <div className="rounded-lg bg-white p-6 shadow-sm">
                            <h2 className="text-lg font-semibold text-slate-900">Profile</h2>
                            <p className="mt-1 text-sm text-slate-500">Your admin account details (from /auth/me).</p>
                            <dl className="mt-6 grid gap-4 sm:grid-cols-1">
                                <div>
                                    <Label className="text-slate-600">Email</Label>
                                    <p className="mt-1 text-slate-900">{me?.email ?? '—'}</p>
                                </div>
                                <div>
                                    <Label className="text-slate-600">Role</Label>
                                    <p className="mt-1 capitalize text-slate-900">{me?.role ?? '—'}</p>
                                </div>
                            </dl>
                        </div>
                    )}

                    {activeTab === 'password' && (
                        <div className="rounded-lg bg-white p-6 shadow-sm">
                            <h2 className="text-lg font-semibold text-slate-900">Change password</h2>
                            <p className="mt-1 text-sm text-slate-500">Update your password. You will need your current password.</p>
                            <form onSubmit={handleChangePassword} className="mt-6 max-w-md space-y-4">
                                <div>
                                    <Label htmlFor="current-password">Current password</Label>
                                    <Input
                                        id="current-password"
                                        type="password"
                                        autoComplete="current-password"
                                        value={currentPassword}
                                        onChange={(e) => setCurrentPassword(e.target.value)}
                                        className="mt-1"
                                        required
                                    />
                                </div>
                                <div>
                                    <Label htmlFor="new-password">New password</Label>
                                    <Input
                                        id="new-password"
                                        type="password"
                                        autoComplete="new-password"
                                        value={newPassword}
                                        onChange={(e) => setNewPassword(e.target.value)}
                                        className="mt-1"
                                        minLength={8}
                                        required
                                    />
                                    <p className="mt-1 text-xs text-slate-500">At least 8 characters.</p>
                                </div>
                                <div>
                                    <Label htmlFor="confirm-password">Confirm new password</Label>
                                    <Input
                                        id="confirm-password"
                                        type="password"
                                        autoComplete="new-password"
                                        value={confirmPassword}
                                        onChange={(e) => setConfirmPassword(e.target.value)}
                                        className="mt-1"
                                        minLength={8}
                                        required
                                    />
                                </div>
                                <Button type="submit" disabled={savingPassword}>
                                    <Save className="mr-2 h-4 w-4" />
                                    {savingPassword ? 'Updating…' : 'Update password'}
                                </Button>
                            </form>
                        </div>
                    )}

                    {activeTab === 'platform' && (
                        <div className="rounded-lg bg-white p-6 shadow-sm">
                            <h2 className="text-lg font-semibold text-slate-900">Platform fee</h2>
                            <p className="mt-1 text-sm text-slate-500">
                                Percentage of the discounted (student) total that Awoof keeps when payment is processed by Awoof. The rest goes to the vendor.
                            </p>
                            {loadingPlatform ? (
                                <p className="mt-4 text-slate-500">Loading...</p>
                            ) : (
                                <form onSubmit={handleSavePlatformFee} className="mt-6 max-w-md space-y-4">
                                    {platformLoadError && <p className="text-sm text-red-600">{platformLoadError}</p>}
                                    <div>
                                        <Label htmlFor="platform_fee">Platform fee (%)</Label>
                                        <Input
                                            id="platform_fee"
                                            type="number"
                                            min={0}
                                            max={100}
                                            step={0.5}
                                            value={platformFeePercent}
                                            onChange={(e) => setPlatformFeePercent(Number(e.target.value))}
                                            className="mt-1 w-32"
                                            disabled={Boolean(platformLoadError)}
                                        />
                                    </div>
                                    <Button type="submit" disabled={savingPlatform || Boolean(platformLoadError)}>
                                        <Save className="mr-2 h-4 w-4" />
                                        {savingPlatform ? 'Saving…' : 'Save'}
                                    </Button>
                                </form>
                            )}
                        </div>
                    )}
                </div>
            </DashboardLayout>
        </ProtectedRoute>
    );
}
