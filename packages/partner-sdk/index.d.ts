export type PaymentGateway = 'paystack' | 'paystack_merchant' | 'other';
export interface ClaimSession { claimSessionId: string; expiresAt: string }
export interface MerchantReceipt { receiptId: string; merchantSubject: string; eligible: true; assuranceMethod: 'student_email' | 'enrollment'; institutionId: string; verifiedAt: string; validUntil: string; campaignId: string; benefitAuthorizationId?: string; benefitValidUntil?: string }
export interface TransactionReport { benefitAuthorizationId: string; paymentReference: string; amount: number; productId: string; paymentGateway: PaymentGateway }
export class AwoofApiError extends Error { status: number; body: unknown }
export class AwoofPartnerClient {
  constructor(config: { apiOrigin: string; webOrigin: string; privateKey: string; fetch?: typeof fetch; allowLoopbackHttp?: boolean });
  createClaimSession(input: { productId: string; merchantCheckoutId: string; browserNonce: string; origin: string }): Promise<ClaimSession>;
  buildHostedClaimUrl(productId: string, claimSessionId: string): string;
  exchangeClaim(input: { code: string; merchantCheckoutId: string; browserNonce: string; idempotencyKey: string }): Promise<MerchantReceipt>;
  reportTransaction(input: TransactionReport): Promise<unknown>;
}
export function trustedBase(value: string, allowLoopbackHttp?: boolean): string;
export function nonceHash(nonce: string): string;
export function merchantPaystackMetadata(input: { vendorId: string; productId: string; benefitAuthorizationId: string }): { awoofVendorId: string; awoofProductId: string; awoofBenefitAuthorizationId: string };
export function verifyPaystackWebhook(rawBody: Buffer, signature: unknown, secret: string): boolean;
export type Capability = 'enrollment' | 'offers' | 'redemption' | 'payment_events' | 'google_entitlement' | 'verve_cashback';
export interface EnrollmentRequest { subjectBinding: string; institutionId: string }
export interface EnrollmentEvidence { status: 'eligible' | 'ineligible' | 'pending' | 'unavailable'; authority: string; subjectBinding: string; institutionId: string; verifiedAt: string; validUntil: string; evidenceReference: string }
export interface OfferRequest { merchantId: string; offerId: string; policyVersion: string; enrollment: EnrollmentEvidence; disclosureGrantId: string }
export interface RedemptionRequest { merchantId: string; productId: string; merchantCheckoutId: string; amount: number; currency: 'NGN'; idempotencyKey: string; authorizationId: string }
export interface AuthenticatedPaymentEvent { provider: string; environment: 'test' | 'live'; eventId: string; reference: string; amount: number; currency: string; status: 'paid' | 'failed' | 'refunded' | 'disputed' | 'reversed'; authenticated: true }
export interface GoogleEntitlementRequest { approvedOfferId: string; subjectBinding: string; enrollment: EnrollmentEvidence; consentReference: string }
export interface VerveCashbackRequest { approvedCampaignId: string; fundingContractReference: string; qualificationReference: string; capPolicyReference: string; settlementReference: string; event: AuthenticatedPaymentEvent; reversalPolicyReference: string }
export interface OfferDecision { status: 'eligible' | 'ineligible' | 'unavailable'; merchantId: string; offerId: string; policyVersion: string; validUntil: string; disclosureGrantId: string }
export interface RedemptionDecision { status: 'authorized' | 'rejected'; merchantCheckoutId: string; authorizationId: string; amount: number; currency: 'NGN'; validUntil: string; idempotencyKey: string }
export interface RawProviderEvent { provider: string; environment: 'test' | 'live'; rawBody: Buffer; headers: Readonly<Record<string, string | undefined>> }
export interface EntitlementDecision { status: 'issued' | 'rejected' | 'pending'; approvedOfferId: string; subjectBinding: string; providerReference: string; validUntil?: string }
export interface CashbackDecision { status: 'qualified' | 'rejected' | 'pending' | 'reversed'; approvedCampaignId: string; fundingContractReference: string; qualificationReference: string; eventReference: string; amountMinor: number; currency: string; ledgerReference: string; settlementReference: string; reversalPolicyReference: string }
export interface Unconfigured { status: 'unconfigured'; capability?: Capability }
export interface ConfiguredAdapter<I, O> { capability: Capability; status: 'configured'; contractReference: string; execute(input: I): Promise<O> }
export interface UnconfiguredAdapter { capability: Capability; status: 'unconfigured'; execute(input?: unknown): Promise<Unconfigured> }
export type EnrollmentAdapter = ConfiguredAdapter<EnrollmentRequest, EnrollmentEvidence> & { capability: 'enrollment' };
export type OfferAdapter = ConfiguredAdapter<OfferRequest, OfferDecision> & { capability: 'offers' };
export type RedemptionAdapter = ConfiguredAdapter<RedemptionRequest, RedemptionDecision> & { capability: 'redemption' };
export type PaymentEventAdapter = ConfiguredAdapter<RawProviderEvent, AuthenticatedPaymentEvent> & { capability: 'payment_events' };
export type GoogleEntitlementAdapter = ConfiguredAdapter<GoogleEntitlementRequest, EntitlementDecision> & { capability: 'google_entitlement' };
export type VerveCashbackAdapter = ConfiguredAdapter<VerveCashbackRequest, CashbackDecision> & { capability: 'verve_cashback' };
export const PARTNER_CAPABILITIES: readonly Capability[];
export function unconfiguredAdapter(capability: Capability): UnconfiguredAdapter;
export function partnerCapabilities(): Record<Capability, UnconfiguredAdapter>;
export function invokeConfiguredAdapter<I, O>(adapter: ConfiguredAdapter<I, O> | UnconfiguredAdapter | undefined, input: I): Promise<O | Unconfigured>;
