/**
 * Product Detail Page
 * 
 * View detailed product information and purchase
 */

'use client';

import { useState, useEffect } from 'react';
import { useParams, useRouter } from 'next/navigation';
import { ArrowLeft, ShoppingCart, Check, Package, Store, Tag } from 'lucide-react';
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
    stock: number;
    category_id: string;
    category_name: string;
    category_slug: string;
    vendor_id: string;
    vendor_name: string;
    vendor_description: string | null;
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
    const [isAddingToCart] = useState(false);

    useEffect(() => {
        if (productId) {
            fetchProduct();
        }
    }, [productId]);

    const fetchProduct = async () => {
        try {
            setIsLoading(true);
            const response = await apiClient.get(`/products/${productId}`);
            setProduct(response.data.data.product);
        } catch (error) {
            console.error('Error fetching product:', error);
        } finally {
            setIsLoading(false);
        }
    };

    const handlePurchase = () => {
        if (!user) {
            router.push('/auth/student/login?redirect=/marketplace/' + productId);
            return;
        }

        if (user.verificationStatus !== 'verified') {
            alert('Please verify your student status to purchase products.');
            router.push('/marketplace');
            return;
        }

        // TODO: Implement purchase flow
        alert('Purchase flow coming soon!');
    };


    const calculateDiscount = (price: number, studentPrice: number) => {
        const discount = ((price - studentPrice) / price) * 100;
        return Math.round(discount);
    };

    const calculateSavings = (price: number, studentPrice: number) => {
        return price - studentPrice;
    };

    if (isLoading) {
        return (
            <div className="min-h-screen bg-slate-50 flex items-center justify-center">
                <p className="text-slate-500">Loading product...</p>
            </div>
        );
    }

    if (!product) {
        return (
            <div className="min-h-screen bg-slate-50 flex items-center justify-center">
                <div className="text-center">
                    <p className="text-slate-500 mb-4">Product not found</p>
                    <Link href="/marketplace">
                        <Button variant="outline">Back to Marketplace</Button>
                    </Link>
                </div>
            </div>
        );
    }

    const discount = calculateDiscount(product.price, product.student_price);
    const savings = calculateSavings(product.price, product.student_price);

    return (
        <div className="min-h-screen bg-slate-50">
            {/* Header */}
            <div className="bg-white border-b border-slate-200">
                <div className="container mx-auto px-4 py-4">
                    <Link href="/marketplace">
                        <Button variant="ghost" size="sm">
                            <ArrowLeft className="h-4 w-4 mr-2" />
                            Back to Marketplace
                        </Button>
                    </Link>
                </div>
            </div>

            <div className="container mx-auto px-4 py-8">
                <div className="grid grid-cols-1 lg:grid-cols-2 gap-8">
                    {/* Product Image */}
                    <div className="bg-white rounded-lg shadow-sm overflow-hidden">
                        {product.image_url ? (
                            <div className="relative h-96 w-full bg-slate-100">
                                <Image
                                    src={getImageUrl(product.image_url) || ''}
                                    alt={product.name}
                                    fill
                                    className="object-cover"
                                    unoptimized
                                />
                            </div>
                        ) : (
                            <div className="h-96 w-full bg-slate-100 flex items-center justify-center text-slate-400">
                                No Image Available
                            </div>
                        )}
                    </div>

                    {/* Product Info */}
                    <div className="space-y-6">
                        {/* Title and Category */}
                        <div>
                            {product.category_name && (
                                <div className="flex items-center gap-2 mb-2">
                                    <Tag className="h-4 w-4 text-slate-400" />
                                    <span className="text-sm text-slate-500">{product.category_name}</span>
                                </div>
                            )}
                            <h1 className="text-3xl font-bold text-slate-900 mb-2">{product.name}</h1>
                            {product.vendor_name && (
                                <div className="flex items-center gap-2 text-slate-600">
                                    <Store className="h-4 w-4" />
                                    <span className="text-sm">Sold by {product.vendor_name}</span>
                                </div>
                            )}
                        </div>

                        {/* Price */}
                        <div className="bg-blue-50 rounded-lg p-4">
                            <div className="flex items-baseline gap-3 mb-2">
                                <span className="text-3xl font-bold text-blue-600">
                                    {formatCurrency(product.student_price)}
                                </span>
                                <span className="text-xl text-slate-400 line-through">
                                    {formatCurrency(product.price)}
                                </span>
                                <span className="bg-green-500 text-white text-sm font-semibold px-2 py-1 rounded">
                                    {discount}% OFF
                                </span>
                            </div>
                            <p className="text-sm text-slate-600">
                                You save {formatCurrency(savings)} with student discount
                            </p>
                        </div>

                        {/* Stock Status */}
                        <div className="flex items-center gap-2">
                            {product.stock > 0 ? (
                                <>
                                    <Check className="h-5 w-5 text-green-600" />
                                    <span className="text-green-600 font-medium">In Stock</span>
                                    <span className="text-sm text-slate-500">({product.stock} available)</span>
                                </>
                            ) : (
                                <>
                                    <Package className="h-5 w-5 text-red-600" />
                                    <span className="text-red-600 font-medium">Out of Stock</span>
                                </>
                            )}
                        </div>

                        {/* Description */}
                        <div>
                            <h2 className="text-lg font-semibold text-slate-900 mb-2">Description</h2>
                            <p className="text-slate-600 whitespace-pre-line">
                                {product.description || 'No description available.'}
                            </p>
                        </div>

                        {/* Vendor Info */}
                        {product.vendor_description && (
                            <div className="border-t border-slate-200 pt-4">
                                <h2 className="text-lg font-semibold text-slate-900 mb-2">About {product.vendor_name}</h2>
                                <p className="text-sm text-slate-600">{product.vendor_description}</p>
                            </div>
                        )}

                        {/* Purchase Button */}
                        <div className="pt-4">
                            <Button
                                onClick={handlePurchase}
                                disabled={product.stock === 0 || isAddingToCart}
                                className="w-full"
                                size="lg"
                            >
                                <ShoppingCart className="h-5 w-5 mr-2" />
                                {product.stock === 0
                                    ? 'Out of Stock'
                                    : isAddingToCart
                                        ? 'Processing...'
                                        : (product.deal_type === 'voucher' || product.vendor_payment_method === 'vendor_website')
                                            ? 'Visit website'
                                            : 'Purchase Now'}
                            </Button>
                            {!user && (
                                <p className="text-xs text-slate-500 mt-2 text-center">
                                    <Link href="/auth/student/login" className="text-blue-600 hover:underline">
                                        Sign in
                                    </Link>{' '}
                                    to purchase
                                </p>
                            )}
                        </div>
                    </div>
                </div>
            </div>
        </div>
    );
}

