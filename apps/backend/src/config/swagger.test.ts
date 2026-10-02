import assert from 'node:assert/strict';
import test from 'node:test';
import { passwordService } from '../services/auth/password.service.js';
import { swaggerSpec } from './swagger.js';

interface Schema {
    type?: string;
    nullable?: boolean;
    minimum?: number;
    properties: Record<string, Schema>;
    items: Schema;
    allOf: Schema[];
}

test('published savings schema describes nullable totals and partial-history metadata', () => {
    const spec = swaggerSpec as { paths: Record<string, { get: { responses: Record<string, { content: Record<string, { schema: Schema }> }> } }> };
    const data = spec.paths['/api/students/savings'].get.responses['200'].content['application/json'].schema.allOf[1].properties.data;
    const summary = data.properties.summary.properties;
    for (const field of ['totalSavings', 'totalValue']) {
        assert.equal(summary[field].type, 'number');
        assert.equal(summary[field].nullable, true);
    }
    for (const fields of [summary, data.properties.byCategory.items.properties]) {
        assert.equal(fields.recordedSavings.type, 'number');
        assert.equal(fields.unknownSavingsCount.type, 'integer');
        assert.equal(fields.unknownSavingsCount.minimum, 0);
    }
    assert.equal(data.properties.byCategory.items.properties.savings.nullable, true);
});

test('publishes the strict Microsoft consent notice, history, acceptance, and withdrawal contract', () => {
    type JsonSchema = { $ref?: string; type?: string; nullable?: boolean; enum?: Array<string | number | boolean>; additionalProperties?: boolean; required?: string[]; properties?: Record<string, JsonSchema>; items?: JsonSchema };
    type Endpoint = {
        requestBody?: { content: Record<string, { schema: JsonSchema }> };
        responses?: Record<string, { $ref?: string; content?: Record<string, { schema: JsonSchema }> }>;
    };
    const spec = swaggerSpec as {
        paths: Record<string, Record<string, Endpoint>>;
        components: {
            schemas: Record<string, JsonSchema>;
            responses: Record<string, { content: Record<string, { schema: JsonSchema }> }>;
        };
    };
    const notice = spec.paths['/api/verification/microsoft/notice'];
    const start = spec.paths['/api/verification/microsoft/start'];
    const finish = spec.paths['/api/verification/microsoft/finish'];
    const consents = spec.paths['/api/verification/microsoft/consents'];
    const withdrawal = spec.paths['/api/verification/microsoft/consents/{id}/withdraw'];
    const identities = spec.paths['/api/verification/microsoft/identities'];
    const unlink = spec.paths['/api/verification/microsoft/identities/{id}/unlink'];
    assert.ok(notice?.get);
    assert.equal(start?.post?.requestBody?.content['application/json']?.schema.additionalProperties, false);
    assert.equal(finish?.post?.requestBody?.content['application/json']?.schema.additionalProperties, false);
    assert.ok(consents?.get);
    assert.equal(consents?.post?.requestBody?.content['application/json']?.schema.additionalProperties, false);
    assert.ok(consents?.post?.requestBody?.content['application/json']?.schema.properties?.snapshot);
    assert.equal(withdrawal?.post?.requestBody?.content['application/json']?.schema.additionalProperties, false);
    assert.ok(identities?.get);
    assert.equal(unlink?.post?.requestBody?.content['application/json']?.schema.additionalProperties, false);

    const responseSchema = (endpoint: Endpoint | undefined, status: string): JsonSchema => {
        const schema = endpoint?.responses?.[status]?.content?.['application/json']?.schema;
        assert.ok(schema, `missing application/json response schema for ${status}`);
        return schema;
    };
    assert.equal(responseSchema(start?.post, '201').$ref, '#/components/schemas/MicrosoftStartResponse');
    assert.equal(responseSchema(finish?.post, '200').$ref, '#/components/schemas/MicrosoftFinishResponse');
    assert.equal(responseSchema(notice?.get, '200').$ref, '#/components/schemas/MicrosoftNoticeResponse');
    assert.equal(responseSchema(consents?.get, '200').$ref, '#/components/schemas/MicrosoftConsentHistoryResponse');
    assert.equal(responseSchema(consents?.post, '201').$ref, '#/components/schemas/MicrosoftConsentAcceptanceResponse');
    assert.equal(responseSchema(withdrawal?.post, '200').$ref, '#/components/schemas/MicrosoftConsentWithdrawalResponse');
    assert.equal(responseSchema(identities?.get, '200').$ref, '#/components/schemas/MicrosoftIdentityHistoryResponse');
    assert.equal(responseSchema(unlink?.post, '200').$ref, '#/components/schemas/MicrosoftIdentityUnlinkResponse');

    const microsoftError = spec.components.responses.MicrosoftRequestError.content['application/json'].schema;
    assert.equal(microsoftError.$ref, '#/components/schemas/MicrosoftRequestError');
    for (const [endpoint, statuses] of [
        [start?.post, ['400', '401', '503']],
        [finish?.post, ['400', '401', '409']],
        [notice?.get, ['401', '503']],
        [consents?.get, ['400', '401']],
        [consents?.post, ['400', '409', '503']],
        [withdrawal?.post, ['400', '401', '403']],
        [identities?.get, ['400', '401']],
        [unlink?.post, ['400', '401', '403', '404', '500']],
    ] as const) {
        for (const status of statuses) {
            assert.equal(endpoint?.responses?.[status]?.$ref, '#/components/responses/MicrosoftRequestError');
        }
    }
    assert.equal(spec.components.schemas.MicrosoftRequestError.additionalProperties, false);
    assert.deepEqual(spec.components.schemas.MicrosoftConsentSnapshot.required,
        ['universityId', 'providerPolicyVersion', 'noticeVersion', 'mode', 'scopes']);
    assert.equal(spec.components.schemas.MicrosoftConsentSnapshot.additionalProperties, false);
    assert.deepEqual(spec.components.schemas.MicrosoftConsentHistoryResponse.properties?.data?.required, ['items', 'nextCursor']);
    assert.deepEqual(spec.components.schemas.MicrosoftConsentWithdrawalResponse.properties?.data?.required, ['providerConsentId', 'withdrawn']);
    assert.deepEqual(spec.components.schemas.MicrosoftIdentityHistoryResponse.properties?.data?.required, ['items', 'nextCursor']);
    assert.deepEqual(spec.components.schemas.MicrosoftIdentityUnlinkResponse.properties?.data?.required, ['identityId', 'unlinked', 'recovery']);
});

test('publishes exact strict error envelopes for redacted verification diagnostics', () => {
    type JsonSchema = { $ref?: string; type?: string; nullable?: boolean; enum?: Array<string | number | boolean>; additionalProperties?: boolean; required?: string[]; properties?: Record<string, JsonSchema>; items?: JsonSchema };
    type Endpoint = { responses?: Record<string, { content?: Record<string, { schema: JsonSchema }> }> };
    const spec = swaggerSpec as {
        paths: Record<string, Record<string, Endpoint>>;
        components: { schemas: Record<string, JsonSchema> };
    };
    const endpoint = spec.paths['/api/admin/verification-diagnostics/{correlationId}']?.get;
    assert.ok(endpoint);
    const expectedErrors = {
        '401': ['VerificationDiagnosticOuterAuthenticationError', ['Authentication failed', 'Insufficient permissions'], 'UNAUTHORIZED', 401],
        '403': ['VerificationDiagnosticForbiddenError', ['Current administrator authority required'], 'FORBIDDEN', 403],
        '404': ['VerificationDiagnosticNotFoundError', ['Verification diagnostic not found'], 'NOT_FOUND', 404],
        '422': ['VerificationDiagnosticInvalidIdentifierError', ['Invalid verification diagnostic identifier'], 'VALIDATION_ERROR', 422],
        '500': ['VerificationDiagnosticUnavailableError', ['Verification diagnostics are temporarily unavailable'], 'INTERNAL_SERVER_ERROR', 500],
    } as const;
    for (const [status, [name, messages, code, statusCode]] of Object.entries(expectedErrors)) {
        const responseSchema = endpoint.responses?.[status]?.content?.['application/json']?.schema;
        assert.equal(responseSchema?.$ref, `#/components/schemas/${name}`);
        const envelope = spec.components.schemas[name];
        assert.equal(envelope.additionalProperties, false);
        assert.deepEqual(envelope.required, ['success', 'error']);
        assert.deepEqual(envelope.properties?.success?.enum, [false]);
        const error = envelope.properties?.error;
        assert.equal(error?.type, 'object');
        assert.equal(error?.additionalProperties, false);
        assert.deepEqual(error?.required, ['message', 'code', 'statusCode']);
        assert.deepEqual(error?.properties?.message?.enum, messages);
        assert.deepEqual(error?.properties?.code?.enum, [code]);
        assert.deepEqual(error?.properties?.statusCode?.enum, [statusCode]);
    }
    const response = endpoint.responses?.['200']?.content?.['application/json']?.schema;
    const data = response?.properties?.data;
    const components = spec.components.schemas;
    assert.equal(components.VerificationDiagnosticTimelineEvent.properties?.httpStatus?.nullable, true);
    assert.equal(components.VerificationDiagnosticAggregate.properties?.averageFinishedRequestDurationMs?.nullable, true);
    assert.equal(components.VerificationDiagnosticAggregate.properties?.p95FinishedRequestDurationMs?.nullable, true);
    assert.equal(data?.additionalProperties, false);
});

test('signup name schema encodes the enforced trimmed length limits', () => {
    type JsonSchema = { type?: string; minLength?: number; maxLength?: number; pattern?: string; description?: string };
    const spec = swaggerSpec as { components: { schemas: Record<string, { properties: Record<string, JsonSchema> }> } };
    const fullName = spec.components.schemas.PasswordlessSignupCompleteRequest.properties.fullName;
    // StudentSsoSignupService.complete() trims then enforces 2-255, so raw
    // min/maxLength would diverge in both directions (' a' passes raw but
    // fails trimmed; a padded 255-char name fails raw but passes
    // trimmed). The pattern measures the trimmed value instead.
    assert.equal(fullName.type, 'string');
    assert.equal(fullName.minLength, undefined);
    assert.equal(fullName.maxLength, undefined);
    assert.equal(typeof fullName.pattern, 'string');
    const pattern = new RegExp(fullName.pattern!);
    assert.equal(pattern.test(' a'), false);
    assert.equal(pattern.test('ab'), true);
    assert.equal(pattern.test(`  ${'x'.repeat(255)}  `), true);
    assert.equal(pattern.test('x'.repeat(256)), false);
});

test('signup schemas encode the enforced handoff-secret ceiling', () => {
    type JsonSchema = { type?: string; minLength?: number; maxLength?: number };
    const spec = swaggerSpec as { components: { schemas: Record<string, { properties: Record<string, JsonSchema> }> } };
    // signupHandoffBody() and checked() reject secrets over 1024 chars.
    for (const name of ['PasswordlessSignupHandoffRequest', 'PasswordlessSignupVerifyRequest', 'PasswordlessSignupCompleteRequest']) {
        const secret = spec.components.schemas[name].properties.handoffSecret;
        assert.equal(secret.type, 'string');
        assert.equal(secret.minLength, 1);
        assert.equal(secret.maxLength, 1024, `${name} must publish the enforced ceiling`);
    }
});

test('recovery schemas encode the enforced handle-secret ceiling', () => {
    type JsonSchema = { type?: string; minLength?: number; maxLength?: number };
    const spec = swaggerSpec as { components: { schemas: Record<string, { properties: Record<string, JsonSchema> }> } };
    // StudentAccountRecoveryService.validOpaque() rejects secrets over 1024 chars.
    for (const name of ['AccountRecoveryVerifyRequest', 'AccountRecoveryCompleteRequest']) {
        const secret = spec.components.schemas[name].properties.secret;
        assert.equal(secret.type, 'string');
        assert.equal(secret.minLength, 1);
        assert.equal(secret.maxLength, 1024, `${name} must publish the enforced ceiling`);
    }
});

test('grant schema encodes the enforced secret ceiling', () => {
    type JsonSchema = { type?: string; minLength?: number; maxLength?: number };
    const spec = swaggerSpec as { components: { schemas: Record<string, { properties: Record<string, JsonSchema> }> } };
    // grantBody() rejects secrets over 1024 chars on every consumer.
    const secret = spec.components.schemas.ReauthGrant.properties.grantSecret;
    assert.equal(secret.type, 'string');
    assert.equal(secret.minLength, 1);
    assert.equal(secret.maxLength, 1024);
});

test('user schema publishes the recovery re-enrollment marker', () => {
    type JsonSchema = { type?: string; description?: string };
    const spec = swaggerSpec as { components: { schemas: Record<string, { properties: Record<string, JsonSchema>; required?: string[] }> } };
    // Login and /auth/me surface recoveryReenrollmentRequired until a
    // replacement code activates; generated clients must discover it.
    const marker = spec.components.schemas.User.properties.recoveryReenrollmentRequired;
    assert.equal(marker.type, 'boolean');
    assert.ok(!(spec.components.schemas.User.required ?? []).includes('recoveryReenrollmentRequired'), 'absent unless re-enrollment is outstanding');
});

test('recovery password schema encodes the enforced complexity rules', () => {
    type JsonSchema = { type?: string; minLength?: number; maxLength?: number; pattern?: string; description?: string };
    const spec = swaggerSpec as { components: { schemas: Record<string, { properties: Record<string, JsonSchema> }> } };
    const password = spec.components.schemas.AccountRecoveryCompleteRequest.properties.password;
    assert.equal(password.type, 'string');
    assert.equal(password.minLength, 8);
    // The complete endpoint rejects anything over 72 UTF-8 bytes (bcrypt
    // incorporates only the first 72), so the schema must publish that
    // physical ceiling — not the 1024-char transport guard.
    assert.equal(password.maxLength, 72, 'password schema must publish the enforced 72-byte ceiling');
    assert.match(password.description ?? '', /72 bytes of UTF-8/, 'password schema must disclose the byte-based limit');
    assert.ok(password.pattern, 'password schema must encode the complexity rules, not just the length floor');
    const documented = new RegExp(password.pattern);
    for (const candidate of ['ValidNew1!', 'all-lowercase-1!', 'ALL-UPPER-1!', 'NoDigits!!', 'NoSpecial11', 'Sh0rt!A', 'Br@cket[1]Aa', 'Back`tick1Aa']) {
        assert.equal(
            documented.test(candidate) && candidate.length <= (password.maxLength ?? Number.MAX_SAFE_INTEGER),
            passwordService.validatePassword(candidate).valid,
            `documented pattern must agree with enforcement for ${JSON.stringify(candidate)}`,
        );
    }
});

test('student-authenticated operations document the session-validation outage', () => {
    type Endpoint = { responses?: Record<string, { $ref?: string; description?: string }> };
    const spec = swaggerSpec as {
        paths: Record<string, Record<string, Endpoint>>;
        components: { responses: Record<string, { description?: string }> };
    };
    // The authenticate middleware raises a controlled 503 when the student
    // session lookup fails, before any route handler runs. Every
    // documented operation behind authenticate must model it: operations
    // with a cause-specific 503 mention both causes, the rest reference
    // the shared component.
    assert.equal(spec.components.responses.SessionValidationUnavailable?.description, 'Student session validation is temporarily unavailable');
    const operations: Array<[string, string]> = [
        ['/api/auth/student/sso/reauth', 'post'],
        ['/api/auth/student/sso/reauth/microsoft/start', 'post'],
        ['/api/auth/student/sso/reauth/finish', 'post'],
        ['/api/auth/student/sso/link', 'post'],
        ['/api/auth/student/sso/identities', 'get'],
        ['/api/auth/student/sso/identities/{id}/unlink', 'post'],
        ['/api/auth/student/sso/recovery-code', 'get'],
        ['/api/auth/student/sso/recovery-code/generate', 'post'],
        ['/api/auth/student/sso/recovery-code/activate', 'post'],
        ['/api/auth/student/sso/recovery-code/remove', 'post'],
        ['/api/auth/student/sso/recovery-code/cancel', 'post'],
        ['/api/auth/me', 'get'],
        ['/api/auth/update-password', 'post'],
        ['/api/students/profile', 'get'],
        ['/api/students/profile', 'put'],
        ['/api/students/purchases', 'get'],
        ['/api/students/savings', 'get'],
        ['/api/verification/registration', 'post'],
        ['/api/verification/status', 'get'],
        ['/api/merchant-verification/assertions', 'post'],
        ['/api/merchant-verification/claim-sessions/{id}', 'get'],
        ['/api/merchant-verification/product-claims', 'post'],
        ['/api/admin/students', 'get'],
    ];
    operations.push(['/api/vendors/transactions/report', 'post']);
    for (const [path, method] of operations) {
        const response = spec.paths[path]?.[method]?.responses?.['503'];
        assert.ok(response, `${method.toUpperCase()} ${path} documents the session-validation 503`);
    }
});

test('linked identity schemas publish the optional masked mailbox label', () => {
    type IdentitySchema = { required?: string[]; properties: Record<string, { type?: string }> };
    const spec = swaggerSpec as {
        components: {
            schemas: Record<string, {
                properties: Record<string, {
                    properties?: Record<string, unknown>;
                    items?: IdentitySchema;
                } & IdentitySchema>;
            }>;
        };
    };
    // listIdentities() and link() expose mailboxMasked so owners can tell
    // same-university identities apart; generated clients must discover it.
    const listed = spec.components.schemas.StudentSsoIdentitiesResponse.properties.data.properties?.identities as { items: IdentitySchema };
    assert.equal(listed.items.properties.mailboxMasked?.type, 'string');
    assert.ok(!listed.items.required?.includes('mailboxMasked'), 'masked mailbox is absent when the provider supplied none');
    const linked = spec.components.schemas.StudentSsoLinkResponse.properties.data.properties?.identity as IdentitySchema;
    assert.equal(linked.properties.mailboxMasked?.type, 'string');
    assert.ok(!linked.required?.includes('mailboxMasked'), 'masked mailbox is absent when the provider supplied none');
});


test('merchant transaction report is published with both private authentication methods and exact minor units', () => {
    const spec = swaggerSpec as { paths: Record<string, { post: {
        security: Record<string, unknown[]>[];
        requestBody: { content: { 'application/json': { schema: { required: string[]; additionalProperties: boolean; properties: Record<string, { type: string; description?: string }> } } } };
        responses: Record<string, { $ref?: string }>;
    } }>; components: { responses: Record<string, { description?: string }> } };
    const operation = spec.paths['/api/vendors/transactions/report']?.post;
    assert.ok(operation);
    assert.deepEqual(operation.security, [{ bearerAuth: [] }, { merchantServerKey: [] }]);
    const body = operation.requestBody.content['application/json'].schema;
    assert.equal(body.additionalProperties, false);
    assert.equal(body.properties.amount.type, 'integer');
    assert.ok(body.required.includes('benefitAuthorizationId'));
    assert.match(body.properties.paymentGateway.description ?? '', /paystack_merchant/);
    // Retryable merchant verification failures (missing merchant credentials,
    // rejected secrets, provider outages) name the payment subsystem, not the
    // student session validator.
    assert.equal(operation.responses['503']?.$ref, '#/components/responses/MerchantPaymentUnavailable');
    assert.equal(spec.components.responses.MerchantPaymentUnavailable?.description, 'Merchant payment verification is temporarily unavailable');
});


test('merchant order status contract requires vendor JWT and accurately describes refund bookkeeping', () => {
    const spec = swaggerSpec as { paths: Record<string, { put: {
        description: string; security: Record<string, unknown[]>[];
        parameters: { name: string; schema: { type: string; format?: string } }[];
        requestBody: { content: { 'application/json': { schema: { properties: { status: { enum: string[] } } } } } };
    } }> };
    const operation = spec.paths['/api/vendors/orders/{id}/status']?.put;
    assert.ok(operation);
    assert.deepEqual(operation.security, [{ bearerAuth: [] }]);
    assert.deepEqual(operation.requestBody.content['application/json'].schema.properties.status.enum,
        ['pending', 'completed', 'failed', 'refunded']);
    assert.match(operation.description, /does not issue a provider refund/);
    assert.match(operation.description, /require reconciliation/);
    const id = operation.parameters.find((parameter) => parameter.name === 'id');
    assert.equal(id?.schema.type, 'string');
    assert.equal(id?.schema.format, 'uuid');
});

test('published merchant operations carry no YAML-split null values', () => {
    const spec = swaggerSpec as { paths: Record<string, Record<string, unknown>> };
    const operations: [string, string][] = [
        ['/api/merchant-verification/assertions', 'post'],
        ['/api/merchant-verification/exchange', 'post'],
        ['/api/merchant-verification/claim-sessions', 'post'],
        ['/api/merchant-verification/claim-sessions/{id}', 'get'],
        ['/api/merchant-verification/product-claims', 'post'],
        ['/api/vendors/transactions/report', 'post'],
        ['/api/vendors/orders/{id}/status', 'put'],
    ];
    const nulls: string[] = [];
    const scan = (value: unknown, trail: string): void => {
        if (value === null) { nulls.push(trail); return; }
        if (!value || typeof value !== 'object') return;
        for (const [key, item] of Object.entries(value)) scan(item, `${trail}.${key}`);
    };
    for (const [path, method] of operations) {
        const operation = spec.paths[path]?.[method];
        assert.ok(operation, `merchant contract missing ${method.toUpperCase()} ${path}`);
        scan(operation, `${method.toUpperCase()} ${path}`);
    }
    assert.deepEqual(nulls, []);
});


test('merchant receipt distinguishes evidence validity from the optional persisted benefit deadline', () => {
    const spec = swaggerSpec as { components: { schemas: Record<string, { required: string[]; properties: Record<string, { type: string; format?: string; description?: string }> }> } };
    const receipt = spec.components.schemas.MerchantVerificationReceipt;
    assert.equal(receipt.properties.benefitValidUntil.type, 'string');
    assert.equal(receipt.properties.benefitValidUntil.format, 'date-time');
    assert.equal(receipt.required.includes('benefitValidUntil'), false);
    assert.match(receipt.properties.validUntil.description ?? '', /not the discounted transaction settlement deadline/);
    assert.match(receipt.properties.benefitValidUntil.description ?? '', /Historical exact receipt retries/);
});

test('merchant claim-session creation publishes the session id and expiry schema', () => {
    const spec = swaggerSpec as { paths: Record<string, Record<string, {
        responses: Record<string, { content?: { 'application/json': { schema: {
            required: string[]; properties: { success: { enum: boolean[] }; data: { $ref?: string } };
        } } } }>;
    } >>; components: { schemas: Record<string, { required: string[]; properties: Record<string, { type: string; format?: string }> }> } };
    const operation = spec.paths['/api/merchant-verification/claim-sessions']?.post;
    assert.ok(operation);
    for (const status of ['200', '201']) {
        const schema = operation.responses[status]?.content?.['application/json']?.schema;
        assert.ok(schema, `${status} publishes a claim-session success schema`);
        assert.ok(schema.required.includes('data'));
        assert.deepEqual(schema.properties.success.enum, [true]);
        assert.equal(schema.properties.data.$ref, '#/components/schemas/MerchantClaimSession');
    }
    const session = spec.components.schemas.MerchantClaimSession;
    assert.deepEqual([...session.required].sort(), ['claimSessionId', 'expiresAt']);
    assert.equal(session.properties.claimSessionId.type, 'string');
    assert.equal(session.properties.claimSessionId.format, 'uuid');
    assert.equal(session.properties.expiresAt.type, 'string');
    assert.equal(session.properties.expiresAt.format, 'date-time');
});
