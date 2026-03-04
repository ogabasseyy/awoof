/**
 * Edit Product Page
 */

'use client';

import { useState, useEffect } from 'react';
import { useRouter, useParams } from 'next/navigation';
import Image from 'next/image';
import { useForm, Controller } from 'react-hook-form';
import { zodResolver } from '@hookform/resolvers/zod';
import { z } from 'zod';
import { BarChart3, CreditCard, LayoutDashboard, LifeBuoy, Puzzle, Settings, ShoppingBag, Tag, ArrowLeft, Upload } from 'lucide-react';
import ProtectedRoute from '@/components/ProtectedRoute';
import { useAuth } from '@/contexts/AuthContext';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { PriceInput } from '@/components/ui/PriceInput';
import { Label } from '@/components/ui/label';
import { DashboardLayout } from '@/components/dashboard';
import type { User } from '@/lib/auth';
import apiClient, { getImageUrl } from '@/lib/api-client';

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

const productSchema = z.object({
    name: z.string().min(1, 'Product name is required').max(255, 'Product name too long'),
    description: z.string().optional(),
    price: z.number().positive('Price must be positive'),
    studentPrice: z.number().positive('Student price must be positive'),
    categoryId: z.string().uuid('Invalid category ID').optional().nullable(),
    stock: z.number().int().min(0, 'Stock cannot be negative'),
    status: z.enum(['active', 'inactive', 'out_of_stock']),
});

type ProductFormData = z.infer<typeof productSchema>;

export default function EditProductPage() {
    const router = useRouter();
    const params = useParams();
    const productId = params.id as string;
    const { user, logout } = useAuth();
    const [isLoading, setIsLoading] = useState(true);
    const [isSubmitting, setIsSubmitting] = useState(false);
    const [imageFile, setImageFile] = useState<File | null>(null);
    const [imagePreview, setImagePreview] = useState<string | null>(null);
    const [imageError, setImageError] = useState<string | null>(null);

    const MAX_IMAGE_SIZE = 2 * 1024 * 1024; // 2MB
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
        reset,
    } = useForm<ProductFormData>({
        resolver: zodResolver(productSchema),
        defaultValues: {
            stock: 0,
            status: 'active',
        },
    });

    // Fetch product and categories
    useEffect(() => {
        const fetchData = async () => {
            try {
                setIsLoading(true);
                const [productResponse, categoriesResponse] = await Promise.all([
                    apiClient.get(`/vendors/products/${productId}`),
                    apiClient.get('/products/categories'),
                ]);

                const product = productResponse.data.data.product;
                setCategories(categoriesResponse.data.data || []);

                // Set form values
                reset({
                    name: product.name,
                    description: product.description || '',
                    price: parseFloat(product.price),
                    studentPrice: parseFloat(product.student_price),
                    categoryId: product.category_id || null,
                    stock: product.stock,
                    status: product.status,
                });

                if (product.image_url) {
                    setImagePreview(getImageUrl(product.image_url) || product.image_url);
                }
            } catch (error: unknown) {
                console.error('Error fetching product:', error);
                const errorMessage = (error as { response?: { data?: { message?: string } } })?.response?.data?.message;
                alert(errorMessage || 'Failed to load product');
                router.push('/vendor/deals');
            } finally {
                setIsLoading(false);
            }
        };

        if (productId) {
            fetchData();
        }
    }, [productId, router, reset]);

    // Handle image change
    const handleImageChange = (e: React.ChangeEvent<HTMLInputElement>) => {
        const file = e.target.files?.[0];
        if (!file) return;
        setImageError(null);
        if (file.size > MAX_IMAGE_SIZE) {
            setImageError('Image must be 2MB or smaller.');
            setImageFile(null);
            setImagePreview(null);
            e.target.value = '';
            return;
        }
        setImageFile(file);
        const reader = new FileReader();
        reader.onloadend = () => {
            setImagePreview(reader.result as string);
        };
        reader.readAsDataURL(file);
    };

    // Handle form submission
    const onSubmit = async (data: ProductFormData) => {
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
            if (imageFile) formData.append('productImage', imageFile);

            await apiClient.put(`/vendors/products/${productId}`, formData, {
                headers: {
                    'Content-Type': 'multipart/form-data',
                },
            });

            router.push('/vendor/deals');
        } catch (error: unknown) {
            console.error('Error updating product:', error);
            const errorMessage = (error as { response?: { data?: { message?: string } } })?.response?.data?.message;
            alert(errorMessage || 'Failed to update product');
        } finally {
            setIsSubmitting(false);
        }
    };

    if (isLoading) {
        return (
            <ProtectedRoute requiredRole="vendor">
                <DashboardLayout
                    navItems={primaryNavItems}
                    secondaryNavItems={secondaryNavItems}
                    pageTitle="Edit Product"
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
                        <p className="text-slate-500">Loading product...</p>
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
                pageTitle="Edit Product"
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
                <form onSubmit={handleSubmit(onSubmit)} className="space-y-6">
                    {/* Back Button */}
                    <Button
                        type="button"
                        variant="ghost"
                        onClick={() => router.back()}
                        className="mb-4 -ml-2"
                    >
                        <ArrowLeft className="mr-2 h-4 w-4" />
                        Back to Products
                    </Button>

                    <div className="grid gap-6 lg:grid-cols-3">
                        {/* Main Form */}
                        <div className="lg:col-span-2 space-y-6">
                            {/* Basic Information */}
                            <div className="rounded-2xl border border-slate-200 bg-white p-6 shadow-sm">
                                <h2 className="mb-4 text-lg font-semibold text-slate-900">Basic Information</h2>
                                <div className="space-y-4">
                                    <div>
                                        <Label htmlFor="name">Product Name *</Label>
                                        <Input
                                            id="name"
                                            {...register('name')}
                                            placeholder="Enter product name"
                                            className={errors.name ? 'border-rose-500' : ''}
                                        />
                                        {errors.name && (
                                            <p className="mt-1 text-sm text-rose-600">{errors.name.message}</p>
                                        )}
                                    </div>

                                    <div>
                                        <Label htmlFor="description">Description</Label>
                                        <textarea
                                            id="description"
                                            {...register('description')}
                                            placeholder="Enter product description"
                                            rows={4}
                                            className="w-full rounded-lg border border-slate-200 bg-white px-3 py-2 text-sm text-slate-900 placeholder:text-slate-400 focus:border-blue-500 focus:outline-none focus:ring-1 focus:ring-blue-500"
                                        />
                                    </div>

                                    <div>
                                        <Label htmlFor="categoryId">Category</Label>
                                        {categories.length > 0 ? (
                                            <select
                                                id="categoryId"
                                                {...register('categoryId')}
                                                className={`w-full rounded-lg border border-slate-200 bg-white px-3 py-2 text-sm text-slate-900 focus:border-blue-500 focus:outline-none focus:ring-1 focus:ring-blue-500 ${errors.categoryId ? 'border-rose-500' : ''}`}
                                            >
                                                <option value="">No category</option>
                                                {categories.map((cat) => (
                                                    <option key={cat.id} value={cat.id}>
                                                        {cat.name}
                                                    </option>
                                                ))}
                                            </select>
                                        ) : (
                                            <div className="rounded-lg border border-slate-200 bg-slate-50 px-3 py-2 text-sm text-slate-500">
                                                Loading categories...
                                            </div>
                                        )}
                                        {errors.categoryId && (
                                            <p className="mt-1 text-sm text-rose-600">{errors.categoryId.message}</p>
                                        )}
                                    </div>

                                    <div className="grid gap-4 sm:grid-cols-2">
                                        <div>
                                            <Label htmlFor="price">Regular Price (₦) *</Label>
                                            <Controller
                                                name="price"
                                                control={control}
                                                render={({ field }) => (
                                                    <PriceInput
                                                        id="price"
                                                        placeholder="0.00"
                                                        className={errors.price ? 'border-rose-500' : ''}
                                                        value={field.value}
                                                        onChange={field.onChange}
                                                        onBlur={field.onBlur}
                                                        ref={field.ref}
                                                    />
                                                )}
                                            />
                                            {errors.price && (
                                                <p className="mt-1 text-sm text-rose-600">{errors.price.message}</p>
                                            )}
                                        </div>

                                        <div>
                                            <Label htmlFor="studentPrice">Student Price (₦) *</Label>
                                            <Controller
                                                name="studentPrice"
                                                control={control}
                                                render={({ field }) => (
                                                    <PriceInput
                                                        id="studentPrice"
                                                        placeholder="0.00"
                                                        className={errors.studentPrice ? 'border-rose-500' : ''}
                                                        value={field.value}
                                                        onChange={field.onChange}
                                                        onBlur={field.onBlur}
                                                        ref={field.ref}
                                                    />
                                                )}
                                            />
                                            {errors.studentPrice && (
                                                <p className="mt-1 text-sm text-rose-600">{errors.studentPrice.message}</p>
                                            )}
                                        </div>
                                    </div>
                                </div>
                            </div>

                            {/* Inventory & Status */}
                            <div className="rounded-2xl border border-slate-200 bg-white p-6 shadow-sm">
                                <h2 className="mb-4 text-lg font-semibold text-slate-900">Inventory & Status</h2>
                                <div className="grid gap-4 sm:grid-cols-2">
                                    <div>
                                        <Label htmlFor="stock">Stock Quantity</Label>
                                        <Input
                                            id="stock"
                                            type="number"
                                            {...register('stock', { valueAsNumber: true })}
                                            placeholder="0"
                                            className={errors.stock ? 'border-rose-500' : ''}
                                        />
                                        {errors.stock && (
                                            <p className="mt-1 text-sm text-rose-600">{errors.stock.message}</p>
                                        )}
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

                        {/* Sidebar */}
                        <div className="space-y-6">
                            {/* Image Upload */}
                            <div className="rounded-2xl border border-slate-200 bg-white p-6 shadow-sm">
                                <h2 className="mb-4 text-lg font-semibold text-slate-900">Product Image</h2>
                                <div className="space-y-4">
                                    {imagePreview ? (
                                        <div className="relative h-48 w-full overflow-hidden rounded-lg">
                                            <Image
                                                src={imagePreview}
                                                alt="Preview"
                                                fill
                                                className="object-cover"
                                                unoptimized
                                            />
                                            <button
                                                type="button"
                                                onClick={() => {
                                                    setImageFile(null);
                                                    setImagePreview(null);
                                                    setImageError(null);
                                                }}
                                                className="absolute right-2 top-2 rounded-full bg-slate-900/50 p-1.5 text-white hover:bg-slate-900/70"
                                            >
                                                ×
                                            </button>
                                        </div>
                                    ) : (
                                        <div className="flex h-48 items-center justify-center rounded-lg border-2 border-dashed border-slate-300 bg-slate-50">
                                            <div className="text-center">
                                                <Upload className="mx-auto h-8 w-8 text-slate-400" />
                                                <p className="mt-2 text-sm text-slate-500">No image selected</p>
                                            </div>
                                        </div>
                                    )}
                                    <div>
                                        <Label htmlFor="image">Upload Image</Label>
                                        <Input
                                            id="image"
                                            type="file"
                                            accept="image/*"
                                            onChange={handleImageChange}
                                            className="cursor-pointer"
                                        />
                                        <p className="mt-1 text-sm text-slate-500">Max file size: 2MB</p>
                                        {imageError && (
                                            <p className="mt-1 text-sm text-red-600">{imageError}</p>
                                        )}
                                    </div>
                                </div>
                            </div>


                            {/* Actions */}
                            <div className="rounded-2xl border border-slate-200 bg-white p-6 shadow-sm">
                                <div className="space-y-3">
                                    <Button
                                        type="submit"
                                        disabled={isSubmitting}
                                        className="w-full bg-blue-600 hover:bg-blue-700"
                                    >
                                        {isSubmitting ? 'Updating...' : 'Update Product'}
                                    </Button>
                                    <Button
                                        type="button"
                                        variant="outline"
                                        onClick={() => router.back()}
                                        className="w-full"
                                    >
                                        Cancel
                                    </Button>
                                </div>
                            </div>
                        </div>
                    </div>
                </form>
            </DashboardLayout>
        </ProtectedRoute>
    );
}

