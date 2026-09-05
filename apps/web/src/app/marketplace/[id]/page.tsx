/**
 * Product detail — marketplace deal page
 */

'use client';

import { useState, useEffect } from 'react';
import { useParams, useRouter } from 'next/navigation';
import {
    ArrowLeft,
    ShoppingCart,
    Check,
    Package,
    Store,
    Tag,
    Sparkles,
    ShieldCheck,
} from 'lucide-react';
import { Button } from '@/components/ui/button';
import apiClient, { getImageUrl } from '@/lib/api-client';
import Image from 'next/image';
import Link from 'next/link';
import { useAuth } from '@/contexts/AuthContext';
import { formatCurrency } from '@/lib/format';
import toast from 'react-hot-toast';
import { getApiErrorMessage } from '@/lib/api-error';
import { FadeIn } from '../_components/ExpectancyUI';
import { MarketplaceAtmosphere } from '../_components/DealCard';
import { StudentHeaderActions } from '@/components/student/StudentHeaderActions';
import { motion, useReducedMotion } from 'framer-motion';

interface Product {
    id: string;
    name: string;
    description: string;
    price: number;
    student_price: number;
    image_url: string | null;
    stock: number;
    category_id: string;
    category_name: string;
    category_slug: string;
    vendor_id: string;
    vendor_name: string;
    vendor_description: string | null;
    vendor_website?: string | null;
    vendor_payment_method?: 'awoof' | 'vendor_website';
    deal_type?: 'product' | 'voucher';
    created_at: string;
}

export default function ProductDetailPage() {
    const params = useParams();
    const router = useRouter();
    const { user } = useAuth();
    const productId = params.id as string;
    const [product, setProduct] = useState<Product | null>(null);
    const [isLoading, setIsLoading] = useState(true);
    const [isPurchasing, setIsPurchasing] = useState(false);
    const reduce = useReducedMotion();

    useEffect(() => {
        if (productId) {
            void fetchProduct();
        }
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [productId]);

    const fetchProduct = async () => {
        try {
            setIsLoading(true);
            const response = await apiClient.get(`/products/${productId}`);
            setProduct(response.data.data.product);
        } catch (error) {
            console.error('Error fetching product:', error);
            toast.error(getApiErrorMessage(error, 'Could not load this deal'));
        } finally {
            setIsLoading(false);
        }
    };

    const handlePurchase = async () => {
        if (!product) return;

        if (product.deal_type === 'voucher' || product.vendor_payment_method === 'vendor_website') {
            if (product.vendor_website) {
                window.open(product.vendor_website, '_blank', 'noopener,noreferrer');
            } else {
                toast.error('This vendor has not configured a redemption website yet.');
            }
            return;
        }

        if (!user) {
            router.push('/auth/student/login?redirect=/marketplace/' + productId);
            return;
        }

        if (user.verificationStatus !== 'verified') {
            toast.error('Please verify your student status to purchase products.');
            router.push('/marketplace');
            return;
        }

        try {
            setIsPurchasing(true);
            const response = await apiClient.post('/checkout', { productId });
            const authorizationUrl = response.data.data?.authorizationUrl;
            if (authorizationUrl) {
                window.location.href = authorizationUrl;
            } else {
                toast.error('Could not start checkout');
            }
        } catch (error: unknown) {
            toast.error(getApiErrorMessage(error, 'Checkout failed'));
        } finally {
            setIsPurchasing(false);
        }
    };

    const discount = product
        ? Math.round(((product.price - product.student_price) / product.price) * 100)
        : 0;
    const savings = product ? product.price - product.student_price : 0;
    const isExternal =
        product?.deal_type === 'voucher' || product?.vendor_payment_method === 'vendor_website';
    const isUnavailable = !isExternal && product?.stock === 0;

    const avatarLetter = (() => {
        const profile = (user as { profile?: { name?: string } } | null)?.profile;
        if (profile?.name) return profile.name.split(' ')[0].charAt(0).toUpperCase();
        if (user?.email) return user.email.charAt(0).toUpperCase();
        return 'U';
    })();

    if (isLoading) {
        return (
            <div className="min-h-screen bg-[#F4F7FD]">
                <MarketplaceAtmosphere />
                <div className="mx-auto grid max-w-6xl gap-8 px-4 py-10 lg:grid-cols-2">
                    <div className="h-[420px] animate-pulse rounded-3xl bg-gradient-to-br from-[#EEF2FF] to-[#DBEAFE]" />
                    <div className="space-y-4 pt-4">
                        <div className="h-4 w-24 rounded-full bg-slate-200/80" />
                        <div className="h-10 w-4/5 rounded-full bg-slate-200/80" />
                        <div className="h-24 rounded-2xl bg-slate-200/60" />
                        <div className="h-12 rounded-full bg-[#1D4ED8]/15" />
                    </div>
                </div>
            </div>
        );
    }

    if (!product) {
        return (
            <div className="flex min-h-screen flex-col items-center justify-center bg-[#F4F7FD] px-4">
                <MarketplaceAtmosphere />
                <p className="mb-4 font-semibold text-slate-700">Deal not found</p>
                <Link href="/marketplace">
                    <Button className="rounded-full bg-[#1D4ED8] hover:bg-[#1E40AF]">
                        Back to marketplace
                    </Button>
                </Link>
            </div>
        );
    }

    return (
        <div className="min-h-screen bg-[#F4F7FD] pb-28 text-slate-900 lg:pb-10">
            <MarketplaceAtmosphere />

            <header className="sticky top-0 z-40 border-b border-slate-200/80 bg-white/80 backdrop-blur-md">
                <div className="mx-auto flex max-w-6xl items-center justify-between gap-3 px-4 py-3">
                    <div className="flex items-center gap-2">
                        <Link href="/marketplace">
                            <Button variant="ghost" size="sm" className="rounded-full gap-1.5">
                                <ArrowLeft className="h-4 w-4" />
                                Back
                            </Button>
                        </Link>
                        <Link href="/marketplace" className="hidden sm:block">
                            <Image
                                src="/images/awoofLogoMain.png"
                                alt="Awoof"
                                width={100}
                                height={32}
                                className="object-contain"
                            />
                        </Link>
                    </div>
                    {product.category_name ? (
                        <Link
                            href={`/marketplace/search?categoryId=${product.category_id}`}
                            className="rounded-full bg-[#1D4ED8]/10 px-3 py-1.5 text-xs font-semibold text-[#1D4ED8] hover:bg-[#1D4ED8]/15"
                        >
                            {product.category_name}
                        </Link>
                    ) : (
                        <span />
                    )}
                    {user ? (
                        <StudentHeaderActions avatarLetter={avatarLetter} showProfileLink />
                    ) : (
                        <Link href={`/auth/student/login?redirect=/marketplace/${productId}`}>
                            <Button size="sm" className="rounded-full bg-[#1D4ED8] hover:bg-[#1E40AF]">
                                Log in
                            </Button>
                        </Link>
                    )}
                </div>
            </header>

            <main className="mx-auto max-w-6xl px-4 py-8 md:py-10">
                <div className="grid grid-cols-1 items-start gap-8 lg:grid-cols-2 lg:gap-12">
                    <FadeIn>
                        <motion.div
                            className="relative overflow-hidden rounded-3xl border border-[#1D4ED8]/10 bg-white shadow-lg shadow-[#1D4ED8]/10"
                            initial={reduce ? false : { opacity: 0, scale: 0.98 }}
                            animate={{ opacity: 1, scale: 1 }}
                            transition={{ duration: 0.5, ease: [0.22, 1, 0.36, 1] }}
                        >
                            <div className="relative aspect-[4/5] w-full bg-gradient-to-br from-[#EEF2FF] to-[#DBEAFE] sm:aspect-square">
                                {product.image_url ? (
                                    <Image
                                        src={getImageUrl(product.image_url) || ''}
                                        alt={product.name}
                                        fill
                                        className="object-cover"
                                        unoptimized
                                        priority
                                    />
                                ) : (
                                    <div className="flex h-full items-center justify-center text-slate-400">
                                        No image
                                    </div>
                                )}
                                <span className="absolute left-4 top-4 rounded-full bg-emerald-500 px-3 py-1.5 text-sm font-bold text-white shadow-md">
                                    {discount}% OFF
                                </span>
                            </div>
                        </motion.div>
                    </FadeIn>

                    <div className="space-y-6 lg:pt-2">
                        <FadeIn delay={0.08}>
                            <div>
                                {product.category_name && (
                                    <p className="mb-2 flex items-center gap-1.5 text-sm font-semibold text-[#1D4ED8]">
                                        <Tag className="h-3.5 w-3.5" />
                                        {product.category_name}
                                    </p>
                                )}
                                <h1 className="text-3xl font-extrabold tracking-tight text-slate-900 text-balance md:text-4xl">
                                    {product.name}
                                </h1>
                                {product.vendor_name && (
                                    <p className="mt-3 flex items-center gap-2 text-slate-600">
                                        <Store className="h-4 w-4 text-slate-400" />
                                        Sold by{' '}
                                        <span className="font-semibold text-slate-800">
                                            {product.vendor_name}
                                        </span>
                                    </p>
                                )}
                            </div>
                        </FadeIn>

                        <FadeIn delay={0.14}>
                            <div className="relative overflow-hidden rounded-3xl bg-[#1D4ED8] px-6 py-6 text-white shadow-xl shadow-[#1D4ED8]/25">
                                <div
                                    aria-hidden
                                    className="absolute -right-8 -top-8 h-32 w-32 rounded-full bg-white/10 blur-2xl"
                                />
                                <p className="relative text-sm font-medium uppercase tracking-wide text-blue-100">
                                    Student price
                                </p>
                                <div className="relative mt-2 flex flex-wrap items-baseline gap-3">
                                    <span className="text-4xl font-extrabold tracking-tight">
                                        {formatCurrency(product.student_price)}
                                    </span>
                                    <span className="text-lg text-blue-200/80 line-through">
                                        {formatCurrency(product.price)}
                                    </span>
                                </div>
                                <p className="relative mt-3 flex items-center gap-2 text-sm text-blue-100">
                                    <Sparkles className="h-4 w-4 shrink-0" />
                                    You save {formatCurrency(savings)} vs regular price
                                </p>
                            </div>
                        </FadeIn>

                        <FadeIn delay={0.18}>
                            <div className="flex flex-wrap items-center gap-3">
                                {isExternal || product.stock > 0 ? (
                                    <span className="inline-flex items-center gap-1.5 rounded-full bg-emerald-50 px-3 py-1.5 text-sm font-semibold text-emerald-700">
                                        <Check className="h-4 w-4" />
                                        {isExternal && product.stock === 0 ? 'Available' : `In stock · ${product.stock} left`}
                                    </span>
                                ) : (
                                    <span className="inline-flex items-center gap-1.5 rounded-full bg-red-50 px-3 py-1.5 text-sm font-semibold text-red-600">
                                        <Package className="h-4 w-4" />
                                        Out of stock
                                    </span>
                                )}
                                <span className="inline-flex items-center gap-1.5 rounded-full bg-slate-100 px-3 py-1.5 text-sm font-medium text-slate-600">
                                    <ShieldCheck className="h-4 w-4 text-[#1D4ED8]" />
                                    Verified student deal
                                </span>
                            </div>
                        </FadeIn>

                        <FadeIn delay={0.22}>
                            <div>
                                <h2 className="text-lg font-bold text-slate-900">About this deal</h2>
                                <p className="mt-2 text-[15px] leading-relaxed text-slate-600 text-pretty whitespace-pre-line">
                                    {product.description || 'No description available.'}
                                </p>
                            </div>
                        </FadeIn>

                        {product.vendor_description && (
                            <FadeIn delay={0.26}>
                                <div className="rounded-2xl border border-[#1D4ED8]/10 bg-white p-5">
                                    <h2 className="font-bold text-slate-900">
                                        About {product.vendor_name}
                                    </h2>
                                    <p className="mt-2 text-sm leading-relaxed text-slate-600">
                                        {product.vendor_description}
                                    </p>
                                </div>
                            </FadeIn>
                        )}

                        {/* Desktop CTA */}
                        <FadeIn delay={0.3} className="hidden lg:block pt-2">
                            <Button
                                onClick={handlePurchase}
                                disabled={isUnavailable || isPurchasing}
                                className="h-12 w-full rounded-full bg-[#1D4ED8] text-base font-bold hover:bg-[#1E40AF] disabled:opacity-60"
                                size="lg"
                            >
                                <ShoppingCart className="mr-2 h-5 w-5" />
                                {isUnavailable
                                    ? 'Out of stock'
                                    : isPurchasing
                                      ? 'Starting checkout…'
                                      : isExternal
                                        ? 'Visit website to redeem'
                                        : 'Claim student price'}
                            </Button>
                            {!user && !isExternal && (
                                <p className="mt-3 text-center text-sm text-slate-500">
                                    <Link
                                        href={`/auth/student/login?redirect=/marketplace/${productId}`}
                                        className="font-semibold text-[#1D4ED8] hover:underline"
                                    >
                                        Sign in
                                    </Link>{' '}
                                    to purchase
                                </p>
                            )}
                            {isExternal && (
                                <p className="mt-3 text-center text-sm text-slate-500">
                                    This deal is redeemed on the partner site.
                                </p>
                            )}
                        </FadeIn>
                    </div>
                </div>
            </main>

            {/* Mobile sticky CTA */}
            <div className="fixed inset-x-0 bottom-0 z-50 border-t border-slate-200/80 bg-white/95 p-4 backdrop-blur-md lg:hidden">
                <div className="mx-auto flex max-w-lg items-center gap-4">
                    <div className="min-w-0">
                        <p className="truncate text-sm font-bold text-[#1D4ED8]">
                            {formatCurrency(product.student_price)}
                        </p>
                        <p className="text-xs text-slate-400 line-through">
                            {formatCurrency(product.price)}
                        </p>
                    </div>
                    <Button
                        onClick={handlePurchase}
                        disabled={isUnavailable || isPurchasing}
                        className="h-12 flex-1 rounded-full bg-[#1D4ED8] font-bold hover:bg-[#1E40AF]"
                    >
                        {isUnavailable
                            ? 'Out of stock'
                            : isPurchasing
                              ? '…'
                              : isExternal
                                ? 'Partner site'
                                : 'Claim deal'}
                    </Button>
                </div>
            </div>
        </div>
    );
}
