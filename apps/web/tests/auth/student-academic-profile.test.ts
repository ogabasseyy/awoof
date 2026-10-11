import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
    academicProfileGreeting,
    buildAcademicProfilePatch,
    buildClaimReconfirmPatch,
    estimateUnavailableMessage,
    isFormDirty,
    parseAcademicProfileResponse,
    parseClaimChangedConflict,
    parseEstimateResult,
    parseInstitutionChangedConflict,
    parseInstitutionCataloguePage,
    parseProgrammeCataloguePage,
    patchMatchesProjection,
    resolveCompletionExit,
    type AcademicProfileForm,
    type AcademicProfileInput,
} from '../../src/lib/student-academic-profile';

const ORIGIN = 'http://127.0.0.1:3107';

function validProjection(overrides: Record<string, unknown> = {}): Record<string, unknown> {
    return {
        revision: 3,
        fields: {
            claimedInstitution: { state: 'unanswered' },
            programme: { state: 'unanswered' },
            entryYear: { state: 'unanswered' },
            entryRoute: { state: 'unanswered' },
            expectedGraduationYear: { state: 'unanswered' },
            graduationYearOrigin: null,
            estimateBasis: null,
            estimateStale: false,
        },
        institution: { displayName: null, countryCode: null, binding: 'unbound' },
        institutionConfirmedGraduationYear: null,
        entryYearSuggestion: null,
        optionalUnansweredFields: ['claimedInstitution', 'programme', 'entryYear', 'entryRoute', 'expectedGraduationYear'],
        attentionFields: ['programme'],
        verificationRequirements: [],
        verificationContinuationAvailable: false,
        assuranceState: 'available',
        assurance: {
            schoolAccountStatus: 'verified',
            schoolAccountMethod: 'email_otp',
            schoolAccountValidUntil: null,
            studentStatus: 'pending',
            enrollmentMethod: null,
            studentValidUntil: null,
            reason: 'awaiting_enrollment',
        },
        referenceVersion: 'nuc-v2',
        estimate: null,
        featureEnabled: true,
        writeAvailable: true,
        promptDecision: 'continue',
        ...overrides,
    };
}

function envelope(projection: unknown): unknown {
    return { success: true, data: projection };
}

function untouchedForm(): AcademicProfileForm {
    return {
        claimedInstitution: { state: 'unchanged' },
        programme: { state: 'unchanged' },
        entryYear: { state: 'unchanged' },
        entryRoute: { state: 'unchanged' },
        expectedGraduationYear: { state: 'unchanged' },
    };
}

test('parses an institution-change conflict with its retry revision', () => {
    const conflict = (details: unknown, status = 409) => ({
        response: { status, data: { success: false, error: { message: 'changed', code: 'CONFLICT', details } } },
    });
    assert.deepEqual(
        parseInstitutionChangedConflict(conflict({ code: 'ACADEMIC_PROFILE_INSTITUTION_CHANGED', revision: 4 })),
        { revision: 4 },
    );
    for (const error of [
        conflict({ code: 'ACADEMIC_PROFILE_REVISION_CONFLICT', revision: 4 }),
        conflict({ code: 'ACADEMIC_PROFILE_INSTITUTION_CHANGED', revision: 4 }, 500),
        conflict({ code: 'ACADEMIC_PROFILE_INSTITUTION_CHANGED' }),
        conflict({ code: 'ACADEMIC_PROFILE_INSTITUTION_CHANGED', revision: 4.5 }),
        conflict({ code: 'ACADEMIC_PROFILE_INSTITUTION_CHANGED', revision: -1 }),
        conflict({ code: 'ACADEMIC_PROFILE_INSTITUTION_CHANGED', revision: '4' }),
        conflict(null),
        { response: { status: 409, data: null } },
        { response: null },
        null,
        undefined,
    ]) {
        assert.equal(parseInstitutionChangedConflict(error), null);
    }
});

test('parses a claim-change conflict without confusing it with drift', () => {
    const conflict = (details: unknown, status = 409) => ({
        response: { status, data: { success: false, error: { message: 'changed', code: 'CONFLICT', details } } },
    });
    assert.deepEqual(
        parseClaimChangedConflict(conflict({ code: 'ACADEMIC_PROFILE_CLAIM_CHANGED', revision: 3 })),
        { revision: 3 },
    );
    for (const error of [
        conflict({ code: 'ACADEMIC_PROFILE_INSTITUTION_CHANGED', revision: 3 }),
        conflict({ code: 'ACADEMIC_PROFILE_CLAIM_CHANGED', revision: 3 }, 500),
        conflict({ code: 'ACADEMIC_PROFILE_CLAIM_CHANGED' }),
        conflict({ code: 'ACADEMIC_PROFILE_CLAIM_CHANGED', revision: 2.5 }),
        conflict({ code: 'ACADEMIC_PROFILE_CLAIM_CHANGED', revision: -1 }),
        conflict({ code: 'ACADEMIC_PROFILE_CLAIM_CHANGED', revision: '3' }),
        conflict(null),
        { response: { status: 409, data: null } },
        { response: null },
        null,
        undefined,
    ]) {
        assert.equal(parseClaimChangedConflict(error), null);
    }
});

test('rebuilds a claim-change patch with the saved supplied answers', () => {
    const view = parseAcademicProfileResponse(envelope(validProjection({
        fields: {
            claimedInstitution: { state: 'supplied', value: { name: 'Old School', countryCode: 'NG' } },
            programme: { state: 'supplied', value: { programmeId: 'SYN-P1', courseLabel: null } },
            entryYear: { state: 'supplied', value: 2021 },
            entryRoute: { state: 'unanswered' },
            expectedGraduationYear: { state: 'supplied', value: 2025 },
            graduationYearOrigin: 'calculated',
            estimateBasis: { programmeId: 'SYN-P1', entryYear: 2021, entryRoute: 'utme', ruleId: 'SYN-R1', sourceVersion: 'nuc-v2' },
            estimateStale: false,
        },
    })));
    assert.notEqual(view, null);
    const patch: AcademicProfileInput = {
        expectedRevision: 3,
        claimedInstitution: { state: 'supplied', value: { name: 'New School', countryCode: 'GH' } },
        entryYear: { state: 'supplied', value: 2022 },
    };
    assert.deepEqual(buildClaimReconfirmPatch(patch, view!), {
        expectedRevision: 3,
        claimedInstitution: { state: 'supplied', value: { name: 'New School', countryCode: 'GH' } },
        entryYear: { state: 'supplied', value: 2022 },
        programme: { state: 'supplied', value: { programmeId: 'SYN-P1', courseLabel: null } },
        expectedGraduationYear: { state: 'supplied', value: { kind: 'accept_estimate', year: 2025 } },
    });
});

test('restates a saved self-reported year as self-reported', () => {
    const view = parseAcademicProfileResponse(envelope(validProjection({
        fields: {
            claimedInstitution: { state: 'supplied', value: { name: 'Old School', countryCode: 'NG' } },
            programme: { state: 'unanswered' },
            entryYear: { state: 'unanswered' },
            entryRoute: { state: 'unanswered' },
            expectedGraduationYear: { state: 'supplied', value: 2026 },
            graduationYearOrigin: 'self_reported',
            estimateBasis: null,
            estimateStale: false,
        },
    })));
    assert.notEqual(view, null);
    const patch: AcademicProfileInput = {
        expectedRevision: 3,
        claimedInstitution: { state: 'supplied', value: { name: 'New School', countryCode: 'GH' } },
    };
    assert.deepEqual(buildClaimReconfirmPatch(patch, view!), {
        expectedRevision: 3,
        claimedInstitution: { state: 'supplied', value: { name: 'New School', countryCode: 'GH' } },
        expectedGraduationYear: { state: 'supplied', value: { kind: 'self_reported', year: 2026 } },
    });
});

test('parses the saved programme label and tolerates its absence', () => {
    const labelled = parseAcademicProfileResponse(envelope(validProjection({ programmeLabel: 'Stylised Physics' })));
    assert.equal(labelled?.programmeLabel, 'Stylised Physics');
    const missing = parseAcademicProfileResponse(envelope(validProjection()));
    assert.equal(missing?.programmeLabel, null);
    assert.equal(parseAcademicProfileResponse(envelope(validProjection({ programmeLabel: 42 }))), null);
});

test('parses a valid profile projection with a suggested entry year', () => {
    const parsed = parseAcademicProfileResponse(envelope(validProjection({
        entryYearSuggestion: {
            state: 'suggested', year: 2021, parserId: 'synthetic-parser', parserVersion: 'v1', confidence: 'high',
        },
    })));
    assert.notEqual(parsed, null);
    assert.equal(parsed?.revision, 3);
    assert.deepEqual(parsed?.fields.entryYear, { state: 'unanswered' });
    assert.deepEqual(parsed?.entryYearSuggestion, {
        state: 'suggested', year: 2021, parserId: 'synthetic-parser', parserVersion: 'v1', confidence: 'high',
    });
    assert.equal(parsed?.assurance?.studentStatus, 'pending');
    assert.equal(parsed?.featureEnabled, true);
    assert.equal(parsed?.writeAvailable, true);
});

test('accepts a bare projection without the response envelope', () => {
    const parsed = parseAcademicProfileResponse(validProjection());
    assert.notEqual(parsed, null);
    assert.equal(parsed?.revision, 3);
});

test('rejects invalid payloads safely', () => {
    assert.equal(parseAcademicProfileResponse(null), null);
    assert.equal(parseAcademicProfileResponse(undefined), null);
    assert.equal(parseAcademicProfileResponse('profile'), null);
    assert.equal(parseAcademicProfileResponse([]), null);
    assert.equal(parseAcademicProfileResponse({}), null);
    assert.equal(parseAcademicProfileResponse({ success: true }), null);
    assert.equal(parseAcademicProfileResponse(envelope(null)), null);
    assert.equal(parseAcademicProfileResponse(envelope(validProjection({ revision: -1 }))), null);
    assert.equal(parseAcademicProfileResponse(envelope(validProjection({ revision: 1.5 }))), null);
    assert.equal(parseAcademicProfileResponse(envelope(validProjection({ fields: null }))), null);
    assert.equal(parseAcademicProfileResponse(envelope(validProjection({ featureEnabled: 'yes' }))), null);
    assert.equal(parseAcademicProfileResponse(envelope(validProjection({ writeAvailable: 'yes' }))), null);
    assert.equal(parseAcademicProfileResponse(envelope(validProjection({ writeAvailable: undefined }))), null);
    assert.equal(parseAcademicProfileResponse(envelope(validProjection({ promptDecision: 'maybe' }))), null);
    assert.equal(parseAcademicProfileResponse(envelope(validProjection({
        fields: {
            claimedInstitution: { state: 'unanswered' },
            programme: { state: 'supplied', value: { programmeId: 'P1', courseLabel: 'Both set' } },
            entryYear: { state: 'unanswered' },
            entryRoute: { state: 'unanswered' },
            expectedGraduationYear: { state: 'unanswered' },
            graduationYearOrigin: null,
            estimateBasis: null,
            estimateStale: false,
        },
    }))), null);
});

test('rejects unknown field states', () => {
    assert.equal(parseAcademicProfileResponse(envelope(validProjection({
        fields: {
            claimedInstitution: { state: 'unanswered' },
            programme: { state: 'unanswered' },
            entryYear: { state: 'answered' },
            entryRoute: { state: 'unanswered' },
            expectedGraduationYear: { state: 'unanswered' },
            graduationYearOrigin: null,
            estimateBasis: null,
            estimateStale: false,
        },
    }))), null);
    assert.equal(parseAcademicProfileResponse(envelope(validProjection({
        fields: {
            claimedInstitution: { state: 'unanswered' },
            programme: { state: 'unanswered' },
            entryYear: { state: 'supplied' },
            entryRoute: { state: 'unanswered' },
            expectedGraduationYear: { state: 'unanswered' },
            graduationYearOrigin: null,
            estimateBasis: null,
            estimateStale: false,
        },
    }))), null);
});

test('parses every unavailable entry-year suggestion reason', () => {
    for (const reason of ['no_registration_number', 'unsupported_institution', 'unrecognized_format', 'ambiguous_format']) {
        const parsed = parseAcademicProfileResponse(envelope(validProjection({
            entryYearSuggestion: { state: 'unavailable', reason },
        })));
        assert.deepEqual(parsed?.entryYearSuggestion, { state: 'unavailable', reason });
    }
    assert.equal(parseAcademicProfileResponse(envelope(validProjection({
        entryYearSuggestion: { state: 'suggested', year: 2021 },
    }))), null);
    assert.equal(parseAcademicProfileResponse(envelope(validProjection({
        entryYearSuggestion: { state: 'unavailable', reason: 'guessed' },
    }))), null);
    assert.equal(parseAcademicProfileResponse(envelope(validProjection({
        entryYearSuggestion: { state: 'suggested', year: '2021', parserId: 'p', parserVersion: 'v1', confidence: 'high' },
    }))), null);
});

test('preserves stale calculated estimates with server-owned origin and basis', () => {
    const parsed = parseAcademicProfileResponse(envelope(validProjection({
        fields: {
            claimedInstitution: { state: 'unanswered' },
            programme: { state: 'supplied', value: { programmeId: 'SYN-P1', courseLabel: null } },
            entryYear: { state: 'supplied', value: 2021 },
            entryRoute: { state: 'supplied', value: 'utme' },
            expectedGraduationYear: { state: 'supplied', value: 2025 },
            graduationYearOrigin: 'calculated',
            estimateBasis: {
                programmeId: 'SYN-P1', entryYear: 2021, entryRoute: 'utme', ruleId: 'SYN-R1', sourceVersion: 'nuc-v2',
            },
            estimateStale: true,
        },
        estimate: { year: 2026, ruleId: 'SYN-R1', sourceVersion: 'nuc-v2' },
    })));
    assert.equal(parsed?.fields.graduationYearOrigin, 'calculated');
    assert.equal(parsed?.fields.estimateStale, true);
    assert.deepEqual(parsed?.estimate, { year: 2026, ruleId: 'SYN-R1', sourceVersion: 'nuc-v2' });
    assert.equal(parseAcademicProfileResponse(envelope(validProjection({
        fields: {
            claimedInstitution: { state: 'unanswered' },
            programme: { state: 'unanswered' },
            entryYear: { state: 'unanswered' },
            entryRoute: { state: 'unanswered' },
            expectedGraduationYear: { state: 'unanswered' },
            graduationYearOrigin: 'institution',
            estimateBasis: null,
            estimateStale: false,
        },
    }))), null);
    assert.equal(parseAcademicProfileResponse(envelope(validProjection({
        estimate: { year: 2026, ruleId: 'SYN-R1' },
    }))), null);
});

test('parses the institution-confirmed read-only graduation projection', () => {
    const parsed = parseAcademicProfileResponse(envelope(validProjection({
        institutionConfirmedGraduationYear: { year: 2026, observedAt: '2026-09-01T00:00:00.000Z' },
    })));
    assert.deepEqual(parsed?.institutionConfirmedGraduationYear, { year: 2026, observedAt: '2026-09-01T00:00:00.000Z' });
    assert.equal(parseAcademicProfileResponse(envelope(validProjection({
        institutionConfirmedGraduationYear: { year: 2026, observedAt: 'not-a-date' },
    }))), null);
    assert.equal(parseAcademicProfileResponse(envelope(validProjection({
        institutionConfirmedGraduationYear: { year: '2026', observedAt: '2026-09-01T00:00:00.000Z' },
    }))), null);
});

test('rejects projections that smuggle eligibility or cross-user evidence', () => {
    for (const key of ['eligible', 'eligibility', 'studentStatus', 'verificationStatus', 'studentId', 'userId', 'canonicalInstitutionId']) {
        assert.equal(
            parseAcademicProfileResponse(envelope(validProjection({ [key]: key === 'eligible' ? true : 'smuggled' }))),
            null,
            `expected rejection for forbidden key ${key}`,
        );
    }
});

test('rejects mismatched assurance pairings', () => {
    assert.equal(parseAcademicProfileResponse(envelope(validProjection({
        assuranceState: 'available', assurance: null,
    }))), null);
    assert.equal(parseAcademicProfileResponse(envelope(validProjection({
        assuranceState: 'unavailable',
        assurance: validProjection().assurance,
    }))), null);
    const unavailable = parseAcademicProfileResponse(envelope(validProjection({
        assuranceState: 'unavailable', assurance: null,
    })));
    assert.equal(unavailable?.assuranceState, 'unavailable');
    assert.equal(unavailable?.assurance, null);
});

test('greets by validated profile name and falls back without email guessing', () => {
    assert.equal(academicProfileGreeting({ id: 'u', email: 'ada@approved.test', role: 'student', profile: { name: 'Adaeze Obi' } }), 'Hi, Adaeze');
    assert.equal(academicProfileGreeting({ id: 'u', email: 'ada@approved.test', role: 'student', profile: { name: '  Adaeze  ' } }), 'Hi, Adaeze');
    assert.equal(academicProfileGreeting({ id: 'u', email: 'ada@approved.test', role: 'student' }), 'Hi there');
    assert.equal(academicProfileGreeting({ id: 'u', email: 'ada@approved.test', role: 'student', profile: {} }), 'Hi there');
    assert.equal(academicProfileGreeting({ id: 'u', email: 'ada@approved.test', role: 'student', profile: { name: '' } }), 'Hi there');
    assert.equal(academicProfileGreeting({ id: 'u', email: 'ada@approved.test', role: 'student', profile: { name: '   ' } }), 'Hi there');
    assert.equal(academicProfileGreeting(null), 'Hi there');
});

test('builds a partial patch with only touched fields', () => {
    const patch = buildAcademicProfilePatch({
        ...untouchedForm(),
        entryYear: { state: 'supplied', value: 2021 },
        entryRoute: { state: 'unknown' },
    }, 3);
    assert.deepEqual(patch, {
        expectedRevision: 3,
        entryYear: { state: 'supplied', value: 2021 },
        entryRoute: { state: 'unknown' },
    });
});

test('keeps unknown, skipped, and cleared states distinct in the patch', () => {
    const patch = buildAcademicProfilePatch({
        ...untouchedForm(),
        claimedInstitution: { state: 'skipped' },
        programme: { state: 'unknown' },
        entryYear: { state: 'unanswered' },
    }, 1);
    assert.deepEqual(patch, {
        expectedRevision: 1,
        claimedInstitution: { state: 'skipped' },
        programme: { state: 'unknown' },
        entryYear: { state: 'unanswered' },
    });
});

test('sends accepted estimates and self-reported years with distinct kinds', () => {
    const accepted = buildAcademicProfilePatch({
        ...untouchedForm(),
        expectedGraduationYear: { state: 'supplied', value: { kind: 'accept_estimate', year: 2025 } },
    }, 2);
    assert.deepEqual(accepted.expectedGraduationYear, { state: 'supplied', value: { kind: 'accept_estimate', year: 2025 } });
    const selfReported = buildAcademicProfilePatch({
        ...untouchedForm(),
        expectedGraduationYear: { state: 'supplied', value: { kind: 'self_reported', year: 2027 } },
    }, 2);
    assert.deepEqual(selfReported.expectedGraduationYear, { state: 'supplied', value: { kind: 'self_reported', year: 2027 } });
    assert.deepEqual(buildAcademicProfilePatch(untouchedForm(), 4), { expectedRevision: 4 });
});

test('tracks dirty state from touched fields only', () => {
    assert.equal(isFormDirty(untouchedForm()), false);
    assert.equal(isFormDirty({ ...untouchedForm(), programme: { state: 'skipped' } }), true);
});

test('parses bounded catalogue pages and rejects malformed items', () => {
    assert.deepEqual(
        parseInstitutionCataloguePage(envelope({ items: [{ name: 'Synthetic University', countryCode: 'NG' }], nextCursor: null })),
        { items: [{ name: 'Synthetic University', countryCode: 'NG' }], nextCursor: null },
    );
    assert.deepEqual(
        parseProgrammeCataloguePage({ items: [{ programmeId: 'SYN-P1', label: 'Synthetic Programme', award: null }], nextCursor: 'opaque' }),
        { items: [{ programmeId: 'SYN-P1', label: 'Synthetic Programme', award: null }], nextCursor: 'opaque' },
    );
    assert.equal(parseInstitutionCataloguePage(envelope({ items: [{ name: '', countryCode: 'NG' }], nextCursor: null })), null);
    assert.equal(parseProgrammeCataloguePage(envelope({ items: [{ programmeId: 'SYN-P1', label: '' }], nextCursor: null })), null);
    assert.equal(parseProgrammeCataloguePage(envelope({ items: 'nope', nextCursor: null })), null);
});

test('parses graduation estimates and rejects malformed results', () => {
    assert.deepEqual(
        parseEstimateResult(envelope({ state: 'available', year: 2025, ruleId: 'SYN-R1', sourceVersion: 'nuc-v2' })),
        { state: 'available', year: 2025, ruleId: 'SYN-R1', sourceVersion: 'nuc-v2' },
    );
    assert.deepEqual(
        parseEstimateResult(envelope({ state: 'unavailable', reason: 'unreviewed_rule' })),
        { state: 'unavailable', reason: 'unreviewed_rule' },
    );
    assert.equal(parseEstimateResult(envelope({ state: 'available', year: 2025 })), null);
    assert.equal(parseEstimateResult(envelope({ state: 'unavailable', reason: 'guessed' })), null);
    assert.equal(parseEstimateResult(null), null);
});

test('explains every unavailable estimate reason honestly', () => {
    assert.equal(estimateUnavailableMessage('missing_input'), 'Add a programme, entry year, and entry route to see an estimate.');
    assert.equal(estimateUnavailableMessage('unsupported_country'), 'Estimates are not available for this country yet. You can still enter your expected year.');
    assert.equal(estimateUnavailableMessage('unsupported_route'), 'Estimates are not available for this entry route. You can still enter your expected year.');
    assert.equal(estimateUnavailableMessage('unknown_programme'), 'We do not recognize this programme for estimates. You can still enter your expected year.');
    assert.equal(estimateUnavailableMessage('unreviewed_rule'), 'This programme duration has not been reviewed yet, so there is no estimate. You can still enter your expected year.');
    assert.equal(estimateUnavailableMessage('conflicting_rule'), 'This programme has conflicting duration records, so there is no estimate. You can still enter your expected year.');
    assert.equal(estimateUnavailableMessage('out_of_range'), 'This combination is outside the supported year range. You can still enter your expected year.');
});

test('resolves completion exits without loops or open redirects', () => {
    assert.equal(resolveCompletionExit('/student/profile', ORIGIN), '/student/profile');
    assert.equal(resolveCompletionExit(null, ORIGIN), '/marketplace');
    assert.equal(resolveCompletionExit('/student/profile/complete', ORIGIN), '/marketplace');
    assert.equal(resolveCompletionExit('/student/profile/complete/', ORIGIN), '/marketplace');
    assert.equal(resolveCompletionExit('/student/profile/complete?redirect=/marketplace', ORIGIN), '/marketplace');
    assert.equal(resolveCompletionExit('/student/profile/complete/deeper', ORIGIN), '/marketplace');
    assert.equal(resolveCompletionExit('https://evil.test/marketplace', ORIGIN), '/marketplace');
});

test('reconciles an unknown save outcome against the current projection', () => {
    const view = parseAcademicProfileResponse(envelope(validProjection({
        revision: 4,
        fields: {
            claimedInstitution: { state: 'unanswered' },
            programme: { state: 'supplied', value: { programmeId: 'SYN-P1', courseLabel: null } },
            entryYear: { state: 'supplied', value: 2021 },
            entryRoute: { state: 'unanswered' },
            expectedGraduationYear: { state: 'supplied', value: 2025 },
            graduationYearOrigin: 'calculated',
            estimateBasis: {
                programmeId: 'SYN-P1', entryYear: 2021, entryRoute: 'utme', ruleId: 'SYN-R1', sourceVersion: 'nuc-v2',
            },
            estimateStale: false,
        },
    })));
    assert.notEqual(view, null);
    if (!view) return;
    const committed: AcademicProfileInput = {
        expectedRevision: 3,
        programme: { state: 'supplied', value: { programmeId: 'SYN-P1', courseLabel: null } },
        entryYear: { state: 'supplied', value: 2021 },
        expectedGraduationYear: { state: 'supplied', value: { kind: 'accept_estimate', year: 2025 } },
    };
    assert.equal(patchMatchesProjection(committed, view), true);
    assert.equal(patchMatchesProjection({
        expectedRevision: 3,
        entryYear: { state: 'supplied', value: 2020 },
    }, view), false);
    assert.equal(patchMatchesProjection({
        expectedRevision: 3,
        expectedGraduationYear: { state: 'supplied', value: { kind: 'self_reported', year: 2025 } },
    }, view), false);
    assert.equal(patchMatchesProjection({ expectedRevision: 3 }, view), true);
});
