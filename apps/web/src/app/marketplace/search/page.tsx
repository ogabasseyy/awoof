/**
 * Marketplace Search / Category browse
 */

'use client';

import { useState, useEffect, useCallback, Suspense } from 'react';
import { useSearchParams } from 'next/navigation';
import { Search, ShoppingBag, ArrowLeft, Sparkles } from 'lucide-react';
import { Input } from '@/components/ui/input';
import { Button } from '@/components/ui/button';
import apiClient from '@/lib/api-client';
import Image from 'next/image';
import Link from 'next/link';
import { useAuth } from '@/contexts/AuthContext';
import { FadeIn } from '../_components/ExpectancyUI';
import { DealCard, MarketplaceAtmosphere, type DealCardProduct } from '../_components/DealCard';
import { StudentHeaderActions } from '@/components/student/StudentHeaderActions';

function SearchContent() {
    const searchParams = useSearchParams();
    const { user } = useAuth();
    const q = searchParams.get('q') || searchParams.get('search') || '';
    const categoryId = searchParams.get('categoryId') || '';
    const [query, setQuery] = useState(q);
    const [products, setProducts] = useState<DealCardProduct[]>([]);
    const [total, setTotal] = useState(0);
    const [categoryName, setCategoryName] = useState<string | null>(null);
    const [isLoading, setIsLoading] = useState(true);

    const fetchResults = useCallback(async (searchTerm: string, catId: string) => {
        const term = searchTerm.trim();
        if (!term && !catId) {
            setProducts([]);
            setTotal(0);
            setCategoryName(null);
            setIsLoading(false);
            return;
        }

        try {
            setIsLoading(true);
            const params = new URLSearchParams({ limit: '50', deal_type: 'product' });
            if (term) params.set('search', term);
            if (catId) params.set('categoryId', catId);

            const res = await apiClient.get(`/products?${params.toString()}`);
            const data = res.data?.data;
            const list: DealCardProduct[] = data?.products || [];
            setProducts(list);
            setTotal(data?.pagination?.total ?? list.length);

            if (catId) {
                const fromProduct = list.find((p) => p.category_name)?.category_name;
                if (fromProduct) {
                    setCategoryName(fromProduct);
                } else {
                    try {
                        const catRes = await apiClient.get('/products/categories');
                        const cats = catRes.data?.data || [];
                        const match = cats.find((c: { id: string; name: string }) => c.id === catId);
                        setCategoryName(match?.name ?? null);
                    } catch {
                        setCategoryName(null);
                    }
                }
            } else {
                setCategoryName(null);
            }
        } catch (err) {
            console.error('Search error:', err);
            setProducts([]);
            setTotal(0);
            setCategoryName(null);
        } finally {
            setIsLoading(false);
        }
    }, []);

    useEffect(() => {
        setQuery(q);
        fetchResults(q, categoryId);
    }, [q, categoryId, fetchResults]);

    const handleSubmit = (e: React.FormEvent) => {
        e.preventDefault();
        const term = query.trim();
        if (!term) return;
        const params = new URLSearchParams({ q: term });
        if (categoryId) params.set('categoryId', categoryId);
        window.location.href = `/marketplace/search?${params.toString()}`;
    };

    const hasFilter = Boolean(q.trim() || categoryId);
    const heading = q.trim()
        ? `Results for “${q}”`
        : categoryName
          ? `${categoryName} deals`
          : 'Category deals';
    const sub = q.trim()
        ? 'Student prices across products and brands'
        : 'Every deal in this lane — locked for verified students';

    const avatarLetter = (() => {
        const profile = (user as { profile?: { name?: string } } | null)?.profile;
        if (profile?.name) return profile.name.split(' ')[0].charAt(0).toUpperCase();
        if (user?.email) return user.email.charAt(0).toUpperCase();
        return 'U';
    })();

    return (
        <div className="min-h-screen bg-[#F4F7FD] text-slate-900">
            <MarketplaceAtmosphere />

            <header className="sticky top-0 z-40 border-b border-slate-200/80 bg-white/80 backdrop-blur-md">
                <div className="mx-auto flex max-w-6xl items-center gap-3 px-4 py-3">
                    <Link href="/marketplace" className="shrink-0">
                        <Button variant="ghost" size="sm" className="rounded-full gap-1.5">
                            <ArrowLeft className="h-4 w-4" />
                            <span className="hidden sm:inline">Back</span>
                        </Button>
                    </Link>
                    <Link href="/marketplace" className="hidden sm:block shrink-0">
                        <Image
                            src="/images/awoofLogoMain.png"
                            alt="Awoof"
                            width={100}
                            height={32}
                            className="object-contain"
                        />
                    </Link>
                    <form onSubmit={handleSubmit} className="min-w-0 flex-1 max-w-2xl">
                        <div className="relative">
                            <Search className="absolute left-3.5 top-1/2 h-4 w-4 -translate-y-1/2 text-slate-400" />
                            <Input
                                type="text"
                                placeholder={
                                    categoryName
                                        ? `Search in ${categoryName}…`
                                        : 'Search deals, brands…'
                                }
                                value={query}
                                onChange={(e) => setQuery(e.target.value)}
                                className={`h-11 rounded-full border-slate-200 bg-slate-50/80 pl-10 focus-visible:ring-[#1D4ED8] ${
                                    query.trim() ? 'pr-24' : ''
                                }`}
                            />
                            {query.trim().length > 0 && (
                                <Button
                                    type="submit"
                                    size="sm"
                                    className="absolute right-1.5 top-1/2 h-8 -translate-y-1/2 rounded-full bg-[#1D4ED8] px-3 hover:bg-[#1E40AF]"
                                >
                                    Search
                                </Button>
                            )}
                        </div>
                    </form>
                    {user ? (
                        <StudentHeaderActions avatarLetter={avatarLetter} showProfileLink />
                    ) : (
                        <Link href="/auth/student/login" className="shrink-0">
                            <Button size="sm" className="rounded-full bg-[#1D4ED8] hover:bg-[#1E40AF]">
                                Log in
                            </Button>
                        </Link>
                    )}
                </div>
            </header>

            <main className="mx-auto max-w-6xl px-4 py-8 md:py-10">
                {!hasFilter ? (
                    <FadeIn>
                        <div className="mx-auto max-w-md rounded-3xl border border-[#1D4ED8]/10 bg-white px-8 py-14 text-center shadow-sm">
                            <div className="mx-auto mb-4 flex h-14 w-14 items-center justify-center rounded-2xl bg-[#1D4ED8]/10 text-[#1D4ED8]">
                                <Search className="h-6 w-6" />
                            </div>
                            <h1 className="text-xl font-extrabold text-slate-900">Find a deal</h1>
                            <p className="mt-2 text-sm text-slate-600 leading-relaxed">
                                Search by product or vendor — or browse categories from the marketplace home.
                            </p>
                            <Link href="/marketplace" className="mt-6 inline-block">
                                <Button className="rounded-full bg-[#1D4ED8] hover:bg-[#1E40AF]">
                                    Browse marketplace
                                </Button>
                            </Link>
                        </div>
                    </FadeIn>
                ) : (
                    <>
                        <FadeIn>
                            <section className="relative mb-8 overflow-hidden rounded-3xl bg-[#1D4ED8] px-6 py-8 text-white shadow-xl shadow-[#1D4ED8]/20 md:px-10 md:py-9">
                                <div
                                    aria-hidden
                                    className="absolute -right-12 -top-12 h-48 w-48 rounded-full bg-white/10 blur-2xl"
                                />
                                <div
                                    aria-hidden
                                    className="absolute -bottom-16 left-1/4 h-40 w-40 rounded-full bg-sky-300/25 blur-3xl"
                                />
                                <div className="relative">
                                    <p className="mb-2 flex items-center gap-1.5 text-sm font-medium uppercase tracking-wide text-blue-100">
                                        <Sparkles className="h-3.5 w-3.5" />
                                        {categoryName ? 'Category' : 'Search'}
                                    </p>
                                    <h1 className="text-3xl font-extrabold tracking-tight text-balance md:text-4xl">
                                        {heading}
                                    </h1>
                                    <p className="mt-2 max-w-xl text-blue-100/95 text-[15px] leading-relaxed">
                                        {isLoading
                                            ? 'Pulling student deals…'
                                            : total === 0
                                              ? 'Nothing here yet — try another lane or search.'
                                              : `${total} deal${total !== 1 ? 's' : ''} · ${sub}`}
                                    </p>
                                </div>
                            </section>
                        </FadeIn>

                        {isLoading ? (
                            <div className="grid grid-cols-1 gap-5 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4">
                                {Array.from({ length: 8 }).map((_, i) => (
                                    <div
                                        key={i}
                                        className="overflow-hidden rounded-2xl border border-[#1D4ED8]/10 bg-white"
                                    >
                                        <div className="h-44 animate-pulse bg-gradient-to-br from-[#EEF2FF] to-[#DBEAFE]" />
                                        <div className="space-y-3 p-4">
                                            <div className="h-4 w-3/4 rounded-full bg-slate-100" />
                                            <div className="h-3 w-1/3 rounded-full bg-slate-100" />
                                            <div className="h-8 w-24 rounded-full bg-[#1D4ED8]/10" />
                                        </div>
                                    </div>
                                ))}
                            </div>
                        ) : products.length === 0 ? (
                            <FadeIn delay={0.05}>
                                <div className="rounded-3xl border border-[#1D4ED8]/10 bg-white px-8 py-16 text-center shadow-sm">
                                    <ShoppingBag className="mx-auto mb-4 h-12 w-12 text-slate-300" />
                                    <p className="font-semibold text-slate-800">
                                        {q.trim()
                                            ? 'No matches for that search'
                                            : 'No deals in this category yet'}
                                    </p>
                                    <p className="mt-2 text-sm text-slate-500">
                                        Check back soon — new campus partners join weekly.
                                    </p>
                                    <Link href="/marketplace" className="mt-6 inline-block">
                                        <Button
                                            variant="outline"
                                            className="rounded-full border-[#1D4ED8]/30 text-[#1D4ED8]"
                                        >
                                            Back to marketplace
                                        </Button>
                                    </Link>
                                </div>
                            </FadeIn>
                        ) : (
                            <div className="grid grid-cols-1 gap-5 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4">
                                {products.map((product, i) => (
                                    <DealCard key={product.id} product={product} index={i} />
                                ))}
                            </div>
                        )}
                    </>
                )}
            </main>
        </div>
    );
}

export default function MarketplaceSearchPage() {
    return (
        <Suspense
            fallback={
                <div className="flex min-h-screen items-center justify-center bg-[#F4F7FD]">
                    <p className="text-slate-500">Loading…</p>
                </div>
            }
        >
            <SearchContent />
        </Suspense>
    );
}
