/**
 * Marketplace — Student home
 * Friendly empty states + expectancy when no deals yet.
 */

'use client';

import { useState, useEffect, useCallback } from 'react';
import {
    Search,
    Plane,
    ShoppingBag,
    Monitor,
    Utensils,
    Sparkles,
    Smartphone,
    Zap,
} from 'lucide-react';
import { Input } from '@/components/ui/input';
import { Button } from '@/components/ui/button';
import apiClient, { getImageUrl } from '@/lib/api-client';
import Image from 'next/image';
import Link from 'next/link';
import { useAuth } from '@/contexts/AuthContext';
import { formatCurrency } from '@/lib/format';
import { DealSkeletonRail, ExpectancyEmpty, FadeIn } from './_components/ExpectancyUI';
import { StudentHeaderActions } from '@/components/student/StudentHeaderActions';

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

const categoryIconMap: Record<string, { icon: typeof Plane; color: string; textColor?: string }> = {
    travel: { icon: Plane, color: 'rgba(29, 78, 216, 0.12)', textColor: '#1D4ED8' },
    food: { icon: Utensils, color: 'bg-amber-100 text-amber-700' },
    shopping: { icon: ShoppingBag, color: 'bg-emerald-100 text-emerald-700' },
    tech: { icon: Monitor, color: 'rgba(29, 78, 216, 0.12)', textColor: '#1D4ED8' },
    'beauty & spa': { icon: Sparkles, color: 'bg-rose-100 text-rose-600' },
    beauty: { icon: Sparkles, color: 'bg-rose-100 text-rose-600' },
    spa: { icon: Sparkles, color: 'bg-rose-100 text-rose-600' },
};

function getFirstName(user: { email?: string; profile?: { name?: string } } | null | undefined): string {
    if (!user) return 'there';
    if (user.profile?.name) return user.profile.name.split(' ')[0];
    if (user.email) return user.email.split('@')[0];
    return 'there';
}

export default function MarketplacePage() {
    const { user } = useAuth();
    const [voucherProducts, setVoucherProducts] = useState<Product[]>([]);
    const [categories, setCategories] = useState<Category[]>([]);
    const [featuredProducts, setFeaturedProducts] = useState<Product[]>([]);
    const [categoryProducts, setCategoryProducts] = useState<Product[]>([]);
    const [selectedCategory, setSelectedCategory] = useState<string | null>(null);
    const [savingsStats, setSavingsStats] = useState<SavingsStats>({ totalSavings: 0, totalPurchases: 0 });
    const [isLoading, setIsLoading] = useState(true);
    const [searchQuery, setSearchQuery] = useState('');

    const firstName = getFirstName(user as { email?: string; profile?: { name?: string } } | null);
    const isVerified = user?.verificationStatus === 'verified';
    const hasAnyDeals = featuredProducts.length > 0 || voucherProducts.length > 0;

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
            const [productsRes, vouchersRes, categoriesRes] = await Promise.all([
                apiClient.get('/products?limit=20&deal_type=product').catch(() => null),
                apiClient.get('/products?limit=20&deal_type=voucher').catch(() => null),
                apiClient.get('/products/categories').catch(() => null),
            ]);

            const allProducts = productsRes?.data?.data?.products || [];
            const vouchers = vouchersRes?.data?.data?.products || [];
            const fetchedCategories = categoriesRes?.data?.data || [];

            setVoucherProducts(vouchers);
            setCategories(fetchedCategories);
            setFeaturedProducts(allProducts.slice(0, 6));

            setSelectedCategory((prev) => {
                if (prev) return prev;
                if (fetchedCategories.length === 0) return null;

                const counts = new Map<string, number>();
                for (const p of allProducts as Product[]) {
                    if (p.category_id) {
                        counts.set(p.category_id, (counts.get(p.category_id) || 0) + 1);
                    }
                }

                const withData = fetchedCategories.filter(
                    (c: Category) => (counts.get(c.id) || 0) > 0
                );

                if (withData.length > 0 && withData.length < fetchedCategories.length) {
                    return withData[0].id;
                }
                return fetchedCategories[0].id;
            });
        } catch (error) {
            console.error('Error fetching data:', error);
        } finally {
            setIsLoading(false);
        }
    }, []);

    useEffect(() => {
        fetchData();
    }, [fetchData]);

    useEffect(() => {
        if (!user) {
            setSavingsStats({ totalSavings: 0, totalPurchases: 0 });
            return;
        }
        let cancelled = false;
        (async () => {
            try {
                const savingsRes = await apiClient.get('/students/savings');
                if (cancelled) return;
                if (savingsRes?.data?.data?.summary) {
                    setSavingsStats({
                        totalSavings: savingsRes.data.data.summary.totalSavings || 0,
                        totalPurchases: savingsRes.data.data.summary.totalPurchases || 0,
                    });
                }
            } catch {
                // non-students / unauthenticated — keep zeros
            }
        })();
        return () => {
            cancelled = true;
        };
    }, [user?.id]);

    useEffect(() => {
        if (selectedCategory) {
            fetchCategoryProducts(selectedCategory);
        }
    }, [selectedCategory, fetchCategoryProducts]);

    const handleSearch = (e: React.FormEvent) => {
        e.preventDefault();
        window.location.assign(`/marketplace/search?q=${encodeURIComponent(searchQuery)}`);
    };

    const calculateDiscount = (price: number, studentPrice: number) => {
        if (!price) return 0;
        return Math.round(((price - studentPrice) / price) * 100);
    };

    const getCategoryIcon = (categoryName: string) => {
        const normalizedName = categoryName.toLowerCase();
        const match =
            categoryIconMap[normalizedName] ||
            Object.entries(categoryIconMap).find(
                ([key]) => normalizedName.includes(key) || key.includes(normalizedName)
            )?.[1];
        return match || { icon: ShoppingBag, color: 'bg-slate-100', textColor: '#64748b' };
    };

    const getSelectedCategoryName = () => {
        if (!selectedCategory) return 'Deals';
        const category = categories.find((c) => c.id === selectedCategory);
        return category ? `${category.name} Deals` : 'Deals';
    };

    const avatarLetter = (() => {
        const profile = (user as { profile?: { name?: string } } | null)?.profile;
        if (profile?.name) return profile.name.split(' ')[0].charAt(0).toUpperCase();
        return user?.email ? user.email.charAt(0).toUpperCase() : 'U';
    })();

    return (
        <div className="min-h-screen bg-[#F4F7FD] text-slate-900">
            {/* Soft atmosphere wash */}
            <div
                aria-hidden
                className="pointer-events-none fixed inset-0 -z-10"
                style={{
                    background:
                        'radial-gradient(ellipse 80% 50% at 50% -10%, rgba(29,78,216,0.14), transparent 55%), radial-gradient(ellipse 40% 30% at 100% 20%, rgba(56,189,248,0.08), transparent)',
                }}
            />

            <div className="bg-[#1D4ED8] text-white py-2.5 px-4 flex items-center justify-center gap-2 text-xs sm:text-sm font-semibold tracking-wide">
                <Zap className="h-3.5 w-3.5 shrink-0 opacity-90" />
                <span>Student-only discounts — verified campus prices</span>
            </div>

            <header className="sticky top-0 z-40 bg-white/80 backdrop-blur-md border-b border-slate-200/80">
                <div className="mx-auto max-w-6xl px-4 py-3">
                    <div className="flex items-center justify-between gap-3">
                        <Link href="/" className="shrink-0">
                            <Image
                                src="/images/awoofLogoMain.png"
                                alt="Awoof"
                                width={108}
                                height={36}
                                className="object-contain"
                            />
                        </Link>

                        <form onSubmit={handleSearch} className="flex-1 max-w-xl mx-2 hidden sm:block">
                            <div className="relative">
                                <Search className="absolute left-3.5 top-1/2 -translate-y-1/2 h-4 w-4 text-slate-400" />
                                <Input
                                    type="text"
                                    placeholder="Search deals, brands, campuses…"
                                    value={searchQuery}
                                    onChange={(e) => setSearchQuery(e.target.value)}
                                    className="pl-10 h-11 w-full rounded-full border-slate-200 bg-slate-50/80 focus-visible:ring-[#1D4ED8]"
                                />
                                {searchQuery.trim().length > 0 && (
                                    <Button
                                        type="submit"
                                        size="sm"
                                        className="absolute right-1.5 top-1/2 -translate-y-1/2 rounded-full h-8 px-3 bg-[#1D4ED8] hover:bg-[#1E40AF]"
                                    >
                                        Search
                                    </Button>
                                )}
                            </div>
                        </form>

                        {user ? (
                            <StudentHeaderActions avatarLetter={avatarLetter} showProfileLink />
                        ) : (
                            <Link href="/auth/student/login">
                                <Button className="rounded-full bg-[#1D4ED8] hover:bg-[#1E40AF]">Log in</Button>
                            </Link>
                        )}
                    </div>

                    <form onSubmit={handleSearch} className="mt-3 sm:hidden">
                        <div className="relative">
                            <Search className="absolute left-3.5 top-1/2 -translate-y-1/2 h-4 w-4 text-slate-400" />
                            <Input
                                type="text"
                                placeholder="Search deals…"
                                value={searchQuery}
                                onChange={(e) => setSearchQuery(e.target.value)}
                                className="pl-10 h-11 w-full rounded-full border-slate-200 bg-white"
                            />
                        </div>
                    </form>
                </div>
            </header>

            <main className="mx-auto max-w-6xl px-4 py-8 md:py-10 space-y-10">
                {/* Welcome + expectancy */}
                <FadeIn>
                    <section className="relative overflow-hidden rounded-3xl bg-[#1D4ED8] text-white px-6 py-8 md:px-10 md:py-10 shadow-xl shadow-[#1D4ED8]/20">
                        <div
                            aria-hidden
                            className="absolute -right-16 -top-16 h-56 w-56 rounded-full bg-white/10 blur-2xl"
                        />
                        <div
                            aria-hidden
                            className="absolute -bottom-20 left-1/3 h-48 w-48 rounded-full bg-sky-300/20 blur-3xl"
                        />
                        <div className="relative flex flex-col lg:flex-row lg:items-end lg:justify-between gap-8">
                            <div className="max-w-xl space-y-3">
                                <p className="text-blue-100 text-sm font-medium tracking-wide uppercase">
                                    Your student pass
                                </p>
                                <h1 className="text-3xl md:text-4xl font-extrabold tracking-tight text-balance leading-[1.15]">
                                    Hey {firstName}, savings are warming up
                                </h1>
                                <p className="text-blue-100/95 text-[15px] md:text-base leading-relaxed text-pretty">
                                    {hasAnyDeals
                                        ? 'Browse verified campus deals below — every price is locked for students like you.'
                                        : isVerified
                                          ? 'You’re verified and ready. Merchants are onboarding — your first exclusive offers will land here.'
                                          : 'Verify once, then unlock student prices the moment new deals go live.'}
                                </p>
                                {!isVerified && user && (
                                    <Link
                                        href="/student/profile"
                                        className="inline-flex items-center gap-2 mt-2 rounded-full bg-white text-[#1D4ED8] text-sm font-bold px-5 py-2.5 hover:bg-blue-50 transition-colors"
                                    >
                                        Finish verification
                                        <Sparkles className="h-4 w-4" />
                                    </Link>
                                )}
                            </div>
                            <div className="flex items-center gap-4 shrink-0">
                                <div className="hidden md:block bg-white p-2 rounded-2xl shadow-lg">
                                    <Image
                                        src="/images/awoofQR.png"
                                        alt="Download Awoof"
                                        width={112}
                                        height={112}
                                        className="object-contain rounded-lg"
                                    />
                                </div>
                                <div className="text-sm text-blue-100 max-w-[9rem] leading-snug">
                                    <Smartphone className="h-5 w-5 mb-2 opacity-90" />
                                    Scan for the app — same deals, faster checkout
                                </div>
                            </div>
                        </div>
                    </section>
                </FadeIn>

                {/* Savings journey */}
                <FadeIn delay={0.06}>
                    <div className="grid grid-cols-2 gap-3 md:gap-4">
                        <div className="rounded-2xl bg-white border border-slate-200/80 p-5 md:p-6 relative overflow-hidden">
                            <div className="absolute right-0 top-0 h-20 w-20 bg-[#1D4ED8]/5 rounded-bl-[4rem]" />
                            <p className="text-xs font-semibold uppercase tracking-wider text-slate-500 mb-2">
                                Money saved
                            </p>
                            <p className="text-2xl md:text-3xl font-extrabold text-[#1D4ED8] tracking-tight">
                                {formatCurrency(savingsStats.totalSavings)}
                            </p>
                            {savingsStats.totalSavings === 0 && (
                                <p className="mt-2 text-xs text-slate-500 leading-snug">
                                    Your first discount will show up here
                                </p>
                            )}
                        </div>
                        <div className="rounded-2xl bg-white border border-slate-200/80 p-5 md:p-6 relative overflow-hidden">
                            <div className="absolute right-0 top-0 h-20 w-20 bg-emerald-500/5 rounded-bl-[4rem]" />
                            <p className="text-xs font-semibold uppercase tracking-wider text-slate-500 mb-2">
                                Total orders
                            </p>
                            <p className="text-2xl md:text-3xl font-extrabold text-[#1D4ED8] tracking-tight">
                                {savingsStats.totalPurchases}
                            </p>
                            {savingsStats.totalPurchases === 0 && (
                                <p className="mt-2 text-xs text-slate-500 leading-snug">
                                    Ready when the first deal drops
                                </p>
                            )}
                        </div>
                    </div>
                </FadeIn>

                {/* Categories */}
                {categories.length > 0 && (
                    <FadeIn delay={0.1}>
                        <div>
                            <p className="text-xs font-semibold uppercase tracking-wider text-slate-500 mb-3">
                                Browse by vibe
                            </p>
                            <div className="-mx-1 px-1 flex gap-4 md:gap-6 overflow-x-auto pt-3 pb-3 scrollbar-hide justify-start md:justify-center">
                                {categories.map((category) => {
                                    const { icon: Icon, color, textColor } = getCategoryIcon(category.name);
                                    const isActive = selectedCategory === category.id;
                                    const bgColor =
                                        typeof color === 'string' && color.startsWith('rgba') ? color : undefined;
                                    const bgClass =
                                        typeof color === 'string' && !color.startsWith('rgba') ? color : '';
                                    return (
                                        <button
                                            key={category.id}
                                            type="button"
                                            onClick={() => setSelectedCategory(category.id)}
                                            className={`flex flex-col items-center gap-2.5 shrink-0 transition-opacity ${
                                                isActive ? 'opacity-100' : 'opacity-70 hover:opacity-100'
                                            }`}
                                        >
                                            <div
                                                className={`w-14 h-14 md:w-16 md:h-16 rounded-2xl ${bgClass} flex items-center justify-center transition-[box-shadow,transform] ${
                                                    isActive
                                                        ? 'ring-2 ring-[#1D4ED8] shadow-md'
                                                        : 'hover:-translate-y-0.5'
                                                }`}
                                                style={{
                                                    ...(bgColor ? { backgroundColor: bgColor } : {}),
                                                    ...(textColor ? { color: textColor } : {}),
                                                }}
                                            >
                                                <Icon
                                                    className="h-6 w-6 md:h-7 md:w-7"
                                                    style={textColor ? { color: textColor } : {}}
                                                />
                                            </div>
                                            <span
                                                className={`text-xs md:text-sm font-semibold whitespace-nowrap ${
                                                    isActive ? 'text-[#1D4ED8]' : 'text-slate-600'
                                                }`}
                                            >
                                                {category.name}
                                            </span>
                                        </button>
                                    );
                                })}
                            </div>
                        </div>
                    </FadeIn>
                )}

                {/* Category deals */}
                {selectedCategory && (
                    <FadeIn delay={0.12}>
                        <section>
                            <div className="flex items-end justify-between mb-4 gap-3">
                                <div>
                                    <h2 className="text-xl md:text-2xl font-extrabold tracking-tight text-slate-900">
                                        {getSelectedCategoryName()}
                                    </h2>
                                    <p className="text-sm text-slate-500 mt-0.5">Hand-picked for this category</p>
                                </div>
                                {categoryProducts.length > 0 && (
                                    <Link
                                        href={`/marketplace/search?categoryId=${selectedCategory}`}
                                        className="text-sm font-semibold text-[#1D4ED8] hover:underline shrink-0"
                                    >
                                        See all
                                    </Link>
                                )}
                            </div>
                            {isLoading ? (
                                <DealSkeletonRail />
                            ) : categoryProducts.length === 0 ? (
                                <ExpectancyEmpty kind="category" />
                            ) : (
                                <div className="flex gap-4 overflow-x-auto pb-4 scrollbar-hide">
                                    {categoryProducts.slice(0, 6).map((product) => (
                                        <Link
                                            key={product.id}
                                            href={`/marketplace/${product.id}`}
                                            className="shrink-0 w-72 bg-white rounded-2xl border border-slate-200/80 overflow-hidden hover:border-[#1D4ED8]/30 hover:-translate-y-0.5 transition-all duration-200"
                                        >
                                            <div className="relative h-40 bg-slate-100">
                                                {product.image_url ? (
                                                    <Image
                                                        src={getImageUrl(product.image_url) || ''}
                                                        alt={product.name}
                                                        fill
                                                        className="object-cover"
                                                        unoptimized
                                                    />
                                                ) : (
                                                    <div className="w-full h-full flex items-center justify-center bg-gradient-to-br from-[#EEF2FF] to-[#DBEAFE] text-[#1D4ED8]/40">
                                                        <ShoppingBag className="h-10 w-10" />
                                                    </div>
                                                )}
                                                <div className="absolute top-2 right-2 bg-emerald-500 text-white text-[11px] font-bold px-2 py-1 rounded-full">
                                                    {calculateDiscount(product.price, product.student_price)}% OFF
                                                </div>
                                            </div>
                                            <div className="p-4">
                                                <h3 className="font-bold text-slate-900 line-clamp-1">{product.name}</h3>
                                                {product.category_name && (
                                                    <p className="text-xs text-slate-500 mt-1">{product.category_name}</p>
                                                )}
                                                <p className="mt-3 text-sm font-bold text-[#1D4ED8]">
                                                    {formatCurrency(product.student_price)}
                                                </p>
                                            </div>
                                        </Link>
                                    ))}
                                </div>
                            )}
                        </section>
                    </FadeIn>
                )}

                {/* Vouchers */}
                <FadeIn delay={0.16}>
                    <section>
                        <div className="flex items-end justify-between mb-4 gap-3">
                            <div>
                                <h2 className="text-xl md:text-2xl font-extrabold tracking-tight text-slate-900">
                                    Vouchers
                                </h2>
                                <p className="text-sm text-slate-500 mt-0.5">Codes & campus perks</p>
                            </div>
                            {voucherProducts.length > 0 && (
                                <Link href="/marketplace" className="text-sm font-semibold text-[#1D4ED8] hover:underline">
                                    See all
                                </Link>
                            )}
                        </div>
                        {isLoading ? (
                            <DealSkeletonRail />
                        ) : voucherProducts.length === 0 ? (
                            <ExpectancyEmpty kind="vouchers" />
                        ) : (
                            <div className="flex gap-4 overflow-x-auto pb-4 scrollbar-hide">
                                {voucherProducts.slice(0, 6).map((product) => {
                                    const discount = calculateDiscount(product.price, product.student_price);
                                    return (
                                        <Link
                                            key={product.id}
                                            href={`/marketplace/${product.id}`}
                                            className="shrink-0 w-[380px] md:w-[440px] bg-white rounded-2xl overflow-hidden flex border border-dashed border-[#1D4ED8]/50 hover:border-[#1D4ED8] transition-colors"
                                        >
                                            <div className="flex items-center justify-center px-3 py-6 bg-[#1D4ED8] min-w-[56px]">
                                                <span
                                                    className="text-white text-xs font-semibold tracking-wide"
                                                    style={{
                                                        writingMode: 'vertical-lr',
                                                        transform: 'rotate(180deg)',
                                                    }}
                                                >
                                                    Voucher
                                                </span>
                                            </div>
                                            <div className="flex-1 p-5 flex flex-col justify-center gap-2">
                                                <p className="text-2xl font-extrabold text-[#1D4ED8]">{discount}% OFF</p>
                                                <p className="text-sm text-slate-600 line-clamp-2">{product.name}</p>
                                                <span className="text-xs font-bold text-[#1D4ED8] mt-1">Claim →</span>
                                            </div>
                                        </Link>
                                    );
                                })}
                            </div>
                        )}
                    </section>
                </FadeIn>

                {/* Featured */}
                <FadeIn delay={0.2}>
                    <section className="pb-4">
                        <div className="flex items-end justify-between mb-4 gap-3">
                            <div>
                                <h2 className="text-xl md:text-2xl font-extrabold tracking-tight text-slate-900">
                                    Featured deals
                                </h2>
                                <p className="text-sm text-slate-500 mt-0.5">What everyone’s talking about</p>
                            </div>
                            {featuredProducts.length > 0 && (
                                <Link href="/marketplace/search" className="text-sm font-semibold text-[#1D4ED8] hover:underline">
                                    See all
                                </Link>
                            )}
                        </div>
                        {isLoading ? (
                            <DealSkeletonRail count={4} />
                        ) : featuredProducts.length === 0 ? (
                            <ExpectancyEmpty kind="deals" />
                        ) : (
                            <div className="flex gap-4 overflow-x-auto pb-4 scrollbar-hide">
                                {featuredProducts.map((product) => {
                                    const discount = calculateDiscount(product.price, product.student_price);
                                    return (
                                        <Link
                                            key={product.id}
                                            href={`/marketplace/${product.id}`}
                                            className="shrink-0 w-72 md:w-80 bg-white rounded-2xl border border-slate-200/80 overflow-hidden hover:-translate-y-0.5 transition-transform duration-200"
                                        >
                                            <div className="relative h-36 bg-slate-100">
                                                {product.image_url ? (
                                                    <Image
                                                        src={getImageUrl(product.image_url) || ''}
                                                        alt={product.name}
                                                        fill
                                                        className="object-cover"
                                                        unoptimized
                                                    />
                                                ) : (
                                                    <div className="w-full h-full flex items-center justify-center bg-gradient-to-br from-[#EEF2FF] to-[#DBEAFE]">
                                                        <ShoppingBag className="h-10 w-10 text-[#1D4ED8]/35" />
                                                    </div>
                                                )}
                                            </div>
                                            <div className="p-4 pt-5 relative">
                                                <div className="absolute -top-5 left-4 w-12 h-12 rounded-full bg-white shadow flex items-center justify-center overflow-hidden border border-slate-100">
                                                    {product.vendor_logo_url ? (
                                                        <Image
                                                            src={getImageUrl(product.vendor_logo_url) || ''}
                                                            alt=""
                                                            width={48}
                                                            height={48}
                                                            className="object-cover"
                                                            unoptimized
                                                        />
                                                    ) : (
                                                        <span className="text-xs font-bold text-[#1D4ED8]">
                                                            {(product.vendor_name || 'AW').substring(0, 2).toUpperCase()}
                                                        </span>
                                                    )}
                                                </div>
                                                <div className="flex justify-end mb-2">
                                                    <span className="bg-emerald-100 text-emerald-700 text-[11px] font-bold px-2 py-0.5 rounded-full">
                                                        {discount}% OFF
                                                    </span>
                                                </div>
                                                <h3 className="font-bold text-slate-900 line-clamp-2 text-sm md:text-base">
                                                    {product.name}
                                                </h3>
                                                <div className="mt-3 flex items-center justify-between">
                                                    <span className="text-sm font-extrabold text-[#1D4ED8]">
                                                        {formatCurrency(product.student_price)}
                                                    </span>
                                                    <span className="text-xs font-semibold text-slate-500">
                                                        {product.deal_type === 'voucher' ||
                                                        product.vendor_payment_method === 'vendor_website'
                                                            ? 'Visit site'
                                                            : 'Buy'}
                                                    </span>
                                                </div>
                                            </div>
                                        </Link>
                                    );
                                })}
                            </div>
                        )}
                    </section>
                </FadeIn>
            </main>

            <footer className="bg-[#1D4ED8] text-white mt-4">
                <div className="mx-auto max-w-6xl px-4 py-8">
                    <div className="flex flex-col md:flex-row md:items-center justify-between gap-6">
                        <Image
                            src="/images/awoofLogo.png"
                            alt="Awoof"
                            width={100}
                            height={34}
                            className="object-contain brightness-0 invert"
                        />
                        <div className="flex flex-wrap gap-x-6 gap-y-2 text-sm text-blue-100">
                            <Link href="/contact" className="hover:text-white">
                                Contact
                            </Link>
                            <Link href="/partner" className="hover:text-white">
                                Partner
                            </Link>
                            <Link href="/privacy" className="hover:text-white">
                                Privacy
                            </Link>
                            <Link href="/terms" className="hover:text-white">
                                Terms
                            </Link>
                        </div>
                        <Button
                            variant="outline"
                            size="sm"
                            className="rounded-full border-white/40 bg-white/10 text-white hover:bg-white/20 w-fit"
                        >
                            <Smartphone className="h-4 w-4 mr-2" />
                            Get the app
                        </Button>
                    </div>
                    <p className="mt-6 text-center text-xs text-blue-200">
                        © {new Date().getFullYear()} Awoof — Empowering students, one discount at a time
                    </p>
                </div>
            </footer>
        </div>
    );
}
