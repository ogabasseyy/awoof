/**
 * Vendor Settings Page
 * 
 * Allows vendors to update their profile information, upload/update files, and manage account settings
 */

'use client';

import { useState, useEffect } from 'react';
import { BarChart3, CreditCard, LayoutDashboard, LifeBuoy, Puzzle, Settings, ShoppingBag, Tag, Save, Upload, Image as ImageIcon, FileText, Building2, Phone, Globe, Tag as TagIcon, FileEdit } from 'lucide-react';
import ProtectedRoute from '@/components/ProtectedRoute';
import { useAuth } from '@/contexts/AuthContext';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Textarea } from '@/components/ui/textarea';
import { DashboardLayout } from '@/components/dashboard';
import type { User } from '@/lib/auth';
import apiClient from '@/lib/api-client';
import { FileUploadField } from '@/components/forms/FileUploadField';
import { useFileUpload } from '@/hooks/useFileUpload';
import Image from 'next/image';

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

interface VendorProfile {
    id: string;
    user_id: string;
    name: string;
    company_name: string | null;
    phone_number: string | null;
    business_category: string | null;
    business_website: string | null;
    description: string | null;
    status: string;
    logo_url: string | null;
    banner_url: string | null;
    document_front_url: string | null;
    document_back_url: string | null;
    commission_rate: number;
    created_at: string;
    updated_at: string;
    email: string;
}

export default function VendorSettingsPage() {
    const { user, logout } = useAuth();
    const [profile, setProfile] = useState<VendorProfile | null>(null);
    const [isLoading, setIsLoading] = useState(true);
    const [isSaving, setIsSaving] = useState(false);
    const [isUploading, setIsUploading] = useState(false);
    const [error, setError] = useState<string | null>(null);
    const [successMessage, setSuccessMessage] = useState<string | null>(null);
    const [activeTab, setActiveTab] = useState<'profile' | 'files'>('profile');

    // Form state
    const [companyName, setCompanyName] = useState('');
    const [phoneNumber, setPhoneNumber] = useState('');
    const [businessCategory, setBusinessCategory] = useState('');
    const [businessWebsite, setBusinessWebsite] = useState('');
    const [description, setDescription] = useState('');

    // File upload hook
    const {
        setFile,
        validateAllFiles,
        getFile,
        getError,
    } = useFileUpload({
        maxSize: 2 * 1024 * 1024, // 2MB
    });

    // Business categories (you can fetch these from backend if available)
    const businessCategories = [
        'Travel',
        'Food & Dining',
        'Shopping',
        'Technology',
        'Beauty & Spa',
        'Education',
        'Entertainment',
        'Health & Fitness',
        'Other',
    ];

    type VendorProfileType = { companyName?: string | null; name?: string | null };
    const extendedUser = user as (User & { profile?: VendorProfileType }) | null;
    const companyNameDisplay = extendedUser?.profile?.companyName ?? null;
    const displayName = companyNameDisplay ?? extendedUser?.profile?.name ?? extendedUser?.email ?? 'Vendor';

    // Fetch vendor profile
    useEffect(() => {
        const fetchProfile = async () => {
            try {
                setIsLoading(true);
                const response = await apiClient.get('/vendors/profile');
                const vendorData = response.data.data.vendor;
                setProfile(vendorData);

                // Populate form fields
                setCompanyName(vendorData.company_name || '');
                setPhoneNumber(vendorData.phone_number || '');
                setBusinessCategory(vendorData.business_category || '');
                setBusinessWebsite(vendorData.business_website || '');
                setDescription(vendorData.description || '');
            } catch (err) {
                const error = err as { response?: { data?: { error?: { message?: string } } } };
                setError(error.response?.data?.error?.message || 'Failed to load profile');
            } finally {
                setIsLoading(false);
            }
        };

        fetchProfile();
    }, []);

    // Handle profile update
    const handleProfileUpdate = async (e: React.FormEvent) => {
        e.preventDefault();
        setIsSaving(true);
        setError(null);
        setSuccessMessage(null);

        try {
            await apiClient.put('/vendors/profile', {
                companyName: companyName.trim() || undefined,
                phoneNumber: phoneNumber.trim() || undefined,
                businessCategory: businessCategory.trim() || undefined,
                businessWebsite: businessWebsite.trim() || undefined,
                description: description.trim() || undefined,
            });

            setSuccessMessage('Profile updated successfully');

            // Refresh profile data
            const response = await apiClient.get('/vendors/profile');
            setProfile(response.data.data.vendor);
        } catch (err) {
            const error = err as { response?: { data?: { error?: { message?: string } } } };
            setError(error.response?.data?.error?.message || 'Failed to update profile');
        } finally {
            setIsSaving(false);
        }
    };

    // Handle file upload
    const handleFileUpload = async () => {
        setIsUploading(true);
        setError(null);
        setSuccessMessage(null);

        try {
            // Validate files
            const isValid = validateAllFiles();
            if (!isValid) {
                setError('Please fix file validation errors');
                setIsUploading(false);
                return;
            }

            // Check if logo is required (if vendor doesn't have one)
            if (!profile?.logo_url && !getFile('logoImage')) {
                setError('Logo image is required');
                setIsUploading(false);
                return;
            }

            // Prepare form data
            const formData = new FormData();
            const filesToUpload = ['logoImage', 'bannerImage', 'documentFront', 'documentBack'];

            let hasFiles = false;
            filesToUpload.forEach((fieldName) => {
                const file = getFile(fieldName);
                if (file) {
                    formData.append(fieldName, file);
                    hasFiles = true;
                }
            });

            if (!hasFiles) {
                setError('Please select at least one file to upload');
                setIsUploading(false);
                return;
            }

            await apiClient.post('/vendors/upload', formData);

            setSuccessMessage('Files uploaded successfully');

            // Clear file inputs
            filesToUpload.forEach((fieldName) => {
                setFile(fieldName, null);
            });

            // Refresh profile data
            const response = await apiClient.get('/vendors/profile');
            setProfile(response.data.data.vendor);
        } catch (err) {
            const error = err as { response?: { data?: { error?: { message?: string } } } };
            setError(error.response?.data?.error?.message || 'Failed to upload files');
        } finally {
            setIsUploading(false);
        }
    };

    const getImageUrl = (url: string | null) => {
        if (!url) return null;
        if (url.startsWith('http://') || url.startsWith('https://')) {
            return url;
        }
        return `${process.env.NEXT_PUBLIC_API_URL || 'http://localhost:3001'}${url}`;
    };

    if (isLoading) {
        return (
            <ProtectedRoute requiredRole="vendor">
                <DashboardLayout
                    navItems={primaryNavItems}
                    secondaryNavItems={secondaryNavItems}
                    pageTitle="Settings"
                    onLogout={logout}
                    logoutLabel="Log out"
                    user={{
                        name: displayName,
                        email: user?.email ?? null,
                        roleLabel: 'Vendor',
                        secondaryText: companyNameDisplay ?? undefined,
                        profileHref: '/vendor/settings',
                        avatarUrl: null,
                    }}
                >
                    <div className="flex items-center justify-center py-12">
                        <p className="text-slate-500">Loading settings...</p>
                    </div>
                </DashboardLayout>
            </ProtectedRoute>
        );
    }

    return (
        <ProtectedRoute requiredRole="vendor">
            <DashboardLayout
                navItems={primaryNavItems}
                secondaryNavItems={secondaryNavItems}
                pageTitle="Settings"
                onLogout={logout}
                logoutLabel="Log out"
                user={{
                    name: displayName,
                    email: user?.email ?? null,
                    roleLabel: 'Vendor',
                    secondaryText: companyNameDisplay ?? undefined,
                    profileHref: '/vendor/settings',
                    avatarUrl: null,
                }}
            >
                <div className="space-y-6">
                    {/* Success/Error Messages */}
                    {successMessage && (
                        <div className="bg-green-50 border border-green-200 text-green-800 px-4 py-3 rounded-lg">
                            {successMessage}
                        </div>
                    )}
                    {error && (
                        <div className="bg-red-50 border border-red-200 text-red-800 px-4 py-3 rounded-lg">
                            {error}
                        </div>
                    )}

                    {/* Tabs */}
                    <div className="border-b border-slate-200">
                        <nav className="-mb-px flex space-x-8">
                            <button
                                onClick={() => setActiveTab('profile')}
                                className={`whitespace-nowrap border-b-2 px-1 py-4 text-sm font-medium ${activeTab === 'profile'
                                    ? 'border-[#1D4ED8] text-[#1D4ED8]'
                                    : 'border-transparent text-slate-500 hover:border-slate-300 hover:text-slate-700'
                                    }`}
                            >
                                <FileEdit className="inline h-4 w-4 mr-2" />
                                Profile Information
                            </button>
                            <button
                                onClick={() => setActiveTab('files')}
                                className={`whitespace-nowrap border-b-2 px-1 py-4 text-sm font-medium ${activeTab === 'files'
                                    ? 'border-[#1D4ED8] text-[#1D4ED8]'
                                    : 'border-transparent text-slate-500 hover:border-slate-300 hover:text-slate-700'
                                    }`}
                            >
                                <Upload className="inline h-4 w-4 mr-2" />
                                Files & Media
                            </button>
                        </nav>
                    </div>

                    {/* Profile Information Tab */}
                    {activeTab === 'profile' && (
                        <form onSubmit={handleProfileUpdate} className="space-y-6">
                            <div className="bg-white rounded-lg shadow-sm border border-slate-200 p-6">
                                <h3 className="text-lg font-semibold text-slate-900 mb-6">Company Information</h3>

                                <div className="grid grid-cols-1 md:grid-cols-2 gap-6">
                                    {/* Company Name */}
                                    <div>
                                        <Label htmlFor="companyName" className="flex items-center gap-2">
                                            <Building2 className="h-4 w-4" />
                                            Company Name
                                        </Label>
                                        <Input
                                            id="companyName"
                                            type="text"
                                            value={companyName}
                                            onChange={(e) => setCompanyName(e.target.value)}
                                            className="mt-2"
                                            placeholder="Enter company name"
                                        />
                                    </div>

                                    {/* Phone Number */}
                                    <div>
                                        <Label htmlFor="phoneNumber" className="flex items-center gap-2">
                                            <Phone className="h-4 w-4" />
                                            Phone Number
                                        </Label>
                                        <Input
                                            id="phoneNumber"
                                            type="tel"
                                            value={phoneNumber}
                                            onChange={(e) => setPhoneNumber(e.target.value)}
                                            className="mt-2"
                                            placeholder="Enter phone number"
                                        />
                                    </div>

                                    {/* Business Category */}
                                    <div>
                                        <Label htmlFor="businessCategory" className="flex items-center gap-2">
                                            <TagIcon className="h-4 w-4" />
                                            Business Category
                                        </Label>
                                        <select
                                            id="businessCategory"
                                            value={businessCategory}
                                            onChange={(e) => setBusinessCategory(e.target.value)}
                                            className="mt-2 w-full px-3 py-2 border border-slate-300 rounded-md shadow-sm focus:outline-none focus:ring-2 focus:ring-[#1D4ED8] focus:border-[#1D4ED8]"
                                        >
                                            <option value="">Select category</option>
                                            {businessCategories.map((cat) => (
                                                <option key={cat} value={cat}>
                                                    {cat}
                                                </option>
                                            ))}
                                        </select>
                                    </div>

                                    {/* Business Website */}
                                    <div>
                                        <Label htmlFor="businessWebsite" className="flex items-center gap-2">
                                            <Globe className="h-4 w-4" />
                                            Business Website
                                        </Label>
                                        <Input
                                            id="businessWebsite"
                                            type="url"
                                            value={businessWebsite}
                                            onChange={(e) => setBusinessWebsite(e.target.value)}
                                            className="mt-2"
                                            placeholder="https://example.com"
                                        />
                                    </div>
                                </div>

                                {/* Description */}
                                <div className="mt-6">
                                    <Label htmlFor="description">Description</Label>
                                    <Textarea
                                        id="description"
                                        value={description}
                                        onChange={(e) => setDescription(e.target.value)}
                                        className="mt-2"
                                        rows={4}
                                        placeholder="Describe your business..."
                                    />
                                </div>

                                {/* Account Information (Read-only) */}
                                <div className="mt-6 pt-6 border-t border-slate-200">
                                    <h4 className="text-sm font-semibold text-slate-700 mb-4">Account Information</h4>
                                    <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                                        <div>
                                            <Label className="text-slate-500">Email</Label>
                                            <Input
                                                type="email"
                                                value={profile?.email || ''}
                                                disabled
                                                className="mt-2 bg-slate-50"
                                            />
                                        </div>
                                        <div>
                                            <Label className="text-slate-500">Status</Label>
                                            <Input
                                                type="text"
                                                value={profile?.status || ''}
                                                disabled
                                                className="mt-2 bg-slate-50 capitalize"
                                            />
                                        </div>
                                    </div>
                                </div>

                                <div className="mt-6 flex justify-end">
                                    <Button
                                        type="submit"
                                        disabled={isSaving}
                                        style={{ backgroundColor: '#1D4ED8' }}
                                    >
                                        <Save className="h-4 w-4 mr-2" />
                                        {isSaving ? 'Saving...' : 'Save Changes'}
                                    </Button>
                                </div>
                            </div>
                        </form>
                    )}

                    {/* Files & Media Tab */}
                    {activeTab === 'files' && (
                        <div className="space-y-6">
                            <div className="bg-white rounded-lg shadow-sm border border-slate-200 p-6">
                                <h3 className="text-lg font-semibold text-slate-900 mb-6">Upload Files</h3>

                                <div className="space-y-6">
                                    {/* Logo Image - Required */}
                                    <div>
                                        <Label className="mb-2 block">
                                            <ImageIcon className="inline h-4 w-4 mr-2" />
                                            Logo Image <span className="text-red-600">*</span>
                                        </Label>
                                        {profile?.logo_url && (
                                            <div className="mb-3">
                                                <p className="text-sm text-slate-600 mb-2">Current Logo:</p>
                                                <div className="relative w-32 h-32 border border-slate-200 rounded-lg overflow-hidden">
                                                    <Image
                                                        src={getImageUrl(profile.logo_url) || ''}
                                                        alt="Current logo"
                                                        fill
                                                        className="object-cover"
                                                        unoptimized
                                                    />
                                                </div>
                                            </div>
                                        )}
                                        <FileUploadField
                                            label="Upload New Logo"
                                            file={getFile('logoImage')}
                                            onChange={(file) => setFile('logoImage', file)}
                                            accept="image/*"
                                            error={getError('logoImage') || undefined}
                                            maxSize={2 * 1024 * 1024} // 2MB
                                        />
                                        <p className="mt-2 text-sm text-slate-500">
                                            Logo is required. Max file size: 2MB. Recommended: Square image (e.g., 512x512px)
                                        </p>
                                    </div>

                                    {/* Banner Image */}
                                    <div>
                                        <Label className="mb-2 block">
                                            <ImageIcon className="inline h-4 w-4 mr-2" />
                                            Banner Image
                                        </Label>
                                        {profile?.banner_url && (
                                            <div className="mb-3">
                                                <p className="text-sm text-slate-600 mb-2">Current Banner:</p>
                                                <div className="relative w-full h-48 border border-slate-200 rounded-lg overflow-hidden">
                                                    <Image
                                                        src={getImageUrl(profile.banner_url) || ''}
                                                        alt="Current banner"
                                                        fill
                                                        className="object-cover"
                                                        unoptimized
                                                    />
                                                </div>
                                            </div>
                                        )}
                                        <FileUploadField
                                            label="Upload New Banner"
                                            file={getFile('bannerImage')}
                                            onChange={(file) => setFile('bannerImage', file)}
                                            accept="image/*"
                                            error={getError('bannerImage') || undefined}
                                            maxSize={2 * 1024 * 1024} // 2MB
                                        />
                                        <p className="mt-2 text-sm text-slate-500">
                                            Optional. Max file size: 2MB. Recommended: 1920x600px
                                        </p>
                                    </div>

                                    {/* Document Upload */}
                                    <div>
                                        <Label className="mb-2 block">
                                            <FileText className="inline h-4 w-4 mr-2" />
                                            Business Documents
                                        </Label>
                                        <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                                            <div>
                                                <Label className="text-sm">Document Front</Label>
                                                {profile?.document_front_url && (
                                                    <div className="mt-2 mb-2">
                                                        <a
                                                            href={getImageUrl(profile.document_front_url) || '#'}
                                                            target="_blank"
                                                            rel="noopener noreferrer"
                                                            className="text-sm text-[#1D4ED8] hover:underline"
                                                        >
                                                            View current document
                                                        </a>
                                                    </div>
                                                )}
                                                <FileUploadField
                                                    label="Upload Front"
                                                    file={getFile('documentFront')}
                                                    onChange={(file) => setFile('documentFront', file)}
                                                    accept="image/*,.pdf"
                                                    error={getError('documentFront') || undefined}
                                                    maxSize={2 * 1024 * 1024} // 2MB
                                                />
                                            </div>
                                            <div>
                                                <Label className="text-sm">Document Back</Label>
                                                {profile?.document_back_url && (
                                                    <div className="mt-2 mb-2">
                                                        <a
                                                            href={getImageUrl(profile.document_back_url) || '#'}
                                                            target="_blank"
                                                            rel="noopener noreferrer"
                                                            className="text-sm text-[#1D4ED8] hover:underline"
                                                        >
                                                            View current document
                                                        </a>
                                                    </div>
                                                )}
                                                <FileUploadField
                                                    label="Upload Back"
                                                    file={getFile('documentBack')}
                                                    onChange={(file) => setFile('documentBack', file)}
                                                    accept="image/*,.pdf"
                                                    error={getError('documentBack') || undefined}
                                                    maxSize={2 * 1024 * 1024} // 2MB
                                                />
                                            </div>
                                        </div>
                                        <p className="mt-2 text-sm text-slate-500">
                                            Optional. Upload business certificate or ID. Max file size: 2MB per file.
                                        </p>
                                    </div>

                                    <div className="pt-4 border-t border-slate-200">
                                        <Button
                                            type="button"
                                            onClick={handleFileUpload}
                                            disabled={isUploading}
                                            style={{ backgroundColor: '#1D4ED8' }}
                                        >
                                            <Upload className="h-4 w-4 mr-2" />
                                            {isUploading ? 'Uploading...' : 'Upload Files'}
                                        </Button>
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
