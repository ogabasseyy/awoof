/**
 * Marketplace - Student Dashboard Style
 * 
 * Homepage-style marketplace for logged-in students
 */

'use client';

import { useState, useEffect, useCallback } from 'react';
import { Search, Plane, ShoppingBag, Monitor, Utensils, Sparkles, Smartphone } from 'lucide-react';
import { Input } from '@/components/ui/input';
import { Button } from '@/components/ui/button';
import apiClient, { getImageUrl } from '@/lib/api-client';
import Image from 'next/image';
import Link from 'next/link';
import { useAuth } from '@/contexts/AuthContext';
import { formatCurrency } from '@/lib/format';

interface Product {
    id: string;
    name: string;
    description: string;
    price: number;
    student_price: number;
    image_url: string | null;
    category_id: string | null;
    category_name: string | null;
    vendor_name: string | null;
    vendor_logo_url: string | null;
    vendor_payment_method?: 'awoof' | 'vendor_website';
    deal_type?: 'product' | 'voucher';
    stock: number;
}

interface Category {
    id: string;
    name: string;
    slug: string;
    description: string | null;
}

interface SavingsStats {
    totalSavings: number;
    totalPurchases: number;
}

// Icon mapping for categories (fallback if category doesn't have icon in DB)
const categoryIconMap: Record<string, { icon: typeof Plane; color: string; textColor?: string }> = {
    'travel': { icon: Plane, color: 'rgba(29, 78, 216, 0.1)', textColor: '#1D4ED8' },
    'food': { icon: Utensils, color: 'bg-amber-100 text-amber-600' },
    'shopping': { icon: ShoppingBag, color: 'bg-green-100 text-green-600' },
    'tech': { icon: Monitor, color: 'rgba(29, 78, 216, 0.1)', textColor: '#1D4ED8' },
    'beauty & spa': { icon: Sparkles, color: 'bg-pink-100 text-pink-600' },
    'beauty': { icon: Sparkles, color: 'bg-pink-100 text-pink-600' },
    'spa': { icon: Sparkles, color: 'bg-pink-100 text-pink-600' },
};

export default function MarketplacePage() {
    const { user } = useAuth();
    const [products, setProducts] = useState<Product[]>([]);
    const [voucherProducts, setVoucherProducts] = useState<Product[]>([]);
    const [categories, setCategories] = useState<Category[]>([]);
    const [featuredProducts, setFeaturedProducts] = useState<Product[]>([]);
    const [categoryProducts, setCategoryProducts] = useState<Product[]>([]);
    const [selectedCategory, setSelectedCategory] = useState<string | null>(null);
    const [savingsStats, setSavingsStats] = useState<SavingsStats>({ totalSavings: 0, totalPurchases: 0 });
    const [isLoading, setIsLoading] = useState(true);
    const [searchQuery, setSearchQuery] = useState('');

    const fetchCategoryProducts = useCallback(async (categoryId: string) => {
        try {
            const response = await apiClient.get(`/products?categoryId=${categoryId}&limit=20&deal_type=product`);
            setCategoryProducts(response.data.data.products || []);
        } catch (error) {
            console.error('Error fetching category products:', error);
        }
    }, []);

    const fetchData = useCallback(async () => {
        try {
            setIsLoading(true);
            const [productsRes, vouchersRes, categoriesRes, savingsRes] = await Promise.all([
                apiClient.get('/products?limit=20&deal_type=product'),
                apiClient.get('/products?limit=20&deal_type=voucher'),
                apiClient.get('/products/categories'),
                user ? apiClient.get('/students/savings').catch(() => null) : Promise.resolve(null),
            ]);

            const allProducts = productsRes.data.data.products || [];
            const vouchers = vouchersRes.data.data.products || [];
            const fetchedCategories = categoriesRes.data.data || [];

            setProducts(allProducts);
            setVoucherProducts(vouchers);
            setCategories(fetchedCategories);
            setFeaturedProducts(allProducts.slice(0, 6));

            // Set default selected category only if not already set
            setSelectedCategory((prev) => {
                if (prev) return prev; // Keep existing selection
                if (fetchedCategories.length > 0) {
                    const defaultCategory = fetchedCategories.find((c: Category) =>
                        c.name.toLowerCase() === 'travel'
                    ) || fetchedCategories[0];
                    return defaultCategory.id;
                }
                return null;
            });

            if (savingsRes?.data?.data?.summary) {
                setSavingsStats({
                    totalSavings: savingsRes.data.data.summary.totalSavings || 0,
                    totalPurchases: savingsRes.data.data.summary.totalPurchases || 0,
                });
            }
        } catch (error) {
            console.error('Error fetching data:', error);
        } finally {
            setIsLoading(false);
        }
    }, [user]);

    useEffect(() => {
        fetchData();
    }, [fetchData]);

    useEffect(() => {
        if (selectedCategory) {
            fetchCategoryProducts(selectedCategory);
        }
    }, [selectedCategory, fetchCategoryProducts]);

    const handleSearch = (e: React.FormEvent) => {
        e.preventDefault();
        // Navigate to search results or filter products
        window.location.href = `/marketplace/search?q=${encodeURIComponent(searchQuery)}`;
    };


    const calculateDiscount = (price: number, studentPrice: number) => {
        const discount = ((price - studentPrice) / price) * 100;
        return Math.round(discount);
    };

    const getCategoryIcon = (categoryName: string) => {
        const normalizedName = categoryName.toLowerCase();
        const match = categoryIconMap[normalizedName] ||
            Object.entries(categoryIconMap).find(([key]) =>
                normalizedName.includes(key) || key.includes(normalizedName)
            )?.[1];

        return match || { icon: ShoppingBag, color: 'bg-slate-100', textColor: '#64748b' };
    };

    const getSelectedCategoryName = () => {
        if (!selectedCategory) return 'Deals';
        const category = categories.find(c => c.id === selectedCategory);
        return category ? `${category.name} Deals` : 'Deals';
    };

    return (
        <div className="min-h-screen bg-white">
            {/* Top Banner */}
            <div className="text-white py-4 px-4 flex items-center justify-center gap-2 text-sm font-bold" style={{ backgroundColor: '#1D4ED8' }}>

                <span>🎓 Unlock Verified Student Discounts Instantly.</span>
            </div>

            {/* Header */}
            <header className="bg-white border-b border-slate-200">
                <div className="container mx-auto px-4 py-4">
                    <div className="flex items-center justify-between gap-4">
                        <Link href="/" style={{ color: '#1D4ED8' }}>
                            <Image
                                src="/images/awoofLogo.png"
                                alt="Awoof Logo"
                                width={120}
                                height={40}
                                className="object-contain"
                            />
                        </Link>

                        {/* Search Bar */}
                        <form onSubmit={handleSearch} className="flex-1 max-w-2xl mx-4">
                            <div className="relative">
                                <Search className="absolute left-4 top-1/2 transform -translate-y-1/2 h-5 w-5 text-slate-400" />
                                <Input
                                    type="text"
                                    placeholder="Search for deals"
                                    value={searchQuery}
                                    onChange={(e) => setSearchQuery(e.target.value)}
                                    className="pl-12 h-14 w-full rounded-full border border-[#1D4ED8] pr-24"
                                />
                                {searchQuery.trim().length > 0 && (
                                    <Button
                                        type="submit"
                                        size="sm"
                                        className="absolute right-1.5 top-1/2 -translate-y-1/2 rounded-full h-10 px-4 font-medium"
                                        style={{ backgroundColor: '#1D4ED8' }}
                                    >
                                        Search
                                    </Button>
                                )}
                            </div>
                        </form>

                        {/* User Menu */}
                        <div className="flex items-center gap-4">
                            {user ? (
                                <Link href="/student/profile">
                                    <button className="w-10 h-10 rounded-full bg-gray-200 hover:bg-gray-300 transition-colors flex items-center justify-center">
                                        <span className="text-lg font-semibold text-gray-700">
                                            {(() => {
                                                // Try to get first letter of first name from profile
                                                const profile = (user as { profile?: { name?: string } })?.profile;
                                                if (profile?.name) {
                                                    return profile.name.split(' ')[0].charAt(0).toUpperCase();
                                                }
                                                // Fallback to email first letter
                                                return user.email ? user.email.charAt(0).toUpperCase() : 'U';
                                            })()}
                                        </span>
                                    </button>
                                </Link>
                            ) : (
                                <Link href="/auth/student/login">
                                    <Button size="lg" className='rounded-full px-7 text-[#1D4ED8]'>Login</Button>
                                </Link>
                            )}
                        </div>
                    </div>
                </div>
            </header>

            {/* Main Content */}
            <main className="container mx-auto px-4 md:px-6 lg:px-12 xl:px-24 py-8">
                {/* Hero Section - Download App */}
                <div className="rounded-2xl p-8 mb-8 relative overflow-hidden" style={{ backgroundColor: '#1D4ED8' }}>
                    <div className="flex items-center justify-around">
                        <div className="text-white">
                            <h2 className="text-3xl font-bold mb-3">Download the<br /> Awoof App</h2>
                            <p className="text-blue-100 mb-6 max-w-xs">
                                Scan the QR code to download the Awoof app and start unlocking exclusive student discounts.
                            </p>
                        </div>
                        <div className="relative flex items-center justify-center">
                            <Image
                                src="/images/Polygon 3.png"
                                alt="Polygon 1"
                                width={40}
                                height={40}
                                className="absolute top-0 -right-8 transform translate-x-1/2 -translate-y-1/2 z-20"
                            />
                            <Image
                                src="/images/Polygon 2.png"
                                alt="Polygon 2"
                                width={30}
                                height={30}
                                className="absolute bottom-0 -right-8 transform translate-x-1/2 translate-y-1/2 z-20"
                            />
                            <Image
                                src="/images/Polygon 1.png"
                                alt="Polygon 3"
                                width={50}
                                height={50}
                                className="absolute top-2/3 -left-10 transform -translate-x-1/2 -translate-y-1/2 z-20"
                            />
                            <div className="bg-white p-2 relative z-10">
                                <Image
                                    src="/images/awoofQR.png"
                                    alt="Awoof QR Code"
                                    width={200}
                                    height={200}
                                    className="object-contain"
                                />
                            </div>
                        </div>
                    </div>
                </div>

                {/* Statistics */}
                <div className="grid grid-cols-2 gap-4 mb-8">
                    <div className="bg-white rounded-xl p-6 shadow-sm border border-slate-200">
                        <h3 className="text-sm font-medium text-slate-600 mb-2">Money Saved</h3>
                        <p className="text-3xl font-bold" style={{ color: '#1D4ED8' }}>
                            {formatCurrency(savingsStats.totalSavings)}
                        </p>
                    </div>
                    <div className="bg-white rounded-xl p-6 shadow-sm border border-slate-200">
                        <h3 className="text-sm font-medium text-slate-600 mb-2">Total Orders</h3>
                        <p className="text-3xl font-bold" style={{ color: '#1D4ED8' }}>
                            {savingsStats.totalPurchases}
                        </p>
                    </div>
                </div>

                {/* Category Icons */}
                <div className="flex justify-center gap-6 mb-12 flex-wrap">
                    {categories.map((category) => {
                        const { icon: Icon, color, textColor } = getCategoryIcon(category.name);
                        const isActive = selectedCategory === category.id;
                        const bgColor = typeof color === 'string' && color.startsWith('rgba') ? color : undefined;
                        const bgClass = typeof color === 'string' && !color.startsWith('rgba') ? color : '';
                        return (
                            <button
                                key={category.id}
                                onClick={() => setSelectedCategory(category.id)}
                                className={`flex flex-col items-center gap-2 hover:opacity-80 transition-opacity ${isActive ? 'opacity-100' : 'opacity-70'
                                    }`}
                            >
                                <div className={`w-16 h-16 rounded-full ${bgClass} flex items-center justify-center ${isActive ? 'ring-2 ring-offset-1' : ''
                                    }`} style={{
                                        ...(bgColor ? { backgroundColor: bgColor } : {}),
                                        ...(isActive ? { '--tw-ring-color': '#1D4ED8' } as React.CSSProperties & { '--tw-ring-color'?: string } : {}),
                                        ...(textColor ? { color: textColor } : {})
                                    }}>
                                    <Icon className="h-8 w-8" style={textColor ? { color: textColor } : {}} />
                                </div>
                                <span className={`text-sm font-medium ${isActive ? 'font-semibold' : 'text-slate-700'
                                    }`} style={isActive ? { color: '#1D4ED8' } : {}}>
                                    {category.name}
                                </span>
                            </button>
                        );
                    })}
                </div>

                {/* Category Deals - Dynamic based on selected category (above Featured) */}
                {selectedCategory && (
                    <section className="mb-12">
                        <div className="flex items-center justify-between mb-4">
                            <h2 className="text-2xl font-bold text-slate-900">{getSelectedCategoryName()}</h2>
                            <Link
                                href={`/marketplace?categoryId=${selectedCategory}`}
                                className="text-red-600 hover:underline font-medium"
                            >
                                See all
                            </Link>
                        </div>
                        <div className="flex gap-4 overflow-x-auto pb-4 scrollbar-hide">
                            {isLoading ? (
                                <div className="flex items-center justify-center w-full py-12">
                                    <p className="text-slate-500">Loading deals...</p>
                                </div>
                            ) : categoryProducts.length === 0 ? (
                                <div className="flex items-center justify-center w-full py-12">
                                    <p className="text-slate-500">No deals available in this category</p>
                                </div>
                            ) : (
                                categoryProducts.slice(0, 6).map((product) => (
                                    <Link
                                        key={product.id}
                                        href={`/marketplace/${product.id}`}
                                        className="shrink-0 w-80 bg-white rounded-lg shadow-sm hover:shadow-md transition-shadow overflow-hidden"
                                    >
                                        <div className="relative h-48 bg-slate-100">
                                            {product.image_url ? (
                                                <Image
                                                    src={getImageUrl(product.image_url) || ''}
                                                    alt={product.name}
                                                    fill
                                                    className="object-cover"
                                                    unoptimized
                                                />
                                            ) : (
                                                <div className="w-full h-full flex items-center justify-center text-slate-400">
                                                    No Image
                                                </div>
                                            )}
                                            <div className="absolute top-2 right-2 bg-green-500 text-white text-xs font-semibold px-2 py-1 rounded">
                                                {calculateDiscount(product.price, product.student_price)}% OFF
                                            </div>
                                        </div>
                                        <div className="p-4">
                                            <h3 className="font-semibold text-slate-900 mb-1 line-clamp-1">{product.name}</h3>
                                            {product.category_name && (
                                                <p className="text-xs text-slate-500 mb-2">{product.category_name}</p>
                                            )}
                                            <Link
                                                href={`/marketplace/${product.id}`}
                                                className="text-red-600 hover:underline text-sm font-medium"
                                                onClick={(e) => e.stopPropagation()}
                                            >
                                                {product.deal_type === 'voucher' || product.vendor_payment_method === 'vendor_website' ? 'Visit Website' : 'Purchase'}
                                            </Link>
                                        </div>
                                    </Link>
                                ))
                            )}
                        </div>
                    </section>
                )}

                {/* Vouchers - Coupon Style */}
                <section className="mb-12">
                    <div className="flex items-center justify-between mb-4">
                        <h2 className="text-2xl font-bold text-slate-900">Vouchers</h2>
                        <Link href="/marketplace" className="text-red-600 hover:underline font-medium">
                            See all
                        </Link>
                    </div>
                    <div className="flex gap-4 overflow-x-auto pb-4 scrollbar-hide">
                        {voucherProducts.slice(0, 6).map((product) => {
                            const discount = calculateDiscount(product.price, product.student_price);
                            return (
                                <Link
                                    key={product.id}
                                    href={`/marketplace/${product.id}`}
                                    className="shrink-0 w-[420px] md:w-[480px] bg-white rounded-lg shadow-sm hover:shadow-md transition-shadow overflow-hidden flex"
                                    style={{
                                        border: '1px dotted #1D4ED8'
                                    }}
                                >
                                    {/* Left Blue Section - Discount */}
                                    <div
                                        className="flex items-center justify-center px-2 md:px-3 py-6 relative"
                                        style={{
                                            backgroundColor: '#1D4ED8',
                                            minWidth: '60px',
                                            width: '60px'
                                        }}
                                    >
                                        <div className="relative inline-block">
                                            <div
                                                className="absolute inset-0 border-2"
                                                style={{
                                                    borderStyle: 'dotted',
                                                    borderColor: 'rgba(255, 255, 255, 0.5)',
                                                    borderRadius: '0'
                                                }}
                                            />
                                            <span
                                                className="text-white font-light text-xs md:text-sm whitespace-nowrap relative z-10 px-4 py-2 block"
                                                style={{
                                                    writingMode: 'vertical-lr',
                                                    textOrientation: 'mixed',
                                                    transform: 'rotate(180deg)'
                                                }}
                                            >
                                                Discount
                                            </span>
                                        </div>
                                    </div>
                                    <div className="flex-1 p-4 md:p-6 relative bg-white">
                                        <div className="flex items-center justify-between mb-3 relative z-10">
                                            <div className="flex items-center gap-3 flex-1 min-w-0">
                                                {product.vendor_logo_url ? (
                                                    <div className="w-10 h-10 md:w-12 md:h-12 rounded-lg overflow-hidden relative shrink-0">
                                                        <Image
                                                            src={getImageUrl(product.vendor_logo_url) || ''}
                                                            alt={product.vendor_name || 'Vendor logo'}
                                                            fill
                                                            className="object-cover"
                                                            unoptimized
                                                        />
                                                    </div>
                                                ) : product.vendor_name ? (
                                                    <div
                                                        className="w-10 h-10 md:w-12 md:h-12 rounded-lg flex items-center justify-center font-bold text-white text-xs shrink-0"
                                                        style={{ backgroundColor: '#1D4ED8' }}
                                                    >
                                                        {product.vendor_name.substring(0, 2).toUpperCase()}
                                                    </div>
                                                ) : (
                                                    <div
                                                        className="w-10 h-10 md:w-12 md:h-12 rounded-lg flex items-center justify-center shrink-0"
                                                        style={{ backgroundColor: '#1D4ED8' }}
                                                    >
                                                        <ShoppingBag className="h-5 w-5 md:h-6 md:w-6 text-white" />
                                                    </div>
                                                )}
                                                <div
                                                    className="text-xl md:text-2xl font-bold whitespace-nowrap"
                                                    style={{ color: '#1D4ED8' }}
                                                >
                                                    {discount}% OFF
                                                </div>
                                            </div>
                                            <div className="flex items-center gap-3 shrink-0">
                                                <div
                                                    className="w-px h-8"
                                                    style={{ borderLeft: '1px dashed #1D4ED8' }}
                                                />
                                                <Link
                                                    href={`/marketplace/${product.id}`}
                                                    className="text-red-600 underline text-xs font-medium whitespace-nowrap"
                                                    onClick={(e) => e.stopPropagation()}
                                                >
                                                    {product.deal_type === 'voucher' || product.vendor_payment_method === 'vendor_website' ? 'Visit website' : 'Purchase'}
                                                </Link>
                                            </div>
                                        </div>
                                        <div className="w-full h-px mb-3" style={{ borderTop: '1px dashed #1D4ED8' }} />
                                        <div className="mb-3 relative z-10">
                                            <p className="text-xs whitespace-nowrap" style={{ color: '#1D4ED8' }}>
                                                {discount}% discount on all products available for students
                                            </p>
                                        </div>
                                        <div className="w-full h-px" style={{ borderTop: '1px dashed #1D4ED8' }} />
                                    </div>
                                </Link>
                            );
                        })}
                    </div>
                </section>

                {/* Featured Deals */}
                <section className="mb-12">
                    <div className="flex items-center justify-between mb-4">
                        <h2 className="text-2xl font-bold text-slate-900">Featured Deals</h2>
                        <Link href="/marketplace" className="text-red-600 hover:underline font-medium">
                            See all
                        </Link>
                    </div>
                    <div className="flex gap-4 overflow-x-auto pb-4 scrollbar-hide">
                        {isLoading ? (
                            <div className="flex items-center justify-center w-full py-12">
                                <p className="text-slate-500">Loading deals...</p>
                            </div>
                        ) : featuredProducts.length === 0 ? (
                            <div className="flex items-center justify-center w-full py-12">
                                <p className="text-slate-500">No featured deals available</p>
                            </div>
                        ) : (
                            featuredProducts.map((product) => {
                                const discount = calculateDiscount(product.price, product.student_price);
                                return (
                                    <Link
                                        key={product.id}
                                        href={`/marketplace/${product.id}`}
                                        className="shrink-0 w-72 md:w-80 lg:w-96 bg-white rounded-lg shadow-sm hover:shadow-md transition-shadow overflow-hidden flex flex-col"
                                    >
                                        {/* Top Half: Banner Image */}
                                        <div className="relative w-full h-32 md:h-36 lg:h-40 bg-slate-100 shrink-0">
                                            {product.image_url ? (
                                                <Image
                                                    src={getImageUrl(product.image_url) || ''}
                                                    alt={product.name}
                                                    fill
                                                    className="object-cover"
                                                    unoptimized
                                                />
                                            ) : (
                                                <div className="w-full h-full flex items-center justify-center text-slate-400">
                                                    No Image
                                                </div>
                                            )}
                                        </div>

                                        {/* Bottom Half: White Card Space */}
                                        <div className="w-full p-3 md:p-4 lg:p-5 bg-white flex flex-col relative flex-1 h-32 md:h-36 lg:h-40">
                                            {/* White circle with vendor logo - positioned at border between banner and content */}
                                            <div className="absolute -top-6 md:-top-7 lg:-top-8 left-3 md:left-4 z-10">
                                                <div className="w-12 h-12 md:w-14 md:h-14 lg:w-16 lg:h-16 rounded-full bg-white flex items-center justify-center shadow-md p-1 md:p-1.5 lg:p-3">
                                                    {product.vendor_logo_url ? (
                                                        <div className="w-full h-full rounded overflow-hidden relative">
                                                            <Image
                                                                src={getImageUrl(product.vendor_logo_url) || ''}
                                                                alt={product.vendor_name || 'Vendor logo'}
                                                                fill
                                                                className="object-cover"
                                                                unoptimized
                                                            />
                                                        </div>
                                                    ) : product.vendor_name ? (
                                                        <div
                                                            className="w-full h-full rounded flex items-center justify-center font-bold text-white text-xs"
                                                            style={{ backgroundColor: '#1D4ED8' }}
                                                        >
                                                            {product.vendor_name.substring(0, 2).toUpperCase()}
                                                        </div>
                                                    ) : (
                                                        <div
                                                            className="w-full h-full rounded flex items-center justify-center"
                                                            style={{ backgroundColor: '#1D4ED8' }}
                                                        >
                                                            <ShoppingBag className="h-4 w-4 md:h-5 md:w-5 lg:h-6 lg:w-6 text-white" />
                                                        </div>
                                                    )}
                                                </div>
                                            </div>

                                            {/* Row 1: Percentage off as small green pill at top right */}
                                            <div className="flex justify-end mb-1.5 md:mb-2">
                                                <div className="bg-green-100 text-green-700 text-xs font-semibold px-2 py-1 rounded-full">
                                                    {discount}% OFF
                                                </div>
                                            </div>

                                            {/* Row 2: Product name on the left */}
                                            <div className="mb-1.5 md:mb-2">
                                                <h3 className="font-semibold text-slate-900 text-sm md:text-base line-clamp-2">{product.name}</h3>
                                            </div>

                                            {/* Row 3: Category name and CTA link */}
                                            <div className="flex items-center justify-between mt-auto">
                                                {/* Category name */}
                                                {product.category_name && (
                                                    <p className="text-xs md:text-sm text-red-600 font-normal">{product.category_name}</p>
                                                )}
                                                {/* CTA: Visit website (vendor_website) or Purchase (awoof) */}
                                                <Link
                                                    href={`/marketplace/${product.id}`}
                                                    className="text-red-600 underline text-xs font-medium whitespace-nowrap"
                                                    onClick={(e) => e.stopPropagation()}
                                                >
                                                    {product.deal_type === 'voucher' || product.vendor_payment_method === 'vendor_website' ? 'Visit website' : 'Purchase'}
                                                </Link>
                                            </div>
                                        </div>
                                    </Link>
                                );
                            })
                        )}
                    </div>
                </section>
            </main>

            {/* Footer */}
            <footer className="text-white py-6" style={{ backgroundColor: '#1D4ED8' }}>
                <div className="container mx-auto px-4">
                    <div className="flex items-center justify-between flex-wrap gap-4">
                        <Image
                            src="/images/awoofLogo.png"
                            alt="Awoof Logo"
                            width={120}
                            height={40}
                            className="object-contain"
                        />
                        <div className="flex items-center gap-6">
                            <Link href="/contact" className="hover:underline text-sm">Contact Us</Link>
                            <Link href="/partner" className="hover:underline text-sm">Partner With Us</Link>
                            <Link href="/privacy" className="hover:underline text-sm">Privacy Policy</Link>
                            <Link href="/terms" className="hover:underline text-sm">Terms of Use</Link>
                        </div>
                        <Button variant="outline" size="sm" className="bg-white/10 border-white text-white hover:bg-white/20">
                            <Smartphone className="h-4 w-4 mr-2" />
                            Get the App
                        </Button>
                    </div>
                    <div className="mt-4 text-center text-sm text-blue-100">
                        ©2025 Awoof — Empowering Students, One Discount at a Time
                    </div>
                </div>
            </footer>
        </div>
    );
}
