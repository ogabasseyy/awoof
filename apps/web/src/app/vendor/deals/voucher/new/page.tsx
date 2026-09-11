import Link from 'next/link';

export default function VoucherCreationUnavailable() {
    return <main className="mx-auto max-w-xl p-8">
        <h1 className="text-2xl font-semibold">Voucher creation is unavailable</h1>
        <p className="my-4">External redemption is suspended while merchant verification is being replaced. You can create a product for checkout on Awoof.</p>
        <Link className="underline" href="/vendor/deals/new">Create a product</Link>
    </main>;
}
