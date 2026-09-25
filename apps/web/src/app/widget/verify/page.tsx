import type { Metadata } from 'next';
import HostedPilot from './HostedPilot';

export const dynamic = 'force-dynamic';
export const metadata: Metadata = { title: 'Merchant eligibility pilot | Awoof', robots: { index: false, follow: false } };

type Params = { vendorId?: string; origin?: string; campaignId?: string; purpose?: string; state?: string };
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export default async function WidgetVerificationPage({ searchParams }: { searchParams: Promise<Params> }) {
    const params = await searchParams;
    const allowedVendors = new Set((process.env.AWOOF_WIDGET_PILOT_VENDOR_IDS ?? '').split(',').map((id) => id.trim().toLowerCase()));
    const enabled = process.env.AWOOF_WIDGET_PILOT_ENABLED === 'true'
        && typeof params.vendorId === 'string' && uuid.test(params.vendorId)
        && allowedVendors.has(params.vendorId.toLowerCase())
        && typeof params.origin === 'string' && params.origin.length <= 512
        && typeof params.campaignId === 'string' && params.campaignId.length > 0 && params.campaignId.length <= 100
        && typeof params.purpose === 'string' && params.purpose.length > 0 && params.purpose.length <= 200
        && typeof params.state === 'string' && /^[0-9a-f]{32}$/.test(params.state);
    if (!enabled) return <main className="mx-auto max-w-md p-6 text-center"><h1 className="text-xl font-semibold">Merchant verification is unavailable</h1><p className="mt-4">This verification widget is being replaced. The controlled pilot is not enabled for this merchant. Return to the merchant for available checkout options.</p><p className="mt-4">Do not submit student documents, registration numbers or verification codes through an older widget.</p></main>;
    return <HostedPilot vendorId={params.vendorId!} origin={params.origin!} campaignId={params.campaignId!} purpose={params.purpose!} state={params.state!} />;
}
