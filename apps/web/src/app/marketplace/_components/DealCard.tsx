'use client';

import Image from 'next/image';
import Link from 'next/link';
import { motion, useReducedMotion } from 'framer-motion';
import { getImageUrl } from '@/lib/api-client';
import { formatCurrency } from '@/lib/format';

export type DealCardProduct = {
    id: string;
    name: string;
    price: number;
    student_price: number;
    image_url: string | null;
    category_name?: string | null;
    vendor_name?: string | null;
    vendor_payment_method?: 'awoof' | 'vendor_website';
    deal_type?: 'product' | 'voucher';
};

function discountPct(price: number, studentPrice: number) {
    if (!price) return 0;
    return Math.round(((price - studentPrice) / price) * 100);
}

export function DealCard({
    product,
    index = 0,
}: {
    product: DealCardProduct;
    index?: number;
}) {
    const reduce = useReducedMotion();
    const discount = discountPct(product.price, product.student_price);
    const cta =
        product.deal_type === 'voucher' || product.vendor_payment_method === 'vendor_website'
            ? 'Visit site'
            : 'View deal';

    const inner = (
        <Link
            href={`/marketplace/${product.id}`}
            className="group flex h-full flex-col overflow-hidden rounded-2xl border border-[#1D4ED8]/10 bg-white shadow-sm transition-[transform,box-shadow] hover:-translate-y-1 hover:shadow-lg hover:shadow-[#1D4ED8]/10"
        >
            <div className="relative h-44 overflow-hidden bg-gradient-to-br from-[#EEF2FF] to-[#DBEAFE]">
                {product.image_url ? (
                    <Image
                        src={getImageUrl(product.image_url) || ''}
                        alt={product.name}
                        fill
                        className="object-cover transition-transform duration-500 group-hover:scale-[1.04]"
                        unoptimized
                    />
                ) : (
                    <div className="flex h-full items-center justify-center text-sm text-slate-400">
                        No image
                    </div>
                )}
                <span className="absolute right-2.5 top-2.5 rounded-full bg-emerald-500 px-2.5 py-1 text-xs font-bold text-white shadow-sm">
                    {discount}% OFF
                </span>
            </div>
            <div className="flex flex-1 flex-col p-4">
                <h2 className="line-clamp-2 font-bold text-slate-900 group-hover:text-[#1D4ED8] transition-colors">
                    {product.name}
                </h2>
                {product.vendor_name && (
                    <p className="mt-1 text-xs text-slate-500">{product.vendor_name}</p>
                )}
                {product.category_name && (
                    <p className="mt-1 text-xs font-medium text-[#1D4ED8]/80">
                        {product.category_name}
                    </p>
                )}
                <div className="mt-auto flex items-end justify-between gap-2 pt-4">
                    <div>
                        <p className="text-lg font-extrabold text-[#1D4ED8]">
                            {formatCurrency(product.student_price)}
                        </p>
                        <p className="text-sm text-slate-400 line-through">
                            {formatCurrency(product.price)}
                        </p>
                    </div>
                    <span className="rounded-full bg-[#1D4ED8]/10 px-3 py-1.5 text-xs font-semibold text-[#1D4ED8] transition-colors group-hover:bg-[#1D4ED8] group-hover:text-white">
                        {cta}
                    </span>
                </div>
            </div>
        </Link>
    );

    if (reduce) return inner;

    return (
        <motion.div
            initial={{ opacity: 0, y: 16 }}
            animate={{ opacity: 1, y: 0 }}
            transition={{
                duration: 0.4,
                delay: Math.min(index * 0.05, 0.4),
                ease: [0.22, 1, 0.36, 1],
            }}
            className="h-full"
        >
            {inner}
        </motion.div>
    );
}

export function MarketplaceAtmosphere() {
    return (
        <div
            aria-hidden
            className="pointer-events-none fixed inset-0 -z-10"
            style={{
                background:
                    'radial-gradient(ellipse 80% 50% at 50% -10%, rgba(29,78,216,0.14), transparent 55%), radial-gradient(ellipse 40% 30% at 100% 20%, rgba(56,189,248,0.08), transparent)',
            }}
        />
    );
}
