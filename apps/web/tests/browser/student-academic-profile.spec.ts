import { expect, test, type Page, type Route } from '@playwright/test';
import { apiOrigin, installSyntheticApi, seedSession } from './fixtures';

const COMPLETE_PATH = '/student/profile/complete';
const STUDENT_ID = '00000000-0000-4000-8000-000000000001';
const CORS = { 'access-control-allow-origin': '*' };

function baseFields(overrides: Record<string, unknown> = {}): Record<string, unknown> {
    return {
        claimedInstitution: { state: 'unanswered' },
        programme: { state: 'unanswered' },
        entryYear: { state: 'unanswered' },
        entryRoute: { state: 'unanswered' },
        expectedGraduationYear: { state: 'unanswered' },
        graduationYearOrigin: null,
        estimateBasis: null,
        estimateStale: false,
        ...overrides,
    };
}

function pendingAssurance(): Record<string, unknown> {
    return {
        schoolAccountStatus: 'verified',
        schoolAccountMethod: 'email_otp',
        schoolAccountValidUntil: null,
        studentStatus: 'pending',
        enrollmentMethod: null,
        studentValidUntil: null,
        reason: 'awaiting_enrollment',
    };
}

function verifiedAssurance(): Record<string, unknown> {
    return { ...pendingAssurance(), studentStatus: 'verified', enrollmentMethod: 'registration', reason: null };
}

function projection(overrides: Record<string, unknown> = {}): Record<string, unknown> {
    return {
        revision: 3,
        fields: baseFields(),
        institution: { displayName: null, countryCode: null, binding: 'unbound' },
        institutionConfirmedGraduationYear: null,
        entryYearSuggestion: null,
        optionalUnansweredFields: ['claimedInstitution', 'programme', 'entryYear', 'entryRoute', 'expectedGraduationYear'],
        attentionFields: ['programme'],
        verificationRequirements: [],
        verificationContinuationAvailable: false,
        assuranceState: 'available',
        assurance: pendingAssurance(),
        referenceVersion: 'nuc-v2',
        estimate: null,
        featureEnabled: true,
        promptDecision: 'continue',
        ...overrides,
    };
}

function applyPatch(current: unknown, patch: Record<string, unknown>): unknown {
    const next = JSON.parse(JSON.stringify(current)) as Record<string, unknown>;
    next.revision = (next.revision as number) + 1;
    const fields = next.fields as Record<string, unknown>;
    for (const key of ['claimedInstitution', 'programme', 'entryYear', 'entryRoute', 'expectedGraduationYear']) {
        const update = patch[key] as { state: string; value?: unknown } | undefined;
        if (!update) continue;
        if (key === 'expectedGraduationYear' && update.state === 'supplied') {
            const choice = update.value as { kind: string; year: number };
            fields[key] = { state: 'supplied', value: choice.year };
            fields.graduationYearOrigin = choice.kind === 'accept_estimate' ? 'calculated' : 'self_reported';
            continue;
        }
        fields[key] = update.state === 'supplied' ? { state: 'supplied', value: update.value } : { state: update.state };
    }
    const optional = ['claimedInstitution', 'programme', 'entryYear', 'entryRoute', 'expectedGraduationYear'].filter((key) => {
        const field = fields[key] as { state: string };
        return field.state === 'unanswered';
    });
    next.optionalUnansweredFields = optional;
    return next;
}

type AcademicFixture = {
    puts: unknown[];
    getCalls: number;
    current: unknown;
    putBehavior: 'echo' | 'conflict' | 'error' | 'abort-once';
    estimateResult: unknown;
    estimateCalls: unknown[];
    programmeItems: unknown[];
    institutionItems: unknown[];
};

async function installAcademicApi(page: Page, initial: unknown): Promise<AcademicFixture> {
    const fixture: AcademicFixture = {
        puts: [],
        getCalls: 0,
        current: initial,
        putBehavior: 'echo',
        estimateResult: { state: 'unavailable', reason: 'missing_input' },
        estimateCalls: [],
        programmeItems: [],
        institutionItems: [],
    };
    let aborted = false;
    await page.route(`${apiOrigin}/api/students/academic-profile**`, async (route: Route) => {
        const path = new URL(route.request().url()).pathname;
        if (path === '/api/students/academic-profile' && route.request().method() === 'GET') {
            fixture.getCalls += 1;
            await route.fulfill({ json: { success: true, data: fixture.current }, headers: CORS });
            return;
        }
        if (path === '/api/students/academic-profile' && route.request().method() === 'PUT') {
            const body = route.request().postDataJSON() as Record<string, unknown>;
            fixture.puts.push(body);
            if (fixture.putBehavior === 'conflict') {
                await route.fulfill({ status: 409, json: { success: false, error: { message: 'Academic profile changed since it was read; reload and retry' } }, headers: CORS });
                return;
            }
            if (fixture.putBehavior === 'error') {
                await route.fulfill({ status: 500, json: { success: false, error: { message: 'Synthetic save failure' } }, headers: CORS });
                return;
            }
            if (fixture.putBehavior === 'abort-once' && !aborted) {
                aborted = true;
                fixture.current = applyPatch(fixture.current, body);
                await route.abort('failed');
                return;
            }
            fixture.current = applyPatch(fixture.current, body);
            await route.fulfill({ json: { success: true, data: fixture.current }, headers: CORS });
            return;
        }
        if (path === '/api/students/academic-profile/institutions') {
            await route.fulfill({ json: { success: true, data: { items: fixture.institutionItems, nextCursor: null } }, headers: CORS });
            return;
        }
        if (path === '/api/students/academic-profile/programmes') {
            await route.fulfill({ json: { success: true, data: { items: fixture.programmeItems, nextCursor: null } }, headers: CORS });
            return;
        }
        if (path === '/api/students/academic-profile/estimate') {
            fixture.estimateCalls.push(route.request().postDataJSON());
            await route.fulfill({ json: { success: true, data: fixture.estimateResult }, headers: CORS });
            return;
        }
        await route.abort('failed');
    });
    return fixture;
}

async function mockCurrentUser(page: Page, profile?: Record<string, unknown>): Promise<void> {
    const data: Record<string, unknown> = { id: STUDENT_ID, email: 'student@approved.test', role: 'student' };
    if (profile !== undefined) data.profile = profile;
    await page.route(`${apiOrigin}/api/auth/me`, (route) => route.fulfill({
        json: { success: true, data },
        headers: CORS,
    }));
}

async function openComplete(page: Page, initial: unknown, profile?: Record<string, unknown>): Promise<AcademicFixture> {
    await installSyntheticApi(page);
    const fixture = await installAcademicApi(page, initial);
    await mockCurrentUser(page, profile);
    await seedSession(page, 'student');
    await page.goto(COMPLETE_PATH);
    return fixture;
}

async function mockQuietVerification(page: Page, studentStatus: string): Promise<void> {
    await page.route(`${apiOrigin}/api/verification/**`, async (route: Route) => {
        const path = new URL(route.request().url()).pathname;
        if (path.endsWith('/status')) {
            await route.fulfill({
                json: {
                    data: {
                        mailboxConfirmed: false,
                        emailDomainApproved: true,
                        email: 'student@approved.test',
                        universityId: null,
                        eligibility: { eligible: false },
                        studentAssurance: { ...pendingAssurance(), studentStatus },
                        notices: { verification: { version: 'fixture', text: 'I agree to verification.' } },
                    },
                },
                headers: CORS,
            });
            return;
        }
        await route.fulfill({ json: { data: { items: [], nextCursor: null } }, headers: CORS });
    });
}

test('shows the voluntary experience when fresh assurance reports verified', async ({ page }) => {
    await openComplete(page, projection({ assurance: verifiedAssurance() }), { name: 'Adaeze Obi' });
    await expect(page.getByRole('heading', { level: 1 })).toHaveText('Hi, Adaeze');
    await expect(page.getByText('Add optional academic details')).toBeVisible();
    await expect(page.getByRole('button', { name: 'Save and continue' })).toBeVisible();
    await expect(page).toHaveURL(/\/student\/profile\/complete/);
});

for (const status of ['expired', 'denied', 'revoked']) {
    test(`returns to verification when fresh assurance reports ${status}`, async ({ page }) => {
        await installSyntheticApi(page);
        await installAcademicApi(page, projection({ assurance: { ...pendingAssurance(), studentStatus: status } }));
        await mockCurrentUser(page);
        await mockQuietVerification(page, status);
        await seedSession(page, 'student');
        await page.goto(COMPLETE_PATH);
        await expect(page).toHaveURL(/\/student\/verification/, { timeout: 30000 });
        await expect(page.getByRole('heading', { name: 'Student verification' })).toBeVisible();
    });
}

test('fails open when assurance is unavailable', async ({ page }) => {
    await openComplete(page, projection({ assuranceState: 'unavailable', assurance: null }));
    await expect(page.getByText('Verification status is temporarily unavailable.')).toBeVisible();
    await expect(page.getByRole('button', { name: 'Save and continue' })).toBeVisible();
    await expect(page.getByText('School account:')).toHaveCount(0);
    await expect(page.getByText('Student status:')).toHaveCount(0);
});

test('shows the unsupported-institution state when no verification continuation exists', async ({ page }) => {
    await openComplete(page, projection());
    await expect(page.getByText("We haven't enabled verification for this institution yet.")).toBeVisible();
    await expect(page.getByRole('link', { name: 'Continue verification' })).toHaveCount(0);
});

test('links to verification when a continuation is available', async ({ page }) => {
    await openComplete(page, projection({ verificationContinuationAvailable: true }));
    const link = page.getByRole('link', { name: 'Continue verification' });
    await expect(link).toBeVisible();
    await expect(link).toHaveAttribute('href', '/student/verification');
});

test('greets the student by validated profile name', async ({ page }) => {
    await openComplete(page, projection(), { name: 'Adaeze Obi' });
    await expect(page.getByRole('heading', { level: 1 })).toHaveText('Hi, Adaeze');
});

test('falls back to Hi there without a profile name', async ({ page }) => {
    await openComplete(page, projection());
    await expect(page.getByRole('heading', { level: 1 })).toHaveText('Hi there');
});

test('falls back to Hi there with a blank profile name', async ({ page }) => {
    await openComplete(page, projection(), { name: '   ' });
    await expect(page.getByRole('heading', { level: 1 })).toHaveText('Hi there');
});

test('renders no collection controls when the feature is disabled', async ({ page }) => {
    const fixture = await openComplete(page, projection({
        featureEnabled: false,
        fields: baseFields({ entryYear: { state: 'supplied', value: 2021 } }),
    }));
    await expect(page.getByText('Academic profile collection is not currently available.')).toBeVisible();
    await expect(page.getByRole('textbox')).toHaveCount(0);
    await expect(page.getByRole('combobox')).toHaveCount(0);
    await expect(page.getByRole('radio')).toHaveCount(0);
    await expect(page.getByRole('button', { name: 'Save and continue' })).toHaveCount(0);
    await expect(page.getByText('Entry year:')).toBeVisible();
    await page.getByRole('button', { name: 'Complete later' }).click();
    await expect(page).toHaveURL(/\/marketplace/, { timeout: 30000 });
    expect(fixture.puts).toHaveLength(0);
});

test('reads back saved answers for editing on an explicit visit', async ({ page }) => {
    const fixture = await openComplete(page, projection({
        fields: baseFields({
            claimedInstitution: { state: 'supplied', value: { name: 'Claimed College', countryCode: 'NG' } },
            programme: { state: 'supplied', value: { programmeId: null, courseLabel: 'Old Course Label' } },
            entryYear: { state: 'supplied', value: 2021 },
            entryRoute: { state: 'supplied', value: 'utme' },
            expectedGraduationYear: { state: 'supplied', value: 2025 },
            graduationYearOrigin: 'self_reported',
        }),
        optionalUnansweredFields: [],
        attentionFields: [],
    }), { name: 'Adaeze Obi' });
    await expect(page.getByRole('combobox', { name: 'Institution name' })).toHaveValue('Claimed College');
    await expect(page.getByRole('textbox', { name: 'Country (2-letter code)' })).toHaveValue('NG');
    await expect(page.getByRole('combobox', { name: 'Programme or course' })).toHaveValue('Old Course Label');
    await expect(page.getByRole('textbox', { name: 'Entry year' })).toHaveValue('2021');
    await expect(page.getByRole('radio', { name: 'UTME / first-year entry' })).toBeChecked();
    await expect(page.getByRole('textbox', { name: 'Expected graduation year' })).toHaveValue('2025');
    await page.getByRole('textbox', { name: 'Entry year' }).fill('2022');
    await page.getByRole('button', { name: 'Save and continue' }).click();
    await expect(page).toHaveURL(/\/marketplace/, { timeout: 30000 });
    expect(fixture.puts).toHaveLength(1);
    expect(fixture.puts[0]).toEqual({ expectedRevision: 3, entryYear: { state: 'supplied', value: 2022 } });
});

test('keeps a server-bound institution read-only with a correction path', async ({ page }) => {
    await openComplete(page, projection({
        institution: { displayName: 'Bound University', countryCode: 'NG', binding: 'server_bound' },
    }));
    await expect(page.getByText('Bound University')).toBeVisible();
    await expect(page.getByText('This is bound to your school identity and cannot be changed here.')).toBeVisible();
    const correction = page.getByRole('link', { name: 'My institution is incorrect' });
    await expect(correction).toBeVisible();
    await expect(correction).toHaveAttribute('href', '/student/profile/support');
    await expect(page.locator('#field-institution').getByRole('textbox')).toHaveCount(0);
    await expect(page.locator('#field-institution').getByRole('combobox')).toHaveCount(0);
    await expect(page.locator('#field-institution').getByRole('button', { name: 'Skip this detail' })).toHaveCount(0);
});

test('saves a claimed institution with its country', async ({ page }) => {
    const fixture = await openComplete(page, projection());
    await page.getByRole('combobox', { name: 'Institution name' }).fill('Claimed College');
    await page.getByRole('button', { name: 'Save and continue' }).click();
    await expect(page.locator('#institution-error')).toHaveText('Enter the institution name and its 2-letter country code, or choose Not sure or Skip this detail.');
    expect(fixture.puts).toHaveLength(0);
    await expect(page).toHaveURL(/\/student\/profile\/complete/);
    await page.getByRole('textbox', { name: 'Country (2-letter code)' }).fill('ng');
    await page.getByRole('button', { name: 'Save and continue' }).click();
    await expect(page).toHaveURL(/\/marketplace/, { timeout: 30000 });
    expect(fixture.puts).toHaveLength(1);
    expect(fixture.puts[0]).toEqual({
        expectedRevision: 3,
        claimedInstitution: { state: 'supplied', value: { name: 'Claimed College', countryCode: 'NG' } },
    });
});

test('selects a programme through keyboard typeahead and clears the selection on edit', async ({ page }) => {
    const fixture = await openComplete(page, projection());
    fixture.programmeItems = [
        { programmeId: 'SYN-P1', label: 'Synthetic Programme One', award: 'B.Sc.' },
        { programmeId: 'SYN-P2', label: 'Synthetic Programme Two', award: null },
    ];
    const input = page.getByRole('combobox', { name: 'Programme or course' });
    const listbox = page.getByRole('listbox', { name: 'Programme or course suggestions' });
    await input.click();
    await input.fill('syn');
    await expect(listbox).toBeVisible();
    await expect(page.getByRole('option').first()).toBeVisible();
    await input.press('ArrowDown');
    await expect(page.getByRole('option').first()).toHaveAttribute('aria-selected', 'true');
    await input.press('Enter');
    await expect(input).toHaveValue('Synthetic Programme One');
    await expect(listbox).toBeHidden();
    await input.fill('syn');
    await expect(listbox).toBeVisible();
    await input.press('Escape');
    await expect(listbox).toBeHidden();
    await input.press('End');
    await input.pressSequentially(' X');
    await page.getByRole('button', { name: 'Save and continue' }).click();
    await expect(page).toHaveURL(/\/marketplace/, { timeout: 30000 });
    expect(fixture.puts).toHaveLength(1);
    expect(fixture.puts[0]).toEqual({
        expectedRevision: 3,
        programme: { state: 'supplied', value: { programmeId: null, courseLabel: 'syn X' } },
    });
});

test('accepts a suggested entry year', async ({ page }) => {
    const fixture = await openComplete(page, projection({
        entryYearSuggestion: { state: 'suggested', year: 2021, parserId: 'synthetic-parser', parserVersion: 'v1', confidence: 'high' },
    }));
    await expect(page.getByText('Your school record suggests you started in')).toBeVisible();
    await page.getByRole('button', { name: 'Use suggested year' }).click();
    await expect(page.getByRole('textbox', { name: 'Entry year' })).toHaveValue('2021');
    await page.getByRole('button', { name: 'Save and continue' }).click();
    await expect(page).toHaveURL(/\/marketplace/, { timeout: 30000 });
    expect(fixture.puts).toHaveLength(1);
    expect(fixture.puts[0]).toEqual({ expectedRevision: 3, entryYear: { state: 'supplied', value: 2021 } });
});

test('edits a suggested entry year before confirming', async ({ page }) => {
    const fixture = await openComplete(page, projection({
        entryYearSuggestion: { state: 'suggested', year: 2021, parserId: 'synthetic-parser', parserVersion: 'v1', confidence: 'high' },
    }));
    await page.getByRole('textbox', { name: 'Entry year' }).fill('2020');
    await page.getByRole('button', { name: 'Save and continue' }).click();
    await expect(page).toHaveURL(/\/marketplace/, { timeout: 30000 });
    expect(fixture.puts).toHaveLength(1);
    expect(fixture.puts[0]).toEqual({ expectedRevision: 3, entryYear: { state: 'supplied', value: 2020 } });
});

test('dismisses a suggestion without writing or suppressing other fields', async ({ page }) => {
    const fixture = await openComplete(page, projection({
        entryYearSuggestion: { state: 'suggested', year: 2021, parserId: 'synthetic-parser', parserVersion: 'v1', confidence: 'high' },
    }));
    await page.getByRole('button', { name: 'Dismiss suggestion' }).click();
    await expect(page.getByRole('button', { name: 'Use suggested year' })).toHaveCount(0);
    await page.locator('#field-programme').getByRole('button', { name: 'Skip this detail' }).click();
    await page.getByRole('button', { name: 'Save and continue' }).click();
    await expect(page).toHaveURL(/\/marketplace/, { timeout: 30000 });
    expect(fixture.puts).toHaveLength(1);
    expect(fixture.puts[0]).toEqual({ expectedRevision: 3, programme: { state: 'skipped' } });
    expect('entryYear' in (fixture.puts[0] as Record<string, unknown>)).toBe(false);
});

test('hides the suggestion over a confirmed entry year', async ({ page }) => {
    await openComplete(page, projection({
        fields: baseFields({ entryYear: { state: 'supplied', value: 2019 } }),
        entryYearSuggestion: { state: 'suggested', year: 2021, parserId: 'synthetic-parser', parserVersion: 'v1', confidence: 'high' },
    }));
    await expect(page.getByRole('textbox', { name: 'Entry year' })).toHaveValue('2019');
    await expect(page.getByRole('button', { name: 'Use suggested year' })).toHaveCount(0);
});

test('accepts a projected graduation estimate', async ({ page }) => {
    const fixture = await openComplete(page, projection({
        fields: baseFields({
            programme: { state: 'supplied', value: { programmeId: 'SYN-P1', courseLabel: null } },
            entryYear: { state: 'supplied', value: 2021 },
            entryRoute: { state: 'supplied', value: 'utme' },
        }),
        estimate: { year: 2026, ruleId: 'SYN-R1', sourceVersion: 'nuc-v2' },
    }));
    await expect(page.getByText('Estimated graduation year:')).toBeVisible();
    await page.getByRole('button', { name: 'Use estimated year' }).click();
    await expect(page.getByText('Using estimated year')).toBeVisible();
    await page.getByRole('button', { name: 'Save and continue' }).click();
    await expect(page).toHaveURL(/\/marketplace/, { timeout: 30000 });
    expect(fixture.puts).toHaveLength(1);
    expect(fixture.puts[0]).toEqual({
        expectedRevision: 3,
        expectedGraduationYear: { state: 'supplied', value: { kind: 'accept_estimate', year: 2026 } },
    });
});

test('enters a self-reported graduation year', async ({ page }) => {
    const fixture = await openComplete(page, projection({
        fields: baseFields({ entryYear: { state: 'supplied', value: 2021 } }),
    }));
    await page.getByRole('textbox', { name: 'Expected graduation year' }).fill('2029');
    await page.getByRole('button', { name: 'Save and continue' }).click();
    await expect(page).toHaveURL(/\/marketplace/, { timeout: 30000 });
    expect(fixture.puts).toHaveLength(1);
    expect(fixture.puts[0]).toEqual({
        expectedRevision: 3,
        expectedGraduationYear: { state: 'supplied', value: { kind: 'self_reported', year: 2029 } },
    });
});

test('fetches an estimate for typed inputs and accepts the recomputed year', async ({ page }) => {
    const fixture = await openComplete(page, projection());
    fixture.estimateResult = { state: 'available', year: 2025, ruleId: 'SYN-R1', sourceVersion: 'nuc-v2' };
    await page.getByRole('combobox', { name: 'Programme or course' }).fill('Some Course');
    await page.getByRole('textbox', { name: 'Entry year' }).fill('2021');
    await page.getByRole('radio', { name: 'UTME / first-year entry' }).check();
    await page.getByRole('button', { name: 'Get estimated year' }).click();
    await expect(page.getByText('Estimated graduation year:')).toBeVisible();
    expect(fixture.estimateCalls).toEqual([{ programmeId: null, entryYear: 2021, entryRoute: 'utme' }]);
    await page.getByRole('button', { name: 'Use estimated year' }).click();
    await page.getByRole('button', { name: 'Save and continue' }).click();
    await expect(page).toHaveURL(/\/marketplace/, { timeout: 30000 });
    expect(fixture.puts).toHaveLength(1);
    expect(fixture.puts[0]).toEqual({
        expectedRevision: 3,
        programme: { state: 'supplied', value: { programmeId: null, courseLabel: 'Some Course' } },
        entryYear: { state: 'supplied', value: 2021 },
        entryRoute: { state: 'supplied', value: 'utme' },
        expectedGraduationYear: { state: 'supplied', value: { kind: 'accept_estimate', year: 2025 } },
    });
});

test('explains unavailable estimates honestly', async ({ page }) => {
    const fixture = await openComplete(page, projection());
    await page.getByRole('button', { name: 'Get estimated year' }).click();
    await expect(page.getByText('Add a programme, entry year, and entry route to see an estimate.')).toBeVisible();
    expect(fixture.estimateCalls).toHaveLength(0);
    fixture.estimateResult = { state: 'unavailable', reason: 'unreviewed_rule' };
    await page.getByRole('combobox', { name: 'Programme or course' }).fill('Some Course');
    await page.getByRole('textbox', { name: 'Entry year' }).fill('2021');
    await page.getByRole('radio', { name: 'UTME / first-year entry' }).check();
    await page.getByRole('button', { name: 'Get estimated year' }).click();
    await expect(page.getByText('This programme duration has not been reviewed yet, so there is no estimate. You can still enter your expected year.')).toBeVisible();
    expect(fixture.estimateCalls).toHaveLength(1);
});

test('requires reconfirmation when inputs invalidate a calculated year', async ({ page }) => {
    const fixture = await openComplete(page, projection({
        fields: baseFields({
            programme: { state: 'supplied', value: { programmeId: 'SYN-P1', courseLabel: null } },
            entryYear: { state: 'supplied', value: 2021 },
            entryRoute: { state: 'supplied', value: 'utme' },
            expectedGraduationYear: { state: 'supplied', value: 2025 },
            graduationYearOrigin: 'calculated',
            estimateBasis: { programmeId: 'SYN-P1', entryYear: 2021, entryRoute: 'utme', ruleId: 'SYN-R1', sourceVersion: 'nuc-v2' },
            estimateStale: false,
        }),
    }));
    await expect(page.getByText(/Saved:/)).toBeVisible();
    await expect(page.getByText(/may be out of date/)).toHaveCount(0);
    await page.getByRole('radio', { name: 'Direct Entry (200 level)' }).check();
    await expect(page.getByText(/may be out of date/)).toBeVisible();
    fixture.estimateResult = { state: 'available', year: 2027, ruleId: 'SYN-R1', sourceVersion: 'nuc-v2' };
    await page.getByRole('button', { name: 'Get estimated year' }).click();
    await expect(page.getByText('Estimated graduation year:')).toBeVisible();
    expect(fixture.estimateCalls).toEqual([{ programmeId: 'SYN-P1', entryYear: 2021, entryRoute: 'de_200' }]);
    await page.getByRole('button', { name: 'Use estimated year' }).click();
    await page.getByRole('button', { name: 'Save and continue' }).click();
    await expect(page).toHaveURL(/\/marketplace/, { timeout: 30000 });
    expect(fixture.puts).toHaveLength(1);
    expect(fixture.puts[0]).toEqual({
        expectedRevision: 3,
        entryRoute: { state: 'supplied', value: 'de_200' },
        expectedGraduationYear: { state: 'supplied', value: { kind: 'accept_estimate', year: 2027 } },
    });
});

test('preserves a self-reported override when inputs change', async ({ page }) => {
    const fixture = await openComplete(page, projection({
        fields: baseFields({
            programme: { state: 'supplied', value: { programmeId: null, courseLabel: 'Old Course' } },
            entryYear: { state: 'supplied', value: 2020 },
            entryRoute: { state: 'supplied', value: 'utme' },
            expectedGraduationYear: { state: 'supplied', value: 2028 },
            graduationYearOrigin: 'self_reported',
        }),
    }));
    await expect(page.getByRole('textbox', { name: 'Expected graduation year' })).toHaveValue('2028');
    await page.getByRole('combobox', { name: 'Programme or course' }).fill('New Course');
    await expect(page.getByText(/may be out of date/)).toHaveCount(0);
    await expect(page.getByRole('textbox', { name: 'Expected graduation year' })).toHaveValue('2028');
    await page.getByRole('button', { name: 'Save and continue' }).click();
    await expect(page).toHaveURL(/\/marketplace/, { timeout: 30000 });
    expect(fixture.puts).toHaveLength(1);
    expect(fixture.puts[0]).toEqual({
        expectedRevision: 3,
        programme: { state: 'supplied', value: { programmeId: null, courseLabel: 'New Course' } },
    });
    expect('expectedGraduationYear' in (fixture.puts[0] as Record<string, unknown>)).toBe(false);
});

test('keeps an institution-confirmed year read-only with its correction path', async ({ page }) => {
    const fixture = await openComplete(page, projection({
        institutionConfirmedGraduationYear: { year: 2026, observedAt: '2026-09-01T00:00:00.000Z' },
    }));
    await expect(page.getByText('Graduation year confirmed by your institution:')).toBeVisible();
    const correction = page.getByRole('link', { name: 'continue verification' });
    await expect(correction).toBeVisible();
    await expect(correction).toHaveAttribute('href', '/student/verification');
    await expect(page.locator('#field-graduation-year').getByRole('textbox')).toHaveCount(0);
    await expect(page.locator('#field-graduation-year').getByRole('button', { name: 'Get estimated year' })).toHaveCount(0);
    await expect(page.locator('#field-graduation-year').getByRole('button', { name: 'Skip this detail' })).toHaveCount(0);
    await page.getByRole('textbox', { name: 'Entry year' }).fill('2021');
    await page.getByRole('button', { name: 'Save and continue' }).click();
    await expect(page).toHaveURL(/\/marketplace/, { timeout: 30000 });
    expect(fixture.puts).toHaveLength(1);
    expect('expectedGraduationYear' in (fixture.puts[0] as Record<string, unknown>)).toBe(false);
});

test('saves only touched fields', async ({ page }) => {
    const fixture = await openComplete(page, projection());
    await page.getByRole('radio', { name: 'Direct Entry (300 level)' }).check();
    await page.getByRole('button', { name: 'Save and continue' }).click();
    await expect(page).toHaveURL(/\/marketplace/, { timeout: 30000 });
    expect(fixture.puts).toHaveLength(1);
    expect(fixture.puts[0]).toEqual({ expectedRevision: 3, entryRoute: { state: 'supplied', value: 'de_300' } });
});

test('saves every optional skip distinctly', async ({ page }) => {
    const fixture = await openComplete(page, projection());
    await page.locator('#field-institution').getByRole('button', { name: 'Skip this detail' }).click();
    await page.locator('#field-programme').getByRole('button', { name: 'Skip this detail' }).click();
    await page.locator('#field-entry-year').getByRole('button', { name: 'Skip this detail' }).click();
    await page.locator('#field-entry-route').getByRole('button', { name: 'Skip this detail' }).click();
    await page.locator('#field-graduation-year').getByRole('button', { name: 'Skip this detail' }).click();
    await page.getByRole('button', { name: 'Save and continue' }).click();
    await expect(page).toHaveURL(/\/marketplace/, { timeout: 30000 });
    expect(fixture.puts).toHaveLength(1);
    expect(fixture.puts[0]).toEqual({
        expectedRevision: 3,
        claimedInstitution: { state: 'skipped' },
        programme: { state: 'skipped' },
        entryYear: { state: 'skipped' },
        entryRoute: { state: 'skipped' },
        expectedGraduationYear: { state: 'skipped' },
    });
});

test('saves an explicit Not sure distinctly from a skip', async ({ page }) => {
    const fixture = await openComplete(page, projection());
    await page.locator('#field-programme').getByRole('button', { name: 'Not sure' }).click();
    await expect(page.getByText('You marked this as Not sure.')).toBeVisible();
    await page.getByRole('button', { name: 'Save and continue' }).click();
    await expect(page).toHaveURL(/\/marketplace/, { timeout: 30000 });
    expect(fixture.puts).toHaveLength(1);
    expect(fixture.puts[0]).toEqual({ expectedRevision: 3, programme: { state: 'unknown' } });
});

test('reconciles a lost save response without resubmitting', async ({ page }) => {
    const fixture = await openComplete(page, projection());
    fixture.putBehavior = 'abort-once';
    await page.getByRole('textbox', { name: 'Entry year' }).fill('2021');
    await page.getByRole('button', { name: 'Save and continue' }).click();
    await expect(page).toHaveURL(/\/marketplace/, { timeout: 30000 });
    expect(fixture.puts).toHaveLength(1);
    expect(fixture.getCalls).toBeGreaterThanOrEqual(2);
});

test('shows a conflict with reload when the revision is stale', async ({ page }) => {
    const fixture = await openComplete(page, projection());
    fixture.putBehavior = 'conflict';
    await page.getByRole('textbox', { name: 'Entry year' }).fill('2021');
    await page.getByRole('button', { name: 'Save and continue' }).click();
    await expect(page.getByText('Your profile changed since it was read. Reload the latest values before saving again.')).toBeVisible();
    await expect(page).toHaveURL(/\/student\/profile\/complete/);
    expect(fixture.puts).toHaveLength(1);
    fixture.current = projection({
        revision: 4,
        fields: baseFields({ entryYear: { state: 'supplied', value: 2022 } }),
    });
    await page.getByRole('button', { name: 'Reload profile' }).click();
    await expect(page.getByRole('textbox', { name: 'Entry year' })).toHaveValue('2022');
    expect(fixture.puts).toHaveLength(1);
});

test('stays on the form when saving fails, then retries', async ({ page }) => {
    const fixture = await openComplete(page, projection());
    fixture.putBehavior = 'error';
    await page.getByRole('textbox', { name: 'Entry year' }).fill('2021');
    await page.getByRole('button', { name: 'Save and continue' }).click();
    await expect(page.getByText('Synthetic save failure')).toBeVisible();
    await expect(page).toHaveURL(/\/student\/profile\/complete/);
    expect(fixture.puts).toHaveLength(1);
    fixture.putBehavior = 'echo';
    await page.getByRole('button', { name: 'Save and continue' }).click();
    await expect(page).toHaveURL(/\/marketplace/, { timeout: 30000 });
    expect(fixture.puts).toHaveLength(2);
});

test('reports saved state and retries navigation without resubmitting', async ({ page }) => {
    const fixture = await openComplete(page, projection());
    await page.getByRole('textbox', { name: 'Entry year' }).fill('2021');
    await page.evaluate(() => {
        (window as unknown as Record<string, unknown>).__awoofFailNextExitNavigation = true;
    });
    await page.getByRole('button', { name: 'Save and continue' }).click();
    await expect(page.getByText("We couldn't take you to the next page.")).toBeVisible();
    await expect(page.getByText('Profile saved').first()).toBeVisible();
    expect(fixture.puts).toHaveLength(1);
    await page.getByRole('button', { name: 'Try again' }).click();
    await expect(page).toHaveURL(/\/marketplace/, { timeout: 30000 });
    expect(fixture.puts).toHaveLength(1);
});

test('stays on a dirty form when leaving is cancelled', async ({ page }) => {
    const fixture = await openComplete(page, projection());
    await page.getByRole('textbox', { name: 'Entry year' }).fill('2022');
    await page.getByRole('button', { name: 'Complete later' }).click();
    const dialog = page.getByRole('alertdialog');
    await expect(dialog).toBeVisible();
    await dialog.getByRole('button', { name: 'Stay on this page' }).click();
    await expect(dialog).toBeHidden();
    await expect(page).toHaveURL(/\/student\/profile\/complete/);
    await expect(page.getByRole('textbox', { name: 'Entry year' })).toHaveValue('2022');
    expect(fixture.puts).toHaveLength(0);
});

test('discards a dirty draft when leaving without saving', async ({ page }) => {
    const fixture = await openComplete(page, projection());
    await page.getByRole('textbox', { name: 'Entry year' }).fill('2022');
    await page.getByRole('button', { name: 'Complete later' }).click();
    await page.getByRole('alertdialog').getByRole('button', { name: 'Discard and continue' }).click();
    await expect(page).toHaveURL(/\/marketplace/, { timeout: 30000 });
    expect(fixture.puts).toHaveLength(0);
});

test('saves a dirty draft from the leave confirmation', async ({ page }) => {
    const fixture = await openComplete(page, projection());
    await page.getByRole('textbox', { name: 'Entry year' }).fill('2022');
    await page.getByRole('button', { name: 'Complete later' }).click();
    await page.getByRole('alertdialog').getByRole('button', { name: 'Save and continue' }).click();
    await expect(page).toHaveURL(/\/marketplace/, { timeout: 30000 });
    expect(fixture.puts).toHaveLength(1);
    expect(fixture.puts[0]).toEqual({ expectedRevision: 3, entryYear: { state: 'supplied', value: 2022 } });
});

test('stays on the form when saving from the leave confirmation fails', async ({ page }) => {
    const fixture = await openComplete(page, projection());
    fixture.putBehavior = 'error';
    await page.getByRole('textbox', { name: 'Entry year' }).fill('2022');
    await page.getByRole('button', { name: 'Complete later' }).click();
    await page.getByRole('alertdialog').getByRole('button', { name: 'Save and continue' }).click();
    await expect(page.getByText('Synthetic save failure')).toBeVisible();
    await expect(page).toHaveURL(/\/student\/profile\/complete/);
    expect(fixture.puts).toHaveLength(1);
});

test('completes later without saving when clean', async ({ page }) => {
    const fixture = await openComplete(page, projection());
    await page.getByRole('button', { name: 'Complete later' }).click();
    await expect(page).toHaveURL(/\/marketplace/, { timeout: 30000 });
    expect(fixture.puts).toHaveLength(0);
});

test('follows the validated redirect after saving', async ({ page }) => {
    await installSyntheticApi(page);
    const fixture = await installAcademicApi(page, projection());
    await mockCurrentUser(page);
    await seedSession(page, 'student');
    await page.goto(`${COMPLETE_PATH}?redirect=%2Fstudent%2Fprofile`);
    await page.getByRole('textbox', { name: 'Entry year' }).fill('2021');
    await page.getByRole('button', { name: 'Save and continue' }).click();
    await expect(page).toHaveURL(/\/student\/profile$/, { timeout: 30000 });
    expect(fixture.puts).toHaveLength(1);
});

test('rejects a completion self-target exit', async ({ page }) => {
    await installSyntheticApi(page);
    const fixture = await installAcademicApi(page, projection());
    await mockCurrentUser(page);
    await seedSession(page, 'student');
    await page.goto(`${COMPLETE_PATH}?redirect=%2Fstudent%2Fprofile%2Fcomplete`);
    await page.getByRole('textbox', { name: 'Entry year' }).fill('2021');
    await page.getByRole('button', { name: 'Save and continue' }).click();
    await expect(page).toHaveURL(/\/marketplace/, { timeout: 30000 });
    expect(fixture.puts).toHaveLength(1);
});

test('links from the profile hub and verification page carry fixed return paths', async ({ page }) => {
    await installSyntheticApi(page);
    const fixture = await installAcademicApi(page, projection());
    await mockCurrentUser(page);
    await mockQuietVerification(page, 'pending');
    await seedSession(page, 'student');
    await page.goto('/student/profile');
    const hubLink = page.getByRole('link', { name: 'Complete your student profile' });
    await expect(hubLink).toBeVisible();
    await expect(hubLink).toHaveAttribute('href', '/student/profile/complete?redirect=%2Fstudent%2Fprofile');
    await hubLink.click();
    await expect(page).toHaveURL(/\/student\/profile\/complete\?redirect=%2Fstudent%2Fprofile/);
    await expect(page.getByRole('heading', { level: 1 })).toHaveText('Hi there');
    expect(fixture.getCalls).toBeGreaterThanOrEqual(1);
    await page.goto('/student/verification');
    const verificationLink = page.getByRole('link', { name: 'Complete your student profile (optional)' });
    await expect(verificationLink).toBeVisible();
    await expect(verificationLink).toHaveAttribute('href', '/student/profile/complete?redirect=%2Fstudent%2Fverification');
    await verificationLink.click();
    await expect(page).toHaveURL(/\/student\/profile\/complete\?redirect=%2Fstudent%2Fverification/);
});

test('fits a 320px viewport without horizontal scrolling', async ({ page }) => {
    await page.setViewportSize({ width: 320, height: 800 });
    await openComplete(page, projection());
    await expect(page.getByRole('heading', { level: 1 })).toBeVisible();
    const scrollWidth = await page.evaluate(() => document.documentElement.scrollWidth);
    expect(scrollWidth).toBeLessThanOrEqual(320);
});

test('emits noindex robots metadata', async ({ page }) => {
    await openComplete(page, projection());
    await expect(page.getByRole('heading', { level: 1 })).toBeVisible();
    await expect(page.locator('meta[name="robots"]')).toHaveAttribute('content', 'noindex, nofollow');
});
