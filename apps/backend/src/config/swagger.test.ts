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
    type JsonSchema = { type?: string; minLength?: number; maxLength?: number; description?: string };
    const spec = swaggerSpec as { components: { schemas: Record<string, { properties: Record<string, JsonSchema> }> } };
    const fullName = spec.components.schemas.PasswordlessSignupCompleteRequest.properties.fullName;
    // StudentSsoSignupService.complete() trims then enforces 2-255.
    assert.equal(fullName.type, 'string');
    assert.equal(fullName.minLength, 2);
    assert.equal(fullName.maxLength, 255);
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

test('recovery password schema encodes the enforced complexity rules', () => {
    type JsonSchema = { type?: string; minLength?: number; maxLength?: number; pattern?: string; description?: string };
    const spec = swaggerSpec as { components: { schemas: Record<string, { properties: Record<string, JsonSchema> }> } };
    const password = spec.components.schemas.AccountRecoveryCompleteRequest.properties.password;
    assert.equal(password.type, 'string');
    assert.equal(password.minLength, 8);
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
