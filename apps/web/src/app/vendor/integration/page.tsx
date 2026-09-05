/**
 * Vendor Integration Page
 * 
 * Integration guide and configuration for vendors
 */

'use client';

import { useState, useEffect } from 'react';
import { BarChart3, CreditCard, LayoutDashboard, LifeBuoy, Puzzle, Settings, ShoppingBag, Tag, Code, Key, Copy, Check, BookOpen, Webhook, CheckCircle2, AlertCircle } from 'lucide-react';
import ProtectedRoute from '@/components/ProtectedRoute';
import { useAuth } from '@/contexts/AuthContext';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { DashboardLayout } from '@/components/dashboard';
import type { User } from '@/lib/auth';
import apiClient from '@/lib/api-client';
import toast from 'react-hot-toast';
import { useConfirm } from '@/components/ui/ConfirmDialog';
import { getApiErrorMessage } from '@/lib/api-error';

const iconProps = { className: 'h-5 w-5', strokeWidth: 1.5, fill: 'currentColor' as const };

const primaryNavItems = [
    { id: 'dashboard', label: 'Dashboard', href: '/vendor/dashboard', icon: <LayoutDashboard {...iconProps} /> },
    { id: 'manage-deals', label: 'Manage Deals', href: '/vendor/deals', icon: <Tag {...iconProps} /> },
    { id: 'orders', label: 'Orders', href: '/vendor/orders', icon: <ShoppingBag {...iconProps} /> },
    { id: 'analytics', label: 'Analytics', href: '/vendor/analytics', icon: <BarChart3 {...iconProps} /> },
    { id: 'payment', label: 'Payment', href: '/vendor/payment', icon: <CreditCard {...iconProps} /> },
    { id: 'integration', label: 'Integration', href: '/vendor/integration', icon: <Puzzle {...iconProps} /> },
];

const secondaryNavItems = [
    { id: 'support', label: 'Support', href: '/vendor/support', icon: <LifeBuoy {...iconProps} /> },
    { id: 'settings', label: 'Settings', href: '/vendor/settings', icon: <Settings {...iconProps} /> },
];

interface ApiKeyInfo {
    hasApiKey: boolean;
    keyInfo?: {
        name: string;
        rateLimit: number;
        usageCount: number;
        createdAt: string;
        expiresAt: string | null;
        status: string;
    };
}

interface PaymentSettings {
    paymentMethod: 'awoof' | 'vendor_website' | null;
    paystackSubaccountCode: string | null;
}

interface WidgetConfig {
    vendorId: string;
    allowedDomains: string[];
    apiKey: string;
    status: string;
}

export default function VendorIntegrationPage() {
    const { user, logout } = useAuth();
    const confirm = useConfirm();
    const [apiKey, setApiKey] = useState<string | null>(null);
    const [apiKeyInfo, setApiKeyInfo] = useState<ApiKeyInfo | null>(null);
    const [isGeneratingApiKey, setIsGeneratingApiKey] = useState(false);
    const [isLoading, setIsLoading] = useState(true);
    const [copiedText, setCopiedText] = useState<string | null>(null);
    const [paymentSettings, setPaymentSettings] = useState<PaymentSettings | null>(null);
    const [activeTab, setActiveTab] = useState<'overview' | 'widget' | 'api' | 'webhook'>('overview');
    const [widgetConfig, setWidgetConfig] = useState<WidgetConfig | null>(null);
    const [widgetConfigLoading, setWidgetConfigLoading] = useState(false);
    const [newDomain, setNewDomain] = useState('');
    const [savingWidgetConfig, setSavingWidgetConfig] = useState(false);

    type VendorProfile = { companyName?: string | null; name?: string | null };
    const extendedUser = user as (User & { profile?: VendorProfile }) | null;
    const companyName = extendedUser?.profile?.companyName ?? null;
    const displayName = companyName ?? extendedUser?.profile?.name ?? extendedUser?.email ?? 'Vendor';

    // Get API base URL
    const apiBaseUrl = process.env.NEXT_PUBLIC_API_URL || 'http://localhost:5001';
    const webAppUrl = typeof window !== 'undefined' ? window.location.origin : '';

    useEffect(() => {
        fetchIntegrationData();
    }, []);

    useEffect(() => {
        if (activeTab === 'widget') {
            fetchWidgetConfig();
        }
    }, [activeTab]);

    const fetchWidgetConfig = async () => {
        try {
            setWidgetConfigLoading(true);
            const res = await apiClient.get('/vendors/widget-config');
            setWidgetConfig(res.data?.data ?? null);
        } catch {
            setWidgetConfig(null);
        } finally {
            setWidgetConfigLoading(false);
        }
    };

    const fetchIntegrationData = async () => {
        try {
            setIsLoading(true);
            const [apiKeyRes, settingsRes] = await Promise.all([
                apiClient.get('/vendors/payment/api-key').catch(() => ({ data: { data: { hasApiKey: false } } })),
                apiClient.get('/vendors/payment/settings').catch(() => null),
            ]);

            setApiKeyInfo(apiKeyRes.data.data);

            // If API key exists but not shown, indicate it exists
            if (apiKeyRes.data.data.hasApiKey && !apiKeyRes.data.data.apiKey) {
                setApiKey('***hidden***');
            }

            if (settingsRes?.data?.data?.settings) {
                setPaymentSettings({
                    paymentMethod: settingsRes.data.data.settings.paymentMethod || null,
                    paystackSubaccountCode: settingsRes.data.data.settings.paystackSubaccountCode || null,
                });
            }
        } catch (error: unknown) {
            console.error('Error fetching integration data:', error);
        } finally {
            setIsLoading(false);
        }
    };

    const handleGenerateApiKey = async () => {
        const ok = await confirm({
            title: 'Generate new API key?',
            description: 'This will revoke your existing key. Copy the new key immediately — it will not be shown again.',
            confirmLabel: 'Generate key',
            variant: 'destructive',
        });
        if (!ok) return;

        try {
            setIsGeneratingApiKey(true);
            const response = await apiClient.post('/vendors/payment/api-key');
            const newApiKey = response.data.data.apiKey;
            setApiKey(newApiKey);
            toast.success('API key generated — copy it now');
            await fetchIntegrationData();
        } catch (error: unknown) {
            console.error('Error generating API key:', error);
            toast.error(getApiErrorMessage(error, 'Failed to generate API key'));
        } finally {
            setIsGeneratingApiKey(false);
        }
    };

    const copyToClipboard = async (text: string, label: string) => {
        try {
            await navigator.clipboard.writeText(text);
            setCopiedText(label);
            setTimeout(() => setCopiedText(null), 2000);
        } catch (error) {
            console.error('Failed to copy:', error);
        }
    };

    const getIntegrationStatus = () => {
        const hasApiKey = apiKeyInfo?.hasApiKey || false;
        const hasPaymentMethod = paymentSettings?.paymentMethod === 'vendor_website';
        const hasPaystackConfig = !!paymentSettings?.paystackSubaccountCode;

        if (hasPaymentMethod && hasApiKey && hasPaystackConfig) {
            return { status: 'complete', message: 'Integration fully configured' };
        } else if (hasPaymentMethod && (hasApiKey || hasPaystackConfig)) {
            return { status: 'partial', message: 'Integration partially configured' };
        } else if (hasPaymentMethod) {
            return { status: 'started', message: 'Payment method selected, setup required' };
        } else {
            return { status: 'not_started', message: 'Integration not started' };
        }
    };

    if (isLoading) {
        return (
            <ProtectedRoute requiredRole="vendor">
                <DashboardLayout
                    navItems={primaryNavItems}
                    secondaryNavItems={secondaryNavItems}
                    pageTitle="Integration"
                    onLogout={logout}
                    logoutLabel="Log out"
                    user={{
                        name: displayName,
                        email: user?.email ?? null,
                        roleLabel: 'Vendor',
                        secondaryText: companyName ?? undefined,
                        profileHref: '/vendor/settings/profile',
                        avatarUrl: null,
                    }}
                >
                    <div className="flex items-center justify-center rounded-2xl bg-white p-12 shadow-sm">
                        <p className="text-slate-500">Loading integration settings...</p>
                    </div>
                </DashboardLayout>
            </ProtectedRoute>
        );
    }

    const integrationStatus = getIntegrationStatus();

    return (
        <ProtectedRoute requiredRole="vendor">
            <DashboardLayout
                navItems={primaryNavItems}
                secondaryNavItems={secondaryNavItems}
                pageTitle="Integration"
                onLogout={logout}
                logoutLabel="Log out"
                user={{
                    name: displayName,
                    email: user?.email ?? null,
                    roleLabel: 'Vendor',
                    secondaryText: companyName ?? undefined,
                    profileHref: '/vendor/settings/profile',
                    avatarUrl: null,
                }}
            >
                <div className="space-y-6">
                    {/* Integration Status */}
                    <div className={`rounded-2xl border p-6 shadow-sm ${integrationStatus.status === 'complete' ? 'border-green-200 bg-green-50' :
                        integrationStatus.status === 'partial' ? 'border-yellow-200 bg-yellow-50' :
                            integrationStatus.status === 'started' ? 'border-blue-200 bg-blue-50' :
                                'border-slate-200 bg-white'
                        }`}>
                        <div className="flex items-center gap-3">
                            {integrationStatus.status === 'complete' ? (
                                <CheckCircle2 className="h-6 w-6 text-green-600" />
                            ) : integrationStatus.status === 'partial' ? (
                                <AlertCircle className="h-6 w-6 text-yellow-600" />
                            ) : (
                                <AlertCircle className="h-6 w-6 text-slate-400" />
                            )}
                            <div>
                                <h2 className="text-lg font-semibold text-slate-900">Integration Status</h2>
                                <p className="text-sm text-slate-600">{integrationStatus.message}</p>
                            </div>
                        </div>
                    </div>

                    {/* Tabs */}
                    <div className="border-b border-slate-200">
                        <nav className="-mb-px flex space-x-8">
                            <button
                                onClick={() => setActiveTab('overview')}
                                className={`whitespace-nowrap border-b-2 px-1 py-4 text-sm font-medium ${activeTab === 'overview'
                                    ? 'border-blue-500 text-blue-600'
                                    : 'border-transparent text-slate-500 hover:border-slate-300 hover:text-slate-700'
                                    }`}
                            >
                                Overview
                            </button>
                            <button
                                onClick={() => setActiveTab('widget')}
                                className={`whitespace-nowrap border-b-2 px-1 py-4 text-sm font-medium ${activeTab === 'widget'
                                    ? 'border-blue-500 text-blue-600'
                                    : 'border-transparent text-slate-500 hover:border-slate-300 hover:text-slate-700'
                                    }`}
                            >
                                Widget Integration
                            </button>
                            <button
                                onClick={() => setActiveTab('api')}
                                className={`whitespace-nowrap border-b-2 px-1 py-4 text-sm font-medium ${activeTab === 'api'
                                    ? 'border-blue-500 text-blue-600'
                                    : 'border-transparent text-slate-500 hover:border-slate-300 hover:text-slate-700'
                                    }`}
                            >
                                API Configuration
                            </button>
                            <button
                                onClick={() => setActiveTab('webhook')}
                                className={`whitespace-nowrap border-b-2 px-1 py-4 text-sm font-medium ${activeTab === 'webhook'
                                    ? 'border-blue-500 text-blue-600'
                                    : 'border-transparent text-slate-500 hover:border-slate-300 hover:text-slate-700'
                                    }`}
                            >
                                Webhook Setup
                            </button>
                        </nav>
                    </div>

                    {/* Overview Tab */}
                    {activeTab === 'overview' && (
                        <div className="space-y-6">
                            <div className="rounded-2xl border border-slate-200 bg-white p-6 shadow-sm">
                                <h2 className="mb-4 text-lg font-semibold text-slate-900">Quick Start Guide</h2>
                                <div className="space-y-4">
                                    <div className="flex items-start gap-4">
                                        <div className="flex h-8 w-8 items-center justify-center rounded-full bg-blue-100 text-sm font-semibold text-blue-600">
                                            1
                                        </div>
                                        <div className="flex-1">
                                            <h3 className="font-semibold text-slate-900">Choose Payment Method</h3>
                                            <p className="mt-1 text-sm text-slate-600">
                                                Go to{' '}
                                                <a href="/vendor/payment" className="text-blue-600 hover:underline">
                                                    Payment Settings
                                                </a>{' '}
                                                and select &quot;Vendor Website&quot; as your payment method.
                                            </p>
                                        </div>
                                    </div>

                                    <div className="flex items-start gap-4">
                                        <div className="flex h-8 w-8 items-center justify-center rounded-full bg-blue-100 text-sm font-semibold text-blue-600">
                                            2
                                        </div>
                                        <div className="flex-1">
                                            <h3 className="font-semibold text-slate-900">Add Widget to Your Website</h3>
                                            <p className="mt-1 text-sm text-slate-600">
                                                Add the Awoof verification widget to your website. See the &quot;Widget Integration&quot; tab for detailed instructions.
                                            </p>
                                        </div>
                                    </div>

                                    <div className="flex items-start gap-4">
                                        <div className="flex h-8 w-8 items-center justify-center rounded-full bg-blue-100 text-sm font-semibold text-blue-600">
                                            3
                                        </div>
                                        <div className="flex-1">
                                            <h3 className="font-semibold text-slate-900">Configure Payment Tracking</h3>
                                            <p className="mt-1 text-sm text-slate-600">
                                                Set up either Paystack split payment (recommended) or use the Transaction Reporting API. See the &quot;Webhook Setup&quot; and &quot;API Configuration&quot; tabs.
                                            </p>
                                        </div>
                                    </div>

                                    <div className="flex items-start gap-4">
                                        <div className="flex h-8 w-8 items-center justify-center rounded-full bg-blue-100 text-sm font-semibold text-blue-600">
                                            4
                                        </div>
                                        <div className="flex-1">
                                            <h3 className="font-semibold text-slate-900">Test Integration</h3>
                                            <p className="mt-1 text-sm text-slate-600">
                                                Test the complete flow: student verification → discount application → payment processing → transaction tracking.
                                            </p>
                                        </div>
                                    </div>
                                </div>
                            </div>

                            <div className="grid gap-4 md:grid-cols-2">
                                <div className="rounded-2xl border border-slate-200 bg-white p-6 shadow-sm">
                                    <div className="flex items-center gap-3">
                                        <Code className="h-6 w-6 text-blue-600" />
                                        <h3 className="text-lg font-semibold text-slate-900">Widget Status</h3>
                                    </div>
                                    <p className="mt-2 text-sm text-slate-600">
                                        {paymentSettings?.paymentMethod === 'vendor_website'
                                            ? 'Ready to integrate widget'
                                            : 'Select &quot;Vendor Website&quot; payment method first'}
                                    </p>
                                </div>

                                <div className="rounded-2xl border border-slate-200 bg-white p-6 shadow-sm">
                                    <div className="flex items-center gap-3">
                                        <Key className="h-6 w-6 text-blue-600" />
                                        <h3 className="text-lg font-semibold text-slate-900">API Key Status</h3>
                                    </div>
                                    <p className="mt-2 text-sm text-slate-600">
                                        {apiKeyInfo?.hasApiKey
                                            ? `Active (${apiKeyInfo.keyInfo?.usageCount || 0} requests)`
                                            : 'No API key generated'}
                                    </p>
                                </div>
                            </div>
                        </div>
                    )}

                    {/* Widget Integration Tab */}
                    {activeTab === 'widget' && (
                        <div className="space-y-6">
                            {/* Widget config: allowed domains + API key */}
                            <div className="rounded-2xl border border-slate-200 bg-white p-6 shadow-sm">
                                <h2 className="mb-2 text-lg font-semibold text-slate-900">Widget settings</h2>
                                <p className="mb-4 text-sm text-slate-600">
                                    Add the domains where your widget will run. Only these domains can use your widget API key.
                                </p>
                                {widgetConfigLoading ? (
                                    <p className="text-slate-500 text-sm">Loading...</p>
                                ) : widgetConfig ? (
                                    <div className="space-y-4">
                                        <div>
                                            <Label className="mb-2 block">Widget API key</Label>
                                            <div className="flex gap-2">
                                                <Input
                                                    value={widgetConfig.apiKey}
                                                    readOnly
                                                    className="flex-1 font-mono text-sm"
                                                />
                                                <Button type="button" variant="outline" size="sm" onClick={() => copyToClipboard(widgetConfig.apiKey, 'widget-api-key')}>
                                                    {copiedText === 'widget-api-key' ? <Check className="h-4 w-4" /> : <Copy className="h-4 w-4" />}
                                                </Button>
                                            </div>
                                            <p className="mt-1 text-xs text-slate-500">Use this in Awoof.init(&#123; apiKey: &quot;...&quot; &#125;). Keep it secret.</p>
                                        </div>
                                        <div>
                                            <Label className="mb-2 block">Allowed domains</Label>
                                            <ul className="mb-2 rounded-lg border border-slate-200 divide-y divide-slate-200">
                                                {(widgetConfig.allowedDomains || []).map((d) => (
                                                    <li key={d} className="flex items-center justify-between px-3 py-2 text-sm">
                                                        <span className="font-mono">{d}</span>
                                                        <Button
                                                            type="button"
                                                            variant="ghost"
                                                            size="sm"
                                                            className="text-red-600 hover:text-red-700"
                                                            onClick={async () => {
                                                                const next = (widgetConfig.allowedDomains || []).filter((x) => x !== d);
                                                                if (next.length === 0) return;
                                                                setSavingWidgetConfig(true);
                                                                try {
                                                                    await apiClient.put('/vendors/widget-config', { allowedDomains: next });
                                                                    await fetchWidgetConfig();
                                                                } finally {
                                                                    setSavingWidgetConfig(false);
                                                                }
                                                            }}
                                                            disabled={savingWidgetConfig || (widgetConfig.allowedDomains?.length ?? 0) <= 1}
                                                        >
                                                            Remove
                                                        </Button>
                                                    </li>
                                                ))}
                                            </ul>
                                            <div className="flex gap-2">
                                                <Input
                                                    placeholder="example.com"
                                                    value={newDomain}
                                                    onChange={(e) => setNewDomain(e.target.value)}
                                                    onKeyDown={(e) => e.key === 'Enter' && (e.preventDefault(), document.getElementById('add-domain-btn')?.click())}
                                                    className="font-mono"
                                                />
                                                <Button
                                                    id="add-domain-btn"
                                                    type="button"
                                                    variant="outline"
                                                    disabled={savingWidgetConfig || !newDomain.trim()}
                                                    onClick={async () => {
                                                        const domain = newDomain.replace(/^https?:\/\//, '').split('/')[0].toLowerCase().trim();
                                                        if (!domain) return;
                                                        const current = widgetConfig.allowedDomains || [];
                                                        if (current.includes(domain)) {
                                                            setNewDomain('');
                                                            return;
                                                        }
                                                        setSavingWidgetConfig(true);
                                                        try {
                                                            await apiClient.put('/vendors/widget-config', { allowedDomains: [...current, domain] });
                                                            setNewDomain('');
                                                            await fetchWidgetConfig();
                                                        } finally {
                                                            setSavingWidgetConfig(false);
                                                        }
                                                    }}
                                                >
                                                    Add domain
                                                </Button>
                                            </div>
                                        </div>
                                    </div>
                                ) : (
                                    <p className="text-slate-500 text-sm">Could not load widget config.</p>
                                )}
                            </div>

                            <div className="rounded-2xl border border-slate-200 bg-white p-6 shadow-sm">
                                <h2 className="mb-4 text-lg font-semibold text-slate-900">Widget Integration</h2>
                                <p className="mb-6 text-sm text-slate-600">
                                    Add the Awoof verification widget to your website to verify students and apply discounts.
                                </p>

                                <div className="space-y-6">
                                    <div>
                                        <h3 className="mb-2 font-semibold text-slate-900">Step 1: Add Widget Script</h3>
                                        <p className="mb-3 text-sm text-slate-600">
                                            Add this script tag to your website&apos;s HTML, preferably in the <code className="rounded bg-slate-100 px-1 py-0.5 text-xs">&lt;head&gt;</code> section:
                                        </p>
                                        <div className="flex gap-2">
                                            <Input
                                                value='<script src="https://widget.awoof.com/awoof.js"></script>'
                                                readOnly
                                                className="flex-1 font-mono text-xs"
                                            />
                                            <Button
                                                type="button"
                                                variant="outline"
                                                size="sm"
                                                onClick={() => copyToClipboard(
                                                    '<script src="https://widget.awoof.com/awoof.js"></script>',
                                                    'widget-script'
                                                )}
                                            >
                                                {copiedText === 'widget-script' ? (
                                                    <Check className="h-4 w-4" />
                                                ) : (
                                                    <Copy className="h-4 w-4" />
                                                )}
                                            </Button>
                                        </div>
                                    </div>

                                    <div>
                                        <h3 className="mb-2 font-semibold text-slate-900">Step 2: Initialize and verify</h3>
                                        <p className="mb-3 text-sm text-slate-600">
                                            Initialize the widget with your API key and web app URL, then call verify to open the student verification flow:
                                        </p>
                                        <div className="relative">
                                            <pre className="overflow-x-auto rounded-lg bg-slate-900 p-4 text-xs text-slate-100">
                                                {`// After script loads, initialize once (e.g. on page load)
Awoof.init({
  apiKey: 'YOUR_WIDGET_API_KEY',  // From Widget settings above
  apiBaseUrl: '${apiBaseUrl}',  // Your backend API URL
  webAppUrl: '${webAppUrl}',   // Awoof web app (for verification iframe)
  onSuccess: (token, data) => {
    applyStudentDiscount();
    window.verificationToken = token;
  },
  onError: (err) => console.error('Verification error', err),
  onCancel: () => console.log('User closed verification'),
});

// When user clicks "Verify student" (e.g. on checkout)
function onVerifyStudentClick() {
  Awoof.verify();
}`}
                                            </pre>
                                            <Button
                                                type="button"
                                                variant="outline"
                                                size="sm"
                                                className="absolute right-2 top-2"
                                                onClick={() => copyToClipboard(
                                                    `Awoof.init({
  apiKey: 'YOUR_WIDGET_API_KEY',
  apiBaseUrl: '${apiBaseUrl}',
  webAppUrl: '${webAppUrl}',
  onSuccess: (token) => { applyStudentDiscount(); window.verificationToken = token; },
  onError: (err) => console.error(err),
});
function onVerifyStudentClick() { Awoof.verify(); }`,
                                                    'widget-code'
                                                )}
                                            >
                                                {copiedText === 'widget-code' ? (
                                                    <Check className="h-4 w-4" />
                                                ) : (
                                                    <Copy className="h-4 w-4" />
                                                )}
                                            </Button>
                                        </div>
                                        <p className="mt-2 text-xs text-slate-500">Add your site&apos;s domain in &quot;Allowed domains&quot; above first, or the widget will show an error.</p>
                                    </div>

                                    <div>
                                        <h3 className="mb-2 font-semibold text-slate-900">Step 3: Apply Discount</h3>
                                        <p className="mb-3 text-sm text-slate-600">
                                            After successful verification, apply the student discount:
                                        </p>
                                        <div className="relative">
                                            <pre className="overflow-x-auto rounded-lg bg-slate-900 p-4 text-xs text-slate-100">
                                                {`function applyStudentDiscount() {
  // Calculate discount (e.g., 10% off)
  const discountPercent = 10;
  const originalPrice = getCartTotal();
  const discountAmount = originalPrice * (discountPercent / 100);
  const finalPrice = originalPrice - discountAmount;
  
  // Update cart with discounted price
  updateCartPrice(finalPrice);
  
  // Show discount message
  showMessage('Student discount applied!');
}`}
                                            </pre>
                                            <Button
                                                type="button"
                                                variant="outline"
                                                size="sm"
                                                className="absolute right-2 top-2"
                                                onClick={() => copyToClipboard(
                                                    `function applyStudentDiscount() {
  // Calculate discount (e.g., 10% off)
  const discountPercent = 10;
  const originalPrice = getCartTotal();
  const discountAmount = originalPrice * (discountPercent / 100);
  const finalPrice = originalPrice - discountAmount;
  
  // Update cart with discounted price
  updateCartPrice(finalPrice);
  
  // Show discount message
  showMessage('Student discount applied!');
}`,
                                                    'discount-code'
                                                )}
                                            >
                                                {copiedText === 'discount-code' ? (
                                                    <Check className="h-4 w-4" />
                                                ) : (
                                                    <Copy className="h-4 w-4" />
                                                )}
                                            </Button>
                                        </div>
                                    </div>

                                    <div className="rounded-lg bg-blue-50 p-4">
                                        <div className="flex items-start gap-2">
                                            <BookOpen className="mt-0.5 h-5 w-5 text-blue-600" />
                                            <div>
                                                <h3 className="font-semibold text-blue-900">Need More Help?</h3>
                                                <p className="mt-1 text-sm text-blue-800">
                                                    Check out our{' '}
                                                    <a href="/docs/widget" className="underline hover:text-blue-900">
                                                        widget documentation
                                                    </a>{' '}
                                                    for advanced configuration options and examples.
                                                </p>
                                            </div>
                                        </div>
                                    </div>
                                </div>
                            </div>
                        </div>
                    )}

                    {/* API Configuration Tab */}
                    {activeTab === 'api' && (
                        <div className="space-y-6">
                            <div className="rounded-2xl border border-slate-200 bg-white p-6 shadow-sm">
                                <h2 className="mb-4 text-lg font-semibold text-slate-900">API Key Management</h2>
                                <p className="mb-6 text-sm text-slate-600">
                                    Generate an API key to authenticate transaction reporting requests.
                                </p>

                                <div className="space-y-4">
                                    <div>
                                        <Label>API Key</Label>
                                        <div className="mt-2 flex gap-2">
                                            <Input
                                                value={apiKey || 'No API key generated yet'}
                                                readOnly
                                                placeholder="Generate API key"
                                                className="flex-1 font-mono text-sm"
                                            />
                                            <Button
                                                type="button"
                                                variant="outline"
                                                onClick={handleGenerateApiKey}
                                                disabled={isGeneratingApiKey}
                                            >
                                                <Key className="mr-2 h-4 w-4" />
                                                {isGeneratingApiKey ? 'Generating...' : 'Generate'}
                                            </Button>
                                            {apiKey && apiKey !== '***hidden***' && (
                                                <Button
                                                    type="button"
                                                    variant="outline"
                                                    size="sm"
                                                    onClick={() => copyToClipboard(apiKey, 'api-key')}
                                                >
                                                    {copiedText === 'api-key' ? (
                                                        <Check className="h-4 w-4" />
                                                    ) : (
                                                        <Copy className="h-4 w-4" />
                                                    )}
                                                </Button>
                                            )}
                                        </div>
                                        <p className="mt-2 text-xs text-slate-500">
                                            Keep your API key secure. Use it to authenticate transaction reporting requests.
                                        </p>
                                        {apiKeyInfo?.hasApiKey && apiKeyInfo.keyInfo && (
                                            <div className="mt-3 rounded-lg bg-slate-50 p-3">
                                                <div className="text-xs text-slate-600">
                                                    <p><strong>Usage:</strong> {apiKeyInfo.keyInfo.usageCount} requests</p>
                                                    <p><strong>Rate Limit:</strong> {apiKeyInfo.keyInfo.rateLimit} requests/hour</p>
                                                    <p><strong>Created:</strong> {new Date(apiKeyInfo.keyInfo.createdAt).toLocaleDateString()}</p>
                                                </div>
                                            </div>
                                        )}
                                    </div>
                                </div>
                            </div>

                            <div className="rounded-2xl border border-slate-200 bg-white p-6 shadow-sm">
                                <h2 className="mb-4 text-lg font-semibold text-slate-900">Transaction Reporting API</h2>
                                <p className="mb-6 text-sm text-slate-600">
                                    Report transactions after successful payments on your website.
                                </p>

                                <div className="space-y-4">
                                    <div>
                                        <Label>API Endpoint</Label>
                                        <div className="mt-2 flex gap-2">
                                            <Input
                                                value={`${apiBaseUrl}/api/vendors/transactions/report`}
                                                readOnly
                                                className="flex-1 font-mono text-sm"
                                            />
                                            <Button
                                                type="button"
                                                variant="outline"
                                                size="sm"
                                                onClick={() => copyToClipboard(
                                                    `${apiBaseUrl}/api/vendors/transactions/report`,
                                                    'api-endpoint'
                                                )}
                                            >
                                                {copiedText === 'api-endpoint' ? (
                                                    <Check className="h-4 w-4" />
                                                ) : (
                                                    <Copy className="h-4 w-4" />
                                                )}
                                            </Button>
                                        </div>
                                    </div>

                                    <div>
                                        <Label>Example Request</Label>
                                        <div className="relative mt-2">
                                            <pre className="overflow-x-auto rounded-lg bg-slate-900 p-4 text-xs text-slate-100">
                                                {`fetch('${apiBaseUrl}/api/vendors/transactions/report', {
  method: 'POST',
  headers: {
    'Authorization': 'Bearer YOUR_API_KEY',
    'Content-Type': 'application/json'
  },
  body: JSON.stringify({
    verificationToken: window.verificationToken,
    paymentReference: 'paystack_ref_123',
    amount: 15000,
    productId: 'product-uuid',
    paymentGateway: 'paystack'
  })
})
.then(response => response.json())
.then(data => {
  console.log('Transaction reported:', data);
})
.catch(error => {
  console.error('Error reporting transaction:', error);
});`}
                                            </pre>
                                            <Button
                                                type="button"
                                                variant="outline"
                                                size="sm"
                                                className="absolute right-2 top-2"
                                                onClick={() => copyToClipboard(
                                                    `fetch('${apiBaseUrl}/api/vendors/transactions/report', {
  method: 'POST',
  headers: {
    'Authorization': 'Bearer YOUR_API_KEY',
    'Content-Type': 'application/json'
  },
  body: JSON.stringify({
    verificationToken: window.verificationToken,
    paymentReference: 'paystack_ref_123',
    amount: 15000,
    productId: 'product-uuid',
    paymentGateway: 'paystack'
  })
})
.then(response => response.json())
.then(data => {
  console.log('Transaction reported:', data);
})
.catch(error => {
  console.error('Error reporting transaction:', error);
});`,
                                                    'api-example'
                                                )}
                                            >
                                                {copiedText === 'api-example' ? (
                                                    <Check className="h-4 w-4" />
                                                ) : (
                                                    <Copy className="h-4 w-4" />
                                                )}
                                            </Button>
                                        </div>
                                    </div>

                                    <div className="rounded-lg bg-slate-50 p-4">
                                        <h3 className="mb-2 text-sm font-semibold text-slate-900">Request Parameters:</h3>
                                        <ul className="space-y-1 text-xs text-slate-600">
                                            <li><strong>verificationToken:</strong> Token received from widget verification</li>
                                            <li><strong>paymentReference:</strong> Payment reference from your payment gateway</li>
                                            <li><strong>amount:</strong> Transaction amount in kobo (for Naira)</li>
                                            <li><strong>productId:</strong> UUID of the product purchased</li>
                                            <li><strong>paymentGateway:</strong> Payment gateway used (&apos;paystack&apos; or &apos;other&apos;)</li>
                                        </ul>
                                    </div>
                                </div>
                            </div>
                        </div>
                    )}

                    {/* Webhook Setup Tab */}
                    {activeTab === 'webhook' && (
                        <div className="space-y-6">
                            <div className="rounded-2xl border border-slate-200 bg-white p-6 shadow-sm">
                                <h2 className="mb-4 text-lg font-semibold text-slate-900">Paystack Webhook Configuration</h2>
                                <p className="mb-6 text-sm text-slate-600">
                                    Configure Paystack to automatically notify Awoof when payments are completed. This enables automatic commission tracking.
                                </p>

                                <div className="space-y-4">
                                    <div>
                                        <Label>Webhook URL</Label>
                                        <div className="mt-2 flex gap-2">
                                            <Input
                                                value={`${apiBaseUrl}/api/webhooks/paystack/vendor-payment`}
                                                readOnly
                                                className="flex-1 font-mono text-sm"
                                            />
                                            <Button
                                                type="button"
                                                variant="outline"
                                                size="sm"
                                                onClick={() => copyToClipboard(
                                                    `${apiBaseUrl}/api/webhooks/paystack/vendor-payment`,
                                                    'webhook-url'
                                                )}
                                            >
                                                {copiedText === 'webhook-url' ? (
                                                    <Check className="h-4 w-4" />
                                                ) : (
                                                    <Copy className="h-4 w-4" />
                                                )}
                                            </Button>
                                        </div>
                                    </div>

                                    <div className="rounded-lg bg-blue-50 p-4">
                                        <h3 className="mb-3 text-sm font-semibold text-blue-900">Setup Instructions:</h3>
                                        <ol className="space-y-2 text-sm text-blue-800">
                                            <li className="flex items-start gap-2">
                                                <span className="mt-0.5 flex h-5 w-5 items-center justify-center rounded-full bg-blue-200 text-xs font-semibold">1</span>
                                                <span>Log in to your <a href="https://dashboard.paystack.com" target="_blank" rel="noopener noreferrer" className="underline">Paystack Dashboard</a></span>
                                            </li>
                                            <li className="flex items-start gap-2">
                                                <span className="mt-0.5 flex h-5 w-5 items-center justify-center rounded-full bg-blue-200 text-xs font-semibold">2</span>
                                                <span>Navigate to <strong>Settings → Webhooks</strong></span>
                                            </li>
                                            <li className="flex items-start gap-2">
                                                <span className="mt-0.5 flex h-5 w-5 items-center justify-center rounded-full bg-blue-200 text-xs font-semibold">3</span>
                                                <span>Click <strong>&quot;Add Webhook&quot;</strong></span>
                                            </li>
                                            <li className="flex items-start gap-2">
                                                <span className="mt-0.5 flex h-5 w-5 items-center justify-center rounded-full bg-blue-200 text-xs font-semibold">4</span>
                                                <span>Paste the webhook URL above</span>
                                            </li>
                                            <li className="flex items-start gap-2">
                                                <span className="mt-0.5 flex h-5 w-5 items-center justify-center rounded-full bg-blue-200 text-xs font-semibold">5</span>
                                                <span>Select event: <code className="rounded bg-blue-100 px-1 py-0.5 text-xs">charge.success</code></span>
                                            </li>
                                            <li className="flex items-start gap-2">
                                                <span className="mt-0.5 flex h-5 w-5 items-center justify-center rounded-full bg-blue-200 text-xs font-semibold">6</span>
                                                <span>Click <strong>&quot;Save&quot;</strong></span>
                                            </li>
                                        </ol>
                                    </div>

                                    {paymentSettings?.paystackSubaccountCode ? (
                                        <div className="rounded-lg bg-green-50 p-4">
                                            <div className="flex items-center gap-2">
                                                <CheckCircle2 className="h-5 w-5 text-green-600" />
                                                <span className="text-sm font-medium text-green-900">
                                                    Paystack subaccount configured
                                                </span>
                                            </div>
                                            <p className="mt-1 text-xs text-green-700">
                                                Payments will be automatically split. Commission will be deducted automatically.
                                            </p>
                                        </div>
                                    ) : (
                                        <div className="rounded-lg bg-yellow-50 p-4">
                                            <div className="flex items-center gap-2">
                                                <AlertCircle className="h-5 w-5 text-yellow-600" />
                                                <span className="text-sm font-medium text-yellow-900">
                                                    Paystack subaccount not configured
                                                </span>
                                            </div>
                                            <p className="mt-1 text-xs text-yellow-700">
                                                Configure your Paystack subaccount in{' '}
                                                <a href="/vendor/payment" className="underline hover:text-yellow-900">
                                                    Payment Settings
                                                </a>{' '}
                                                to enable automatic commission splitting.
                                            </p>
                                        </div>
                                    )}
                                </div>
                            </div>

                            <div className="rounded-2xl border border-slate-200 bg-white p-6 shadow-sm">
                                <h2 className="mb-4 text-lg font-semibold text-slate-900">Webhook Events</h2>
                                <p className="mb-4 text-sm text-slate-600">
                                    The following events are processed by Awoof:
                                </p>
                                <div className="space-y-2">
                                    <div className="flex items-center gap-2 rounded-lg border border-slate-200 p-3">
                                        <Webhook className="h-5 w-5 text-blue-600" />
                                        <div>
                                            <p className="text-sm font-semibold text-slate-900">charge.success</p>
                                            <p className="text-xs text-slate-600">Triggered when a payment is successfully completed</p>
                                        </div>
                                    </div>
                                </div>
                            </div>
                        </div>
                    )}
                </div>
            </DashboardLayout>
        </ProtectedRoute>
    );
}
