import assert from 'node:assert/strict';
import test from 'node:test';
// @ts-ignore - upstream package has no TypeScript definitions
import SibApiV3Sdk from 'sib-api-v3-sdk';
import { sendEmailVerificationOTP, sendWelcomeEmail } from './email.service.js';

test('registration and welcome mail render supplied names as text, never markup', async (t) => {
    const previous = process.env.BREVO_API_KEY;
    process.env.BREVO_API_KEY = 'synthetic-test-key';
    t.after(() => {
        if (previous === undefined) delete process.env.BREVO_API_KEY;
        else process.env.BREVO_API_KEY = previous;
    });
    const messages: string[] = [];
    t.mock.method(SibApiV3Sdk.ApiClient.instance, 'callApi', async (...args: unknown[]) => {
        assert.equal(args[0], '/smtp/email');
        messages.push((args[7] as { htmlContent: string }).htmlContent);
        return { data: { messageId: 'synthetic-message' } };
    });
    const name = '<a href="https://attacker.invalid">O\'Neil & Co</a>';
    assert.equal((await sendEmailVerificationOTP('student@approved.test', '123456', name, 'student')).success, true);
    assert.equal((await sendEmailVerificationOTP('vendor@approved.test', '123456', name, 'vendor')).success, true);
    assert.equal((await sendWelcomeEmail('student@approved.test', name)).success, true);
    assert.equal(messages.length, 3);
    for (const html of messages) {
        assert.ok(html.includes('Hello &lt;a href=&quot;https://attacker.invalid&quot;&gt;O&#39;Neil &amp; Co&lt;/a&gt;,'));
        assert.ok(!html.includes(name));
        assert.ok(!html.includes('<a href="https://attacker.invalid">'));
    }
});
