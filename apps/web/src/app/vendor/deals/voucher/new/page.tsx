/**
 * Add New Voucher Page
 *
 * A voucher here is a listed offer in the marketplace "Vouchers" section—students see it
 * and click through to your website (widget) to redeem. No code to type (unlike a promo code).
 * Payment is always on your site; set up the widget in Integration.
 */

'use client';

import { useState, useEffect } from 'react';
import { useRouter } from 'next/navigation';
import { useForm, Controller } from 'react-hook-form';
import { zodResolver } from '@hookform/resolvers/zod';
import { z } from 'zod';
import { BarChart3, CreditCard, LayoutDashboard, LifeBuoy, Puzzle, Settings, ShoppingBag, Tag, ArrowLeft } from 'lucide-react';
import ProtectedRoute from '@/components/ProtectedRoute';
import { useAuth } from '@/contexts/AuthContext';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { PriceInput } from '@/components/ui/PriceInput';
import { Label } from '@/components/ui/label';
import { DashboardLayout } from '@/components/dashboard';
import type { User } from '@/lib/auth';
import apiClient from '@/lib/api-client';
import toast from 'react-hot-toast';
import { getApiErrorMessage } from '@/lib/api-error';
import Link from 'next/link';

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

const voucherSchema = z.object({
    name: z.string().min(1, 'Voucher title is required').max(255, 'Title too long'),
    description: z.string().optional(),
    price: z.number().positive('Regular value must be positive'),
    studentPrice: z.number().positive('Student / discounted value must be positive'),
    categoryId: z.string().min(1, 'Please select a category').uuid('Invalid category'),
    stock: z.number().int().min(1, 'Set a redemption limit of at least 1'),
    status: z.enum(['active', 'inactive', 'out_of_stock']),
});

type VoucherFormData = z.infer<typeof voucherSchema>;

export default function NewVoucherPage() {
    const router = useRouter();
    const { user, logout } = useAuth();
    const [isSubmitting, setIsSubmitting] = useState(false);
    const [categories, setCategories] = useState<Array<{ id: string; name: string }>>([]);

    type VendorProfile = { companyName?: string | null; name?: string | null };
    const extendedUser = user as (User & { profile?: VendorProfile }) | null;
    const companyName = extendedUser?.profile?.companyName ?? null;
    const displayName = companyName ?? extendedUser?.profile?.name ?? extendedUser?.email ?? 'Vendor';

    const {
        register,
        control,
        handleSubmit,
        formState: { errors },
    } = useForm<VoucherFormData>({
        resolver: zodResolver(voucherSchema),
        defaultValues: {
            stock: 1,
            status: 'active',
        },
    });

    useEffect(() => {
        const fetchCategories = async () => {
            try {
                const response = await apiClient.get('/products/categories');
                setCategories(response.data.data || []);
            } catch (error) {
                console.error('Error fetching categories:', error);
            }
        };
        fetchCategories();
    }, []);

    const onSubmit = async (data: VoucherFormData) => {
        try {
            setIsSubmitting(true);
            const formData = new FormData();
            formData.append('name', data.name);
            if (data.description) formData.append('description', data.description);
            formData.append('price', data.price.toString());
            formData.append('studentPrice', data.studentPrice.toString());
            if (data.categoryId) formData.append('categoryId', data.categoryId);
            formData.append('stock', data.stock.toString());
            formData.append('status', data.status);
            formData.append('dealType', 'voucher');

            await apiClient.post('/vendors/products', formData);

            router.push('/vendor/deals?tab=vouchers');
        } catch (error: unknown) {
            console.error('Error creating voucher:', error);
            toast.error(getApiErrorMessage(error, 'Failed to create voucher'));
        } finally {
            setIsSubmitting(false);
        }
    };

    return (
        <ProtectedRoute requiredRole="vendor">
            <DashboardLayout
                navItems={primaryNavItems}
                secondaryNavItems={secondaryNavItems}
                pageTitle="Add New Voucher"
                onLogout={logout}
                logoutLabel="Log out"
                user={{
                    name: displayName,
                    email: user?.email ?? null,
                    roleLabel: 'Vendor',
                    secondaryText: companyName ?? undefined,
                    profileHref: '/vendor/settings',
                    avatarUrl: null,
                }}
            >
                <form onSubmit={handleSubmit(onSubmit)} className="space-y-6">
                    <Button type="button" variant="ghost" asChild className="mb-4 -ml-2">
                        <Link href="/vendor/deals?tab=vouchers">
                            <ArrowLeft className="mr-2 h-4 w-4" />
                            Back to Vouchers
                        </Link>
                    </Button>

                    <div className="rounded-lg border border-blue-200 bg-blue-50 p-4 text-sm text-blue-800">
                        Vouchers are shown in the students vouchers area. Payment is always on your website—make sure your widget is set up in Integration.
                    </div>

                    <div className="max-w-2xl space-y-6">
                        <div className="rounded-2xl border border-slate-200 bg-white p-6 shadow-sm">
                            <h2 className="mb-4 text-lg font-semibold text-slate-900">Voucher details</h2>
                            <div className="space-y-4">
                                <div>
                                    <Label htmlFor="name">Title *</Label>
                                    <Input
                                        id="name"
                                        {...register('name')}
                                        placeholder="e.g. 20% off for students"
                                        className={errors.name ? 'border-rose-500' : ''}
                                    />
                                    {errors.name && <p className="mt-1 text-sm text-rose-600">{errors.name.message}</p>}
                                </div>
                                <div>
                                    <Label htmlFor="description">Description (optional)</Label>
                                    <textarea
                                        id="description"
                                        {...register('description')}
                                        placeholder="Short line about the offer"
                                        rows={2}
                                        className="w-full rounded-lg border border-slate-200 bg-white px-3 py-2 text-sm text-slate-900 placeholder:text-slate-400 focus:border-blue-500 focus:outline-none focus:ring-1 focus:ring-blue-500"
                                    />
                                </div>
                                <div>
                                    <Label htmlFor="categoryId">Category *</Label>
                                    {categories.length > 0 ? (
                                        <select
                                            id="categoryId"
                                            {...register('categoryId')}
                                            className={`w-full rounded-lg border border-slate-200 bg-white px-3 py-2 text-sm text-slate-900 focus:border-blue-500 focus:outline-none focus:ring-1 focus:ring-blue-500 ${errors.categoryId ? 'border-rose-500' : ''}`}
                                        >
                                            <option value="">Select a category</option>
                                            {categories.map((cat) => (
                                                <option key={cat.id} value={cat.id}>{cat.name}</option>
                                            ))}
                                        </select>
                                    ) : (
                                        <div className="rounded-lg border border-slate-200 bg-slate-50 px-3 py-2 text-sm text-slate-500">Loading categories...</div>
                                    )}
                                    {errors.categoryId && <p className="mt-1 text-sm text-rose-600">{errors.categoryId.message}</p>}
                                </div>
                                <div className="grid gap-4 sm:grid-cols-2">
                                    <div>
                                        <Label htmlFor="price">Regular value (₦) *</Label>
                                        <Controller
                                            name="price"
                                            control={control}
                                            render={({ field }) => (
                                                <PriceInput
                                                    id="price"
                                                    placeholder="e.g. 100"
                                                    className={errors.price ? 'border-rose-500' : ''}
                                                    value={field.value}
                                                    onChange={field.onChange}
                                                    onBlur={field.onBlur}
                                                    ref={field.ref}
                                                />
                                            )}
                                        />
                                        <p className="mt-1 text-xs text-slate-500">Used to show the discount % (e.g. was ₦100, now ₦80)</p>
                                        {errors.price && <p className="mt-1 text-sm text-rose-600">{errors.price.message}</p>}
                                    </div>
                                    <div>
                                        <Label htmlFor="studentPrice">Student / discounted value (₦) *</Label>
                                        <Controller
                                            name="studentPrice"
                                            control={control}
                                            render={({ field }) => (
                                                <PriceInput
                                                    id="studentPrice"
                                                    placeholder="e.g. 80"
                                                    className={errors.studentPrice ? 'border-rose-500' : ''}
                                                    value={field.value}
                                                    onChange={field.onChange}
                                                    onBlur={field.onBlur}
                                                    ref={field.ref}
                                                />
                                            )}
                                        />
                                        {errors.studentPrice && <p className="mt-1 text-sm text-rose-600">{errors.studentPrice.message}</p>}
                                    </div>
                                </div>
                                <div className="grid gap-4 sm:grid-cols-2">
                                    <div>
                                        <Label htmlFor="stock">Redemption limit *</Label>
                                        <Input
                                            id="stock"
                                            type="number"
                                            min={1}
                                            {...register('stock', { valueAsNumber: true })}
                                            placeholder="Maximum redemptions"
                                            className={errors.stock ? 'border-rose-500' : ''}
                                        />
                                        {errors.stock && <p className="mt-1 text-sm text-rose-600">{errors.stock.message}</p>}
                                    </div>
                                    <div>
                                        <Label htmlFor="status">Status</Label>
                                        <select
                                            id="status"
                                            {...register('status')}
                                            className="w-full rounded-lg border border-slate-200 bg-white px-3 py-2 text-sm text-slate-900 focus:border-blue-500 focus:outline-none focus:ring-1 focus:ring-blue-500"
                                        >
                                            <option value="active">Active</option>
                                            <option value="inactive">Inactive</option>
                                            <option value="out_of_stock">Out of Stock</option>
                                        </select>
                                    </div>
                                </div>
                            </div>
                        </div>

                        <div className="flex flex-wrap gap-3">
                            <Button type="submit" disabled={isSubmitting} className="bg-blue-600 hover:bg-blue-700">
                                {isSubmitting ? 'Creating...' : 'Create Voucher'}
                            </Button>
                            <Button type="button" variant="outline" asChild>
                                <Link href="/vendor/deals?tab=vouchers">Cancel</Link>
                            </Button>
                        </div>
                    </div>
                </form>
            </DashboardLayout>
        </ProtectedRoute>
    );
}
