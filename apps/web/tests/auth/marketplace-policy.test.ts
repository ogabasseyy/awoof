import assert from 'node:assert/strict';
import { test } from 'node:test';
import { dealUnavailable, redemptionUrl } from '../../src/lib/marketplace-policy';

test('redemption accepts web URLs and rejects executable schemes and embedded credentials', () => {
    assert.equal(redemptionUrl('https://shop.example/deal'), 'https://shop.example/deal');
    for (const value of ['javascript:alert(1)', 'data:text/html,test', '//shop.example', 'https://user:pass@shop.example', 'invalid']) {
        assert.equal(redemptionUrl(value), null);
    }
});
test('external payment never makes a finite product unlimited', () => {
    assert.equal(dealUnavailable({ deal_type: 'product', stock: 0 }), true);
    assert.equal(dealUnavailable({ deal_type: 'product', stock: 1 }), false);
    assert.equal(dealUnavailable({ deal_type: 'voucher', stock: 0 }), true);
    assert.equal(dealUnavailable({ deal_type: 'voucher', stock: 1 }), false);
    assert.equal(dealUnavailable({ stock: NaN }), true);
});
