import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { BENEFIT_CURRENCY, computePricingVersion, koboToNaira, merchantPaymentMetadataMatches } from './merchant-benefit.service.js';

describe('merchant benefit pricing', () => {
    it('quotes in naira on the NGN catalog without a client currency', () => {
        assert.equal(BENEFIT_CURRENCY, 'NGN');
        assert.equal(koboToNaira(8000), 80);
        assert.equal(koboToNaira(1), 0.01);
    });

    it('rejects non-minor-unit amounts at the boundary', () => {
        for (const invalid of [0, -1, 80.5, Number.NaN, Number.POSITIVE_INFINITY]) {
            assert.throws(() => koboToNaira(invalid), /minor units/);
        }
    });

    it('digests product, currency and both quoted prices server-side', () => {
        const version = computePricingVersion('product-1', 'NGN', 100, 80);
        assert.match(version, /^[a-f0-9]{64}$/);
        assert.equal(version, computePricingVersion('product-1', 'NGN', '100.00', '80.00'));
        assert.notEqual(version, computePricingVersion('product-2', 'NGN', 100, 80));
        assert.notEqual(version, computePricingVersion('product-1', 'NGN', 101, 80));
        assert.notEqual(version, computePricingVersion('product-1', 'NGN', 100, 81));
        assert.notEqual(version, computePricingVersion('product-1', 'USD', 100, 80));
    });

    it('matches provider UUID metadata case-insensitively and rejects anything else', () => {
        const expected = {
            vendorId: '00000000-0000-4000-8000-000000000002',
            productId: '00000000-0000-4000-8000-000000000003',
            benefitAuthorizationId: '40000000-0000-4000-8000-000000000001',
        };
        assert.equal(merchantPaymentMetadataMatches({
            awoofVendorId: expected.vendorId.toUpperCase(),
            awoofProductId: expected.productId,
            awoofBenefitAuthorizationId: expected.benefitAuthorizationId,
        }, expected), true);
        assert.equal(merchantPaymentMetadataMatches(undefined, expected), false);
        assert.equal(merchantPaymentMetadataMatches({
            awoofVendorId: 'not-a-uuid',
            awoofProductId: expected.productId,
            awoofBenefitAuthorizationId: expected.benefitAuthorizationId,
        }, expected), false);
        assert.equal(merchantPaymentMetadataMatches({
            awoofVendorId: expected.vendorId,
            awoofProductId: '00000000-0000-4000-8000-000000000099',
            awoofBenefitAuthorizationId: expected.benefitAuthorizationId,
        }, expected), false);
    });

    it('rejects invalid quoted prices instead of digesting them', () => {
        for (const prices of [[-1, 80], [100, -1], [Number.NaN, 80], [100, Number.NaN]] as const) {
            assert.throws(() => computePricingVersion('product-1', 'NGN', prices[0], prices[1]), /price/i);
        }
    });
});
