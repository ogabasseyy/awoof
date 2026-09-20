import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { swaggerSpec } from '../src/config/swagger.ts';

const backendRoot = resolve(import.meta.dirname, '..');
const output = resolve(backendRoot, 'dist/config/openapi.json');
const requiredPaths = [
    '/api/auth/login',
    '/api/students/savings',
    '/api/merchant-verification/assertions',
    '/api/verification/microsoft/notice',
    '/api/verification/microsoft/consents',
    '/api/verification/microsoft/consents/{id}/withdraw',
    '/api/verification/microsoft/identities',
    '/api/verification/microsoft/identities/{id}/unlink',
    '/api/verification/microsoft/finish',
];

function assertRenderedSpec(spec) {
    if (!spec || typeof spec !== 'object' || !('paths' in spec) || !spec.paths || typeof spec.paths !== 'object') {
        throw new Error('Rendered OpenAPI document has no paths object.');
    }
    for (const path of requiredPaths) {
        if (!(path in spec.paths)) throw new Error(`Rendered OpenAPI document is missing required path: ${path}`);
    }
    const consentHistory = spec.components?.schemas?.MicrosoftConsentHistoryResponse?.properties?.data?.properties?.nextCursor;
    const withdrawal = spec.components?.schemas?.MicrosoftConsentWithdrawalResponse?.properties?.data?.properties?.withdrawn;
    if (consentHistory?.nullable !== true || withdrawal?.type !== 'boolean') {
        throw new Error('Rendered OpenAPI document is missing required Microsoft nullable/withdrawal contracts.');
    }
}

// Remove any previous render without a check-then-act race: force ignores a
// missing file, while a directory still fails (EISDIR/EPERM) instead of
// being replaced.
try {
    rmSync(output, { force: true });
} catch (error) {
    throw new Error(`Refusing to replace non-file OpenAPI output: ${output}`, { cause: error });
}
assertRenderedSpec(swaggerSpec);
mkdirSync(resolve(backendRoot, 'dist/config'), { recursive: true });
writeFileSync(output, `${JSON.stringify(swaggerSpec, null, 2)}\n`, { encoding: 'utf8' });
const rendered = JSON.parse(readFileSync(output, 'utf8'));
assertRenderedSpec(rendered);
