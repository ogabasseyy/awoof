import assert from 'node:assert/strict';
import test from 'node:test';
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
    type JsonSchema = { $ref?: string; additionalProperties?: boolean; required?: string[]; properties?: Record<string, JsonSchema> };
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
    assert.ok(notice?.get);
    assert.equal(start?.post?.requestBody?.content['application/json']?.schema.additionalProperties, false);
    assert.equal(finish?.post?.requestBody?.content['application/json']?.schema.additionalProperties, false);
    assert.ok(consents?.get);
    assert.equal(consents?.post?.requestBody?.content['application/json']?.schema.additionalProperties, false);
    assert.ok(consents?.post?.requestBody?.content['application/json']?.schema.properties?.snapshot);
    assert.equal(withdrawal?.post?.requestBody?.content['application/json']?.schema.additionalProperties, false);

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

    const microsoftError = spec.components.responses.MicrosoftRequestError.content['application/json'].schema;
    assert.equal(microsoftError.$ref, '#/components/schemas/MicrosoftRequestError');
    for (const [endpoint, statuses] of [
        [start?.post, ['400', '401', '503']],
        [finish?.post, ['400', '401', '409']],
        [notice?.get, ['401', '503']],
        [consents?.get, ['400', '401']],
        [consents?.post, ['400', '409', '503']],
        [withdrawal?.post, ['400', '401', '403']],
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
});
