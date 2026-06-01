/**
 * Marketplace Search
 *
 * Results for product/vendor search. Query param: q (or search).
 * Backend GET /api/products?search=... matches product name, description, and vendor name.
 */

'use client';

import { useState, useEffect, useCallback, Suspense } from 'react';
import { useSearchParams } from 'next/navigation';
import { Search, ShoppingBag, ArrowLeft } from 'lucide-react';
import { Input } from '@/components/ui/input';
import { Button } from '@/components/ui/button';
import apiClient, { getImageUrl } from '@/lib/api-client';
import Image from 'next/image';
import Link from 'next/link';
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

function SearchContent() {
    const searchParams = useSearchParams();
    const q = searchParams.get('q') || searchParams.get('search') || '';
    const [query, setQuery] = useState(q);
    const [products, setProducts] = useState<Product[]>([]);
    const [total, setTotal] = useState(0);
    const [isLoading, setIsLoading] = useState(true);

    const fetchResults = useCallback(async (searchTerm: string) => {
        if (!searchTerm.trim()) {
            setProducts([]);
            setTotal(0);
            setIsLoading(false);
            return;
        }
        try {
            setIsLoading(true);
            const res = await apiClient.get(
                `/products?search=${encodeURIComponent(searchTerm.trim())}&limit=50`
            );
            const data = res.data?.data;
            setProducts(data?.products || []);
            setTotal(data?.pagination?.total ?? 0);
        } catch (err) {
            console.error('Search error:', err);
            setProducts([]);
            setTotal(0);
        } finally {
            setIsLoading(false);
        }
    }, []);

    useEffect(() => {
        setQuery(q);
        fetchResults(q);
    }, [q, fetchResults]);

    const handleSubmit = (e: React.FormEvent) => {
        e.preventDefault();
        const term = query.trim();
        if (term) {
            window.location.href = `/marketplace/search?q=${encodeURIComponent(term)}`;
        }
    };

    const calculateDiscount = (price: number, studentPrice: number) => {
        if (!price) return 0;
        return Math.round(((price - studentPrice) / price) * 100);
    };

    return (
        <div className="min-h-screen bg-white">
            {/* Header */}
            <header className="bg-white border-b border-slate-200 sticky top-0 z-10">
                <div className="container mx-auto px-4 py-4">
                    <div className="flex items-center gap-4">
                        <Link href="/marketplace">
                            <Button variant="ghost" size="sm">
                                <ArrowLeft className="h-5 w-5 mr-1" />
                                Back
                            </Button>
                        </Link>
                        <form onSubmit={handleSubmit} className="flex-1 max-w-2xl">
                            <div className="relative">
                                <Search className="absolute left-4 top-1/2 -translate-y-1/2 h-5 w-5 text-slate-400" />
                                <Input
                                    type="text"
                                    placeholder="Search by product or vendor name"
                                    value={query}
                                    onChange={(e) => setQuery(e.target.value)}
                                    className={`pl-12 h-12 rounded-full border border-[#1D4ED8] transition-[padding] ${query.trim().length > 0 ? 'pr-24' : ''}`}
                                />
                                {query.trim().length > 0 && (
                                    <Button
                                        type="submit"
                                        size="sm"
                                        className="absolute right-1 top-1/2 -translate-y-1/2 rounded-full h-9 px-4 font-medium"
                                        style={{ backgroundColor: '#1D4ED8' }}
                                    >
                                        Search
                                    </Button>
                                )}
                            </div>
                        </form>
                    </div>
                </div>
            </header>

            <main className="container mx-auto px-4 py-8">
                {!q.trim() ? (
                    <p className="text-slate-500 text-center py-12">Enter a product or vendor name to search.</p>
                ) : (
                    <>
                        <h1 className="text-xl font-semibold text-slate-900 mb-2">
                            Search results for &quot;{q}&quot;
                        </h1>
                        <p className="text-slate-600 text-sm mb-6">
                            {total === 0 && !isLoading
                                ? 'No deals found.'
                                : `${total} deal${total !== 1 ? 's' : ''} found.`}
                        </p>

                        {isLoading ? (
                            <div className="flex justify-center py-16">
                                <p className="text-slate-500">Searching...</p>
                            </div>
                        ) : products.length === 0 ? (
                            <div className="text-center py-16">
                                <ShoppingBag className="h-12 w-12 text-slate-300 mx-auto mb-4" />
                                <p className="text-slate-600">No products or vendors match your search.</p>
                                <Link href="/marketplace" className="inline-block mt-4 text-[#1D4ED8] font-medium hover:underline">
                                    Browse all deals
                                </Link>
                            </div>
                        ) : (
                            <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4 gap-6">
                                {products.map((product) => {
                                    const discount = calculateDiscount(product.price, product.student_price);
                                    return (
                                        <Link
                                            key={product.id}
                                            href={`/marketplace/${product.id}`}
                                            className="bg-white rounded-xl border border-slate-200 overflow-hidden shadow-sm hover:shadow-md transition-shadow flex flex-col"
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
                                                    <div className="w-full h-full flex items-center justify-center text-slate-400">
                                                        No Image
                                                    </div>
                                                )}
                                                <div className="absolute top-2 right-2 bg-green-500 text-white text-xs font-semibold px-2 py-1 rounded">
                                                    {discount}% OFF
                                                </div>
                                            </div>
                                            <div className="p-4 flex flex-col flex-1">
                                                <h2 className="font-semibold text-slate-900 line-clamp-2 mb-1">{product.name}</h2>
                                                {product.vendor_name && (
                                                    <p className="text-xs text-slate-500 mb-2">{product.vendor_name}</p>
                                                )}
                                                {product.category_name && (
                                                    <p className="text-xs text-[#1D4ED8] mb-2">{product.category_name}</p>
                                                )}
                                                <div className="mt-auto flex items-center justify-between">
                                                    <span className="font-bold text-[#1D4ED8]">
                                                        {formatCurrency(product.student_price)}
                                                    </span>
                                                    <span className="text-slate-400 text-sm line-through">
                                                        {formatCurrency(product.price)}
                                                    </span>
                                                </div>
                                                <Link
                                                    href={`/marketplace/${product.id}`}
                                                    className="text-red-600 hover:underline text-sm font-medium mt-2"
                                                    onClick={(e) => e.stopPropagation()}
                                                >
                                                    {product.deal_type === 'voucher' || product.vendor_payment_method === 'vendor_website' ? 'Visit website' : 'Purchase'}
                                                </Link>
                                            </div>
                                        </Link>
                                    );
                                })}
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
        <Suspense fallback={<div className="min-h-screen flex items-center justify-center"><p className="text-slate-500">Loading...</p></div>}>
            <SearchContent />
        </Suspense>
    );
}
