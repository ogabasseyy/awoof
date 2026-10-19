/**
 * Student Profile Completion — authenticated full-screen academic-profile form.
 *
 * Freshly loads the server projection on entry and never trusts a cached
 * routing decision. Verified students see the voluntary experience only;
 * expired, denied, or revoked students return to the verification journey;
 * unavailable assurance fails open without asserting a status.
 */

'use client';

import { useEffect, useId, useRef, useState, useSyncExternalStore, type MouseEvent as ReactMouseEvent, type ReactNode } from 'react';
import Link from 'next/link';
import axios from 'axios';
import Logo from '@/app/components/logo';
import ProtectedRoute from '@/components/ProtectedRoute';
import { useAuth } from '@/contexts/AuthContext';
import { getSessionSnapshot, isCurrentSession, subscribeSessionChanges } from '@/lib/auth';
import { deferralStorage, writeDeferral } from '@/lib/student-profile-prompt';
import { schoolAccountLabel, studentStatusLabel } from '@/lib/student-assurance';
import {
    academicProfileGreeting,
    buildAcademicProfilePatch,
    buildClaimReconfirmPatch,
    claimReconfirmRequest,
    draftClaimScopeForEstimate,
    entryRouteLabel,
    estimateUnavailableMessage,
    eraseAcademicProfile,
    fetchAcademicProfile,
    parseClaimChangedConflict,
    parseInstitutionChangedConflict,
    patchMatchesProjection,
    requestGraduationEstimate,
    resolveCatalogueSearch,
    resolveCompletionExit,
    saveAcademicProfile,
    searchAcademicInstitutions,
    searchAcademicProgrammes,
    type AcademicField,
    type AcademicProfileForm,
    type AcademicProfileInput,
    type AcademicProfileView,
    type CataloguePage,
    type CatalogueSearchSnapshot,
    type CatalogueSearchStatus,
    type ClaimReconfirmRequest,
    type EntryRoute,
    type EstimateResult,
    type InstitutionCatalogueItem,
    type ProfileFieldState,
    type ProgrammeCatalogueItem,
} from '@/lib/student-academic-profile';

const sessionGeneration = () => getSessionSnapshot().generation;
const serverGeneration = () => -1;

const FIELD_LABELS: Record<AcademicField, string> = {
    claimedInstitution: 'Institution',
    programme: 'Programme or course',
    entryYear: 'Entry year',
    entryRoute: 'Entry route',
    expectedGraduationYear: 'Expected graduation year',
};

const FIELD_ANCHORS: Record<AcademicField, string> = {
    claimedInstitution: 'field-institution',
    programme: 'field-programme',
    entryYear: 'field-entry-year',
    entryRoute: 'field-entry-route',
    expectedGraduationYear: 'field-graduation-year',
};

const ENTRY_ROUTE_OPTIONS: readonly EntryRoute[] = ['utme', 'de_200', 'de_300', 'transfer_other'];

/** Storage mirror of the API's 255-character free-text limit for institution names and course labels. */
const FREE_TEXT_MAX_LENGTH = 255;

type MarkedState = 'unknown' | 'skipped' | null;

type GraduationDraft =
    | { mode: 'pristine' }
    | { mode: 'accept'; year: number }
    | { mode: 'self'; text: string }
    | { mode: 'marked'; state: 'unknown' | 'skipped' };

type EstimateUiState =
    | { status: 'idle' }
    | { status: 'loading' }
    | { status: 'ready'; result: EstimateResult }
    | { status: 'error' };

type SearchStatus = CatalogueSearchStatus;

/**
 * Where the leave dialog should take the student after Save or Discard.
 * An exit href of null means the normal completion exit; defer records
 * whether the exit writes a complete-later deferral (only the
 * Complete-later button does — header and correction links never suppress
 * the next prompt). A history leave replays the Back traversal that opened
 * the dialog.
 */
type PendingLeave =
    | { kind: 'exit'; href: string | null; defer: boolean }
    | { kind: 'history' };

const COMPLETE_LATER_LEAVE: PendingLeave = { kind: 'exit', href: null, defer: true };

/**
 * Plain left clicks are intercepted for the dirty-form check; modified
 * clicks and middle clicks keep native new-tab behavior untouched.
 */
function shouldInterceptLinkClick(event: ReactMouseEvent<HTMLAnchorElement>): boolean {
    return !event.metaKey && !event.ctrlKey && !event.shiftKey && !event.altKey && event.button === 0;
}

function currentYear(): number {
    // Match the API's UTC year boundary so entry and graduation validation
    // agrees with the server across timezones around New Year.
    return new Date().getUTCFullYear();
}

function exitDestination(): string {
    if (typeof window === 'undefined') return '/marketplace';
    return resolveCompletionExit(
        new URLSearchParams(window.location.search).get('redirect'),
        window.location.origin,
    );
}

function serverMessage(error: unknown): string | null {
    if (!axios.isAxiosError(error)) return null;
    const data = error.response?.data as { error?: { message?: unknown }; message?: unknown } | undefined;
    if (typeof data?.error?.message === 'string' && data.error.message.length > 0) return data.error.message;
    if (typeof data?.message === 'string' && data.message.length > 0) return data.message;
    return null;
}

function useCatalogueSearch<T>(
    fetcher: (query: string) => Promise<CataloguePage<T>>,
    query: string,
    enabled: boolean,
): { results: T[]; status: SearchStatus } {
    const cleared = !enabled || query.trim().length === 0;
    const searchKey = `${enabled ? '1' : '0'}:${query}`;
    const [resultSnapshot, setResultSnapshot] = useState<{ searchKey: string } & CatalogueSearchSnapshot<T>>({
        searchKey,
        items: [],
        status: 'idle',
    });
    const requestId = useRef(0);
    const [prevSearchKey, setPrevSearchKey] = useState(searchKey);
    if (searchKey !== prevSearchKey) {
        setPrevSearchKey(searchKey);
        // Rebind the snapshot to the new key with empty items: while the
        // new search loads, the combobox keyboard handler must not
        // navigate or select invisible stale options, and a late
        // resolution for the previous key is ignored by the updater
        // below even if it lands before the re-armed effect runs.
        setResultSnapshot({ searchKey, items: [], status: cleared ? 'idle' : 'loading' });
    }
    useEffect(() => {
        if (!enabled || query.trim().length === 0) {
            requestId.current += 1;
            return;
        }
        const snapshot = getSessionSnapshot();
        const id = ++requestId.current;
        const timer = setTimeout(() => {
            // Results and status settle as one key-bound snapshot through
            // the shared resolver: a superseded key can never rewrite the
            // results or clear the new key's loading status, and a stale
            // request id (student returned to a query whose earlier
            // request is still running) resolves to no commit.
            const settle = (page: CataloguePage<T> | null) => {
                if (!isCurrentSession(snapshot)) return;
                // Test-observable settlement signal: stale-search specs
                // await this counter instead of the network response, so
                // the preserved-options assertions can only run after the
                // fetcher callback reached the snapshot updater.
                const hook = window as Window & { __awoofCatalogueSettlements?: number };
                hook.__awoofCatalogueSettlements = (hook.__awoofCatalogueSettlements ?? 0) + 1;
                setResultSnapshot((prev) => {
                    const stale = id !== requestId.current || prev.searchKey !== searchKey;
                    const settled = resolveCatalogueSearch({ stale, page });
                    return settled === null ? prev : { searchKey, ...settled };
                });
            };
            fetcher(query.trim()).then(settle).catch(() => settle(null));
        }, 200);
        return () => clearTimeout(timer);
    }, [fetcher, query, enabled, searchKey]);
    return { results: resultSnapshot.items, status: resultSnapshot.status };
}

type ComboboxProps<T> = {
    id: string;
    label: string;
    value: string;
    placeholder?: string;
    maxLength?: number;
    onValueChange: (value: string) => void;
    items: readonly T[];
    itemKey: (item: T) => string;
    itemLabel: (item: T) => string;
    itemHint?: (item: T) => string | null;
    status: SearchStatus;
    onSelect: (item: T) => void;
    describedBy?: string;
    emptyText: string;
};

function SearchCombobox<T>({
    id, label, value, placeholder, maxLength, onValueChange, items, itemKey, itemLabel, itemHint, status, onSelect, describedBy, emptyText,
}: ComboboxProps<T>) {
    const [open, setOpen] = useState(false);
    const [activeIndex, setActiveIndex] = useState(-1);
    const listId = `${id}-listbox`;
    const showList = open && value.trim().length > 0;
    return (
        <div>
            <label htmlFor={id} className="block text-sm font-semibold text-slate-900">{label}</label>
            <input
                id={id}
                role="combobox"
                aria-expanded={showList}
                aria-controls={listId}
                aria-activedescendant={showList && activeIndex >= 0 && activeIndex < items.length ? `${id}-option-${activeIndex}` : undefined}
                aria-describedby={describedBy}
                autoComplete="off"
                className="mt-1 block w-full rounded-lg border border-slate-300 bg-white px-3 py-2 text-slate-900 focus:border-[#1D4ED8] focus:outline-2 focus:outline-[#1D4ED8]"
                value={value}
                placeholder={placeholder}
                maxLength={maxLength}
                onChange={(event) => {
                    onValueChange(event.target.value);
                    setOpen(true);
                    setActiveIndex(-1);
                }}
                onFocus={() => setOpen(true)}
                onBlur={() => setOpen(false)}
                onKeyDown={(event) => {
                    if (event.key === 'ArrowDown') {
                        event.preventDefault();
                        setOpen(true);
                        setActiveIndex((previous) => (items.length === 0 ? -1 : (previous + 1) % items.length));
                    } else if (event.key === 'ArrowUp') {
                        event.preventDefault();
                        setOpen(true);
                        setActiveIndex((previous) => (items.length === 0 ? -1 : (previous - 1 + items.length) % items.length));
                    } else if (event.key === 'Enter') {
                        if (showList && activeIndex >= 0 && activeIndex < items.length) {
                            event.preventDefault();
                            onSelect(items[activeIndex]);
                            setOpen(false);
                            setActiveIndex(-1);
                        } else if (showList) {
                            // The open list consumes Enter: without this
                            // the keypress also submits the enclosing form,
                            // persisting the raw query as free text before
                            // the student picks a suggestion.
                            event.preventDefault();
                            setOpen(false);
                            setActiveIndex(-1);
                        }
                    } else if (event.key === 'Escape') {
                        setOpen(false);
                        setActiveIndex(-1);
                    }
                }}
            />
            <p aria-live="polite" className="sr-only">
                {status === 'ready' && showList ? `${items.length} suggestions available.` : ''}
            </p>
            {showList && (
                <ul id={listId} role="listbox" aria-label={`${label} suggestions`} className="mt-1 max-h-56 overflow-auto rounded-lg border border-slate-200 bg-white shadow-lg">
                    {status === 'loading' && <li className="px-3 py-2 text-sm text-slate-500">Searching…</li>}
                    {status === 'error' && <li className="px-3 py-2 text-sm text-slate-500">Suggestions are unavailable.</li>}
                    {status === 'ready' && items.length === 0 && <li className="px-3 py-2 text-sm text-slate-500">{emptyText}</li>}
                    {status === 'ready' && items.map((item, index) => (
                        <li
                            key={itemKey(item)}
                            id={`${id}-option-${index}`}
                            role="option"
                            aria-selected={index === activeIndex}
                            className={`cursor-pointer px-3 py-2 text-sm ${index === activeIndex ? 'bg-[#EEF2FF] text-slate-900' : 'text-slate-700'}`}
                            onMouseDown={(event) => {
                                event.preventDefault();
                                onSelect(item);
                                setOpen(false);
                                setActiveIndex(-1);
                            }}
                        >
                            <span className="block font-semibold">{itemLabel(item)}</span>
                            {itemHint && itemHint(item) && <span className="block text-xs text-slate-500">{itemHint(item)}</span>}
                        </li>
                    ))}
                </ul>
            )}
        </div>
    );
}

function MarkedBadge({ marked }: { marked: 'unknown' | 'skipped' }) {
    return (
        <p className="mt-1 text-xs font-semibold text-slate-500">
            {marked === 'unknown' ? 'You marked this as Not sure.' : 'You skipped this detail.'}
        </p>
    );
}

type MarkButtonsProps = {
    field: string;
    marked: MarkedState;
    onMark: (state: 'unknown' | 'skipped') => void;
};

function MarkButtons({ field, marked, onMark }: MarkButtonsProps) {
    // Associate the field name with the marker pair: otherwise every
    // field exposes identically named "Not sure" / "Skip this detail"
    // buttons that screen-reader users cannot tell apart.
    const groupLabelId = useId();
    return (
        <div role="group" aria-labelledby={groupLabelId} className="mt-2 flex flex-wrap gap-2">
            <button
                type="button"
                aria-pressed={marked === 'unknown'}
                onClick={() => onMark('unknown')}
                className={`inline-flex min-h-[44px] items-center rounded-full border px-4 text-sm font-semibold ${marked === 'unknown' ? 'border-[#1D4ED8] bg-[#EEF2FF] text-[#1D4ED8]' : 'border-slate-300 text-slate-700 hover:bg-slate-50'}`}
            >
                Not sure
            </button>
            <button
                type="button"
                aria-pressed={marked === 'skipped'}
                onClick={() => onMark('skipped')}
                className={`inline-flex min-h-[44px] items-center rounded-full border px-4 text-sm font-semibold ${marked === 'skipped' ? 'border-[#1D4ED8] bg-[#EEF2FF] text-[#1D4ED8]' : 'border-slate-300 text-slate-700 hover:bg-slate-50'}`}
            >
                Skip this detail
            </button>
            <span id={groupLabelId} className="sr-only">{field}</span>
        </div>
    );
}

function CompletionForm() {
    const { user: currentUser } = useAuth();
    const [view, setView] = useState<AcademicProfileView | null>(null);
    const [loadState, setLoadState] = useState<'loading' | 'ready' | 'error'>('loading');
    const [loadError, setLoadError] = useState('');
    const [dirtyFields, setDirtyFields] = useState<AcademicField[]>([]);
    const [fieldErrors, setFieldErrors] = useState<Record<string, string>>({});
    const [saveError, setSaveError] = useState<string | null>(null);
    const [conflict, setConflict] = useState<string | null>(null);
    const [claimReconfirm, setClaimReconfirm] = useState<ClaimReconfirmRequest | null>(null);
    const [saveOutcome, setSaveOutcome] = useState<'saved' | null>(null);
    const [eraseState, setEraseState] = useState<'idle' | 'confirming' | 'erasing' | 'erased' | 'noop'>('idle');
    const [eraseError, setEraseError] = useState<string | null>(null);
    const [navFailed, setNavFailed] = useState(false);
    const [leaveDialog, setLeaveDialog] = useState(false);
    const [pendingLeave, setPendingLeave] = useState<PendingLeave | null>(null);
    // Leave to execute after a reconfirmed save. A leave-dialog save that
    // meets a claim-change conflict stashes its pending leave here; the
    // reconfirmation consumes it (deferral included) so the student lands
    // where they were headed instead of the default exit. Live exactly
    // while a dialog-save reconfirmation offer is pending: cleared with
    // the offer and never set by the main save button.
    const saveLeaveRef = useRef<PendingLeave | null>(null);
    const [saving, setSaving] = useState(false);
    const savingRef = useRef(false);
    useEffect(() => {
        savingRef.current = saving;
    }, [saving]);
    const [announce, setAnnounce] = useState('');
    const estimateRequestId = useRef(0);
    const leaveDialogRef = useRef<HTMLDivElement | null>(null);
    const completeLaterRef = useRef<HTMLButtonElement | null>(null);
    const leaveDialogWasOpen = useRef(false);
    const leaveTriggerRef = useRef<HTMLElement | null>(null);
    const leaveDialogOpenRef = useRef(false);

    // Return keyboard focus to the dialog trigger when the leave dialog
    // closes, so keyboard users are not dropped at the top of the page.
    useEffect(() => {
        leaveDialogOpenRef.current = leaveDialog;
        if (leaveDialog) {
            leaveDialogWasOpen.current = true;
        } else if (leaveDialogWasOpen.current) {
            leaveDialogWasOpen.current = false;
            (leaveTriggerRef.current ?? completeLaterRef.current)?.focus();
        }
    }, [leaveDialog]);

    const [institutionName, setInstitutionName] = useState('');
    const [institutionCountry, setInstitutionCountry] = useState('');
    const [institutionMarked, setInstitutionMarked] = useState<MarkedState>(null);
    const [programmeText, setProgrammeText] = useState('');
    const [programmeSelectedId, setProgrammeSelectedId] = useState<string | null>(null);
    const [programmeMarked, setProgrammeMarked] = useState<MarkedState>(null);
    const [entryYearText, setEntryYearText] = useState('');
    const [entryYearMarked, setEntryYearMarked] = useState<MarkedState>(null);
    const [suggestionDismissed, setSuggestionDismissed] = useState(false);
    const [entryRouteSel, setEntryRouteSel] = useState<EntryRoute | null>(null);
    const [entryRouteMarked, setEntryRouteMarked] = useState<MarkedState>(null);
    const [graduation, setGraduation] = useState<GraduationDraft>({ mode: 'pristine' });
    const [estimateUi, setEstimateUi] = useState<EstimateUiState>({ status: 'idle' });

    const dirty = dirtyFields.length > 0;

    // Refresh and tab-close bypass in-app navigation, so the browser's own
    // unload prompt guards the dirty draft on those paths. Programmatic
    // exits set the suppression flag first: they only run after a confirmed
    // save or discard, while React state may not have flushed yet.
    const suppressUnloadGuard = useRef(false);
    useEffect(() => {
        if (!dirty) return;
        // A failed programmatic exit can leave suppression set on a clean
        // form; the next edit re-arms the guard from scratch.
        suppressUnloadGuard.current = false;
        const guard = (event: BeforeUnloadEvent) => {
            if (suppressUnloadGuard.current) return;
            event.preventDefault();
        };
        window.addEventListener('beforeunload', guard);
        return () => window.removeEventListener('beforeunload', guard);
    }, [dirty]);

    // Browser Back/Forward runs as a client-side transition that skips
    // beforeunload, so a dirty draft pushes a guard entry and cancels the
    // traversal into the same save/discard/stay confirmation instead. The
    // entry is intentionally left behind: removing it would race the very
    // navigation the dialog confirms, and the leftover entry is a same-URL
    // no-op Back press once the draft is clean. Repeated clean/dirty cycles
    // can stack entries; confirmation then lands same-URL instead of one
    // page further back, but never loses a confirmed draft.
    const guardEntryPushed = useRef(false);
    useEffect(() => {
        if (!dirty) {
            guardEntryPushed.current = false;
            return;
        }
        // Pushed once per dirty transition: StrictMode remounts the effect
        // without a clean transition, and each extra entry would skew the
        // two-step replay further from the previous page.
        if (!guardEntryPushed.current) {
            guardEntryPushed.current = true;
            window.history.pushState({ awoofLeaveGuard: true }, '', window.location.href);
        }
        const onPopState = () => {
            window.history.pushState({ awoofLeaveGuard: true }, '', window.location.href);
            // A save already in flight owns the exit decision: opening a
            // second dialog now would be orphaned when the save resolves
            // and navigates. The traversal stays cancelled either way, so
            // Back pressed again after a failed save still confirms.
            if (leaveDialogOpenRef.current || savingRef.current) return;
            // Browser chrome triggered the dialog, so focus restores to
            // the Complete-later button on close.
            leaveTriggerRef.current = null;
            setPendingLeave({ kind: 'history' });
            setLeaveDialog(true);
        };
        window.addEventListener('popstate', onPopState);
        return () => window.removeEventListener('popstate', onPopState);
    }, [dirty]);
    const editableInstitution = view !== null && view.institution.binding !== 'server_bound';
    const institutionConfirmed = view?.institutionConfirmedGraduationYear ?? null;

    const markDirty = (field: AcademicField) => {
        setDirtyFields((previous) => (previous.includes(field) ? previous : [...previous, field]));
        // Further edits supersede the reconfirmation offer: the next save
        // carries the current draft instead.
        setClaimReconfirm(null);
        saveLeaveRef.current = null;
        // New edits also retire the post-save navigation retry: it would
        // otherwise bypass the leave guard and silently drop them. The
        // saved banner retires with it: the save confirmed the previous
        // snapshot, so it must not claim the dirty draft.
        setNavFailed(false);
        setSaveOutcome(null);
    };

    const resetDraft = (profile: AcademicProfileView) => {
        const savedInstitution = profile.fields.claimedInstitution;
        setInstitutionName(savedInstitution.state === 'supplied' ? savedInstitution.value.name : '');
        setInstitutionCountry(savedInstitution.state === 'supplied' ? savedInstitution.value.countryCode : '');
        setInstitutionMarked(savedInstitution.state === 'unknown' || savedInstitution.state === 'skipped' ? savedInstitution.state : null);
        const savedProgramme = profile.fields.programme;
        setProgrammeText(
            savedProgramme.state === 'supplied'
                ? savedProgramme.value.programmeId !== null
                    ? (profile.programmeLabel ?? savedProgramme.value.programmeId)
                    : savedProgramme.value.courseLabel
                : '',
        );
        setProgrammeSelectedId(savedProgramme.state === 'supplied' ? savedProgramme.value.programmeId : null);
        setProgrammeMarked(savedProgramme.state === 'unknown' || savedProgramme.state === 'skipped' ? savedProgramme.state : null);
        const savedEntryYear = profile.fields.entryYear;
        setEntryYearText(savedEntryYear.state === 'supplied' ? String(savedEntryYear.value) : '');
        setEntryYearMarked(savedEntryYear.state === 'unknown' || savedEntryYear.state === 'skipped' ? savedEntryYear.state : null);
        setSuggestionDismissed(false);
        const savedRoute = profile.fields.entryRoute;
        setEntryRouteSel(savedRoute.state === 'supplied' ? savedRoute.value : null);
        setEntryRouteMarked(savedRoute.state === 'unknown' || savedRoute.state === 'skipped' ? savedRoute.state : null);
        const savedGraduation = profile.fields.expectedGraduationYear;
        if (savedGraduation.state === 'supplied' && profile.fields.graduationYearOrigin === 'self_reported') {
            setGraduation({ mode: 'self', text: String(savedGraduation.value) });
        } else if (savedGraduation.state === 'unknown' || savedGraduation.state === 'skipped') {
            setGraduation({ mode: 'marked', state: savedGraduation.state });
        } else {
            setGraduation({ mode: 'pristine' });
        }
        setEstimateUi({ status: 'idle' });
        setDirtyFields([]);
        setFieldErrors({});
        setSaveError(null);
        setConflict(null);
        setClaimReconfirm(null);
        setSaveOutcome(null);
        setNavFailed(false);
        setLeaveDialog(false);
    };

    const loadProfile = async (announceRetry: boolean) => {
        const snapshot = getSessionSnapshot();
        setLoadState('loading');
        setLoadError('');
        try {
            const profile = await fetchAcademicProfile();
            if (!isCurrentSession(snapshot)) return;
            setView(profile);
            resetDraft(profile);
            setLoadState('ready');
            if (announceRetry) setAnnounce('Profile reloaded.');
        } catch (error: unknown) {
            if (!isCurrentSession(snapshot)) return;
            setLoadError(serverMessage(error) ?? 'We could not load your academic profile. Check your connection and try again.');
            setLoadState('error');
        }
    };

    useEffect(() => {
        let cancelled = false;
        const snapshot = getSessionSnapshot();
        fetchAcademicProfile().then((profile) => {
            if (cancelled || !isCurrentSession(snapshot)) return;
            setView(profile);
            resetDraft(profile);
            setLoadState('ready');
        }).catch((error: unknown) => {
            if (cancelled || !isCurrentSession(snapshot)) return;
            setLoadError(serverMessage(error) ?? 'We could not load your academic profile. Check your connection and try again.');
            setLoadState('error');
        });
        return () => { cancelled = true; };
        // Load once per logical session; the parent remounts on session change.
    }, []);

    const assuranceStatus = view?.assuranceState === 'available' ? view.assurance?.studentStatus ?? null : null;
    const mustVerify = assuranceStatus === 'expired' || assuranceStatus === 'denied' || assuranceStatus === 'revoked';
    const isVerified = assuranceStatus === 'verified';

    // No automatic redirect from the verification-blocked state: the
    // branch below offers the verification link while keeping profile
    // erasure reachable for students who may still have saved answers.

    const institutionSearch = useCatalogueSearch<InstitutionCatalogueItem>(
        searchAcademicInstitutions, institutionName, editableInstitution && view?.featureEnabled === true,
    );
    const programmeSearch = useCatalogueSearch<ProgrammeCatalogueItem>(
        searchAcademicProgrammes, programmeSelectedId ? '' : programmeText, view?.featureEnabled === true,
    );

    const savedProgrammeId = view?.fields.programme.state === 'supplied' ? view.fields.programme.value.programmeId : null;
    const savedEntryYear = view?.fields.entryYear.state === 'supplied' ? view.fields.entryYear.value : null;

    const programmeInputsDirty = dirtyFields.includes('programme');
    const entryYearInputsDirty = dirtyFields.includes('entryYear');
    const entryRouteInputsDirty = dirtyFields.includes('entryRoute');
    // The draft claim scopes unbound estimates exactly as the save narrows
    // by the merged claim, so a changed or cleared claim invalidates a
    // displayed or accepted estimate like any other estimate input.
    const claimInputsDirty = dirtyFields.includes('claimedInstitution');
    const estimateInputsPristine = !programmeInputsDirty && !entryYearInputsDirty && !entryRouteInputsDirty && !claimInputsDirty;

    const effectiveProgrammeId = programmeMarked !== null
        ? null
        : programmeSelectedId ?? (programmeInputsDirty ? null : savedProgrammeId);
    const parsedEntryYearText = /^\d{4}$/.test(entryYearText.trim()) ? Number(entryYearText.trim()) : null;
    const effectiveEntryYear = entryYearMarked !== null
        ? null
        : (entryYearInputsDirty ? parsedEntryYearText : (savedEntryYear ?? parsedEntryYearText));
    const effectiveEntryRoute = entryRouteMarked !== null ? null : entryRouteSel;

    const calculatedStale = view !== null
        && institutionConfirmed === null
        && view.fields.expectedGraduationYear.state === 'supplied'
        && view.fields.graduationYearOrigin === 'calculated'
        && graduation.mode === 'pristine'
        && (view.fields.estimateStale || !estimateInputsPristine);

    const showSuggestion = view?.entryYearSuggestion?.state === 'suggested'
        && !suggestionDismissed
        && view.fields.entryYear.state !== 'supplied'
        && entryYearMarked === null;

    const handleInputsChanged = () => {
        // Invalidate any in-flight estimate so a late response for the
        // previous inputs cannot overwrite the reset UI or accepted state.
        estimateRequestId.current += 1;
        setEstimateUi({ status: 'idle' });
        if (graduation.mode === 'accept') {
            setGraduation({ mode: 'pristine' });
            setDirtyFields((fields) => fields.filter((field) => field !== 'expectedGraduationYear'));
            setAnnounce('Your inputs changed, so the accepted estimate was cleared. Confirm a new year below.');
        }
    };

    const toggleMark = (
        field: AcademicField,
        current: MarkedState,
        setMarked: (marked: MarkedState) => void,
        clear: () => void,
        state: 'unknown' | 'skipped',
    ) => {
        markDirty(field);
        handleInputsChangedIfNeeded(field);
        if (current === state) {
            setMarked(null);
        } else {
            setMarked(state);
            clear();
        }
    };

    const handleInputsChangedIfNeeded = (field: AcademicField) => {
        if (field === 'programme' || field === 'entryYear' || field === 'entryRoute' || field === 'claimedInstitution') handleInputsChanged();
    };

    const validateAndBuild = (): { form: AcademicProfileForm } | { errors: Record<string, string> } => {
        const errors: Record<string, string> = {};
        const year = currentYear();
        const form: AcademicProfileForm = {
            claimedInstitution: { state: 'unchanged' },
            programme: { state: 'unchanged' },
            entryYear: { state: 'unchanged' },
            entryRoute: { state: 'unchanged' },
            expectedGraduationYear: { state: 'unchanged' },
        };
        if (editableInstitution && dirtyFields.includes('claimedInstitution')) {
            if (institutionMarked !== null) {
                form.claimedInstitution = { state: institutionMarked };
            } else if (institutionName.trim() === '' && institutionCountry.trim() === '') {
                form.claimedInstitution = { state: 'unanswered' };
            } else if (institutionName.trim() === '' || !/^[A-Za-z]{2}$/.test(institutionCountry.trim())) {
                errors.institution = 'Enter the institution name and its 2-letter country code, or choose Not sure or Skip this detail.';
            } else if (institutionName.trim().length > FREE_TEXT_MAX_LENGTH) {
                errors.institution = `Keep the institution name to ${FREE_TEXT_MAX_LENGTH} characters or fewer, or choose Not sure or Skip this detail.`;
            } else {
                form.claimedInstitution = {
                    state: 'supplied',
                    value: { name: institutionName.trim(), countryCode: institutionCountry.trim().toUpperCase() },
                };
            }
        }
        if (dirtyFields.includes('programme')) {
            if (programmeMarked !== null) {
                form.programme = { state: programmeMarked };
            } else if (programmeText.trim() === '') {
                form.programme = { state: 'unanswered' };
            } else if (programmeSelectedId !== null) {
                form.programme = { state: 'supplied', value: { programmeId: programmeSelectedId, courseLabel: null } };
            } else if (programmeText.trim().length > FREE_TEXT_MAX_LENGTH) {
                errors.programme = `Keep the course name to ${FREE_TEXT_MAX_LENGTH} characters or fewer, or choose Not sure or Skip this detail.`;
            } else {
                form.programme = { state: 'supplied', value: { programmeId: null, courseLabel: programmeText.trim() } };
            }
        }
        let confirmedEntryYear: number | null = savedEntryYear;
        if (dirtyFields.includes('entryYear')) {
            if (entryYearMarked !== null) {
                form.entryYear = { state: entryYearMarked };
                confirmedEntryYear = null;
            } else if (entryYearText.trim() === '') {
                form.entryYear = { state: 'unanswered' };
                confirmedEntryYear = null;
            } else {
                const parsed = /^\d+$/.test(entryYearText.trim()) ? Number(entryYearText.trim()) : NaN;
                if (!Number.isInteger(parsed) || parsed < 1900 || parsed > year) {
                    errors.entryYear = `Enter a 4-digit entry year between 1900 and ${year}, or choose Not sure or Skip this detail.`;
                } else {
                    form.entryYear = { state: 'supplied', value: parsed };
                    confirmedEntryYear = parsed;
                }
            }
        } else if (entryYearMarked !== null) {
            confirmedEntryYear = null;
        }
        if (dirtyFields.includes('entryRoute')) {
            if (entryRouteMarked !== null) {
                form.entryRoute = { state: entryRouteMarked };
            } else if (entryRouteSel === null) {
                form.entryRoute = { state: 'unanswered' };
            } else {
                form.entryRoute = { state: 'supplied', value: entryRouteSel };
            }
        }
        if (institutionConfirmed === null && dirtyFields.includes('expectedGraduationYear')) {
            if (graduation.mode === 'marked') {
                form.expectedGraduationYear = { state: graduation.state };
            } else if (graduation.mode === 'accept') {
                form.expectedGraduationYear = { state: 'supplied', value: { kind: 'accept_estimate', year: graduation.year } };
            } else if (graduation.mode === 'self') {
                if (graduation.text.trim() === '') {
                    form.expectedGraduationYear = { state: 'unanswered' };
                } else {
                    const parsed = /^\d+$/.test(graduation.text.trim()) ? Number(graduation.text.trim()) : NaN;
                    // Mirror the server's self-reported bounds exactly: the
                    // entry year when one is confirmed, else the 1900 floor.
                    const graduationFloor = confirmedEntryYear ?? 1900;
                    if (!Number.isInteger(parsed) || parsed < graduationFloor || parsed > year + 20) {
                        errors.graduation = `Enter an expected year between ${graduationFloor} and ${year + 20}, or choose Not sure or Skip this detail.`;
                    } else {
                        form.expectedGraduationYear = { state: 'supplied', value: { kind: 'self_reported', year: parsed } };
                    }
                }
            } else {
                // Pristine keeps the saved value; an invalidated accept is
                // already removed from the dirty set by handleInputsChanged.
                form.expectedGraduationYear = { state: 'unchanged' };
            }
        }
        if (Object.keys(errors).length > 0) return { errors };
        return { form };
    };

    const navigateToExit = () => {
        // Every exit below runs after a confirmed save or an explicit
        // no-change continuation, so it must never trip the unload guard:
        // React state may not have flushed the dirty reset yet.
        suppressUnloadGuard.current = true;
        try {
            // Fault-injection seam for browser tests; no production caller sets it.
            const hook = window as Window & { __awoofFailNextExitNavigation?: boolean };
            if (hook.__awoofFailNextExitNavigation === true) {
                hook.__awoofFailNextExitNavigation = false;
                throw new Error('Exit navigation failed');
            }
            window.location.assign(exitDestination());
        } catch {
            setNavFailed(true);
            setAnnounce('Profile saved. We could not take you to the next page.');
        }
    };

    const saveDraft = async (): Promise<'saved' | 'invalid' | 'failed' | 'claim-offer'> => {
        if (!view) return 'failed';
        const validated = validateAndBuild();
        if ('errors' in validated) {
            setFieldErrors(validated.errors);
            setAnnounce('Check the highlighted fields before saving.');
            return 'invalid';
        }
        const patch: AcademicProfileInput = buildAcademicProfilePatch(validated.form, view.revision, view.institution);
        const snapshot = getSessionSnapshot();
        setSaving(true);
        setSaveError(null);
        setConflict(null);
        setClaimReconfirm(null);
        saveLeaveRef.current = null;
        try {
            const committed = await saveAcademicProfile(patch);
            if (!isCurrentSession(snapshot)) return 'failed';
            setView(committed);
            resetDraft(committed);
            setSaveOutcome('saved');
            setAnnounce('Profile saved.');
            return 'saved';
        } catch (error: unknown) {
            if (!isCurrentSession(snapshot)) return 'failed';
            if (axios.isAxiosError(error) && error.response) {
                if (error.response.status === 409) {
                    const drift = parseInstitutionChangedConflict(error);
                    if (drift) {
                        // No transparent retry: the draft was
                        // entered under the former school, so
                        // silently resubmitting it under the
                        // replacement school would skip the
                        // reconfirmation the invalidation exists to
                        // force. Load the new projection, keep the
                        // draft for review, and require an explicit
                        // re-save.
                        try {
                            const fresh = await fetchAcademicProfile();
                            if (!isCurrentSession(snapshot)) return 'failed';
                            setView(fresh);
                            // The invalidation wiped the stored answers, so
                            // every retained draft value must join the
                            // reconfirmation patch: resubmitting only the
                            // originally dirty fields would leave the visible
                            // retained answers blank and lose them on commit.
                            // Retained content is server-valid (loaded) or
                            // already dirty (typed), and untouched empties
                            // resubmit as explicit unanswered no-ops, so
                            // promotion cannot introduce validation errors
                            // of its own.
                            setDirtyFields((previous) => {
                                const fields: AcademicField[] = ['claimedInstitution', 'programme', 'entryYear', 'entryRoute', 'expectedGraduationYear'];
                                return [...previous, ...fields.filter((field) => !previous.includes(field))];
                            });
                            setSaveOutcome(null);
                            setNavFailed(false);
                            const school = fresh.institution.binding === 'server_bound' && fresh.institution.displayName !== null
                                ? ` to ${fresh.institution.displayName}` : '';
                            setConflict(`Your school changed${school}. Review your answers below and save again to confirm them.`);
                            setAnnounce('Your school changed. Review your answers and save again to confirm them.');
                            return 'failed';
                        } catch {
                            if (!isCurrentSession(snapshot)) return 'failed';
                            setConflict('Your profile changed since it was read. Reload the latest values before saving again.');
                            return 'failed';
                        }
                    }
                    const claimChange = parseClaimChangedConflict(error);
                    if (claimChange) {
                        // Nothing was written: offer to resubmit the
                        // saved answers under the attempted claim
                        // instead of discarding the draft on reload.
                        const request = claimReconfirmRequest(patch);
                        if (!request) {
                            setConflict('Your profile changed since it was read. Reload the latest values before saving again.');
                            return 'failed';
                        }
                        setClaimReconfirm(request);
                        setAnnounce('Your school changed. Confirm your saved answers to keep them.');
                        return 'claim-offer';
                    }
                    setConflict('Your profile changed since it was read. Reload the latest values before saving again.');
                    return 'failed';
                }
                setSaveError(serverMessage(error) ?? 'We could not save your profile. Check your answers and try again.');
                return 'failed';
            }
            // A lost response is an unknown outcome: read back before retrying.
            try {
                const fresh = await fetchAcademicProfile();
                if (!isCurrentSession(snapshot)) return 'failed';
                if (patchMatchesProjection(patch, fresh)) {
                    setView(fresh);
                    resetDraft(fresh);
                    setSaveOutcome('saved');
                    setAnnounce('Profile saved.');
                    return 'saved';
                }
                setConflict('We could not confirm your save because the profile changed. Reload the latest values before trying again.');
                return 'failed';
            } catch {
                if (!isCurrentSession(snapshot)) return 'failed';
                setSaveError('We could not confirm whether your changes were saved. Check your connection, then reload and try again.');
                setConflict('We could not confirm whether your changes were saved. Reload the latest values before trying again.');
                return 'failed';
            }
        } finally {
            if (isCurrentSession(snapshot)) setSaving(false);
        }
    };

    const handleClaimReconfirm = async () => {
        if (!view || !claimReconfirm || saving) return;
        // Rebuild from the current draft (claim edits after the conflict
        // clear this offer via markDirty) and restate the saved supplied
        // answers the claim change requires.
        const validated = validateAndBuild();
        if ('errors' in validated) {
            setFieldErrors(validated.errors);
            setAnnounce('Check the highlighted fields before saving.');
            return;
        }
        const patch = buildClaimReconfirmPatch(buildAcademicProfilePatch(validated.form, view.revision, view.institution), view);
        const snapshot = getSessionSnapshot();
        setSaving(true);
        setSaveError(null);
        try {
            const committed = await saveAcademicProfile(patch);
            if (!isCurrentSession(snapshot)) return;
            setView(committed);
            resetDraft(committed);
            setSaveOutcome('saved');
            setAnnounce('Profile saved under the new school.');
            navigateAfterReconfirm();
        } catch (error: unknown) {
            if (!isCurrentSession(snapshot)) return;
            setClaimReconfirm(null);
            if (axios.isAxiosError(error) && error.response) {
                // The draft is intact: a revision race falls back to the reload
                // path, while a rejection (for example an estimate the new
                // school cannot support) surfaces the server message for edits.
                saveLeaveRef.current = null;
                if (error.response.status === 409) {
                    setConflict('Your profile changed since it was read. Reload the latest values before saving again.');
                    return;
                }
                setSaveError(serverMessage(error) ?? 'We could not save your profile. Check your answers and try again.');
                return;
            }
            // A lost response is an unknown outcome: the reconfirmation may
            // have committed, so read back before presenting a failure, like
            // saveDraft. Without this, a retry 409s on the committed claim
            // and forces a needless reload. The stashed leave survives the
            // readback: a reconciled save still completes the original
            // leave, and only a confirmed mismatch abandons it.
            try {
                const fresh = await fetchAcademicProfile();
                if (!isCurrentSession(snapshot)) return;
                if (patchMatchesProjection(patch, fresh)) {
                    setView(fresh);
                    resetDraft(fresh);
                    setSaveOutcome('saved');
                    setAnnounce('Profile saved under the new school.');
                    navigateAfterReconfirm();
                    return;
                }
                saveLeaveRef.current = null;
                setConflict('We could not confirm your save because the profile changed. Reload the latest values before trying again.');
            } catch {
                if (!isCurrentSession(snapshot)) return;
                saveLeaveRef.current = null;
                setSaveError('We could not confirm whether your changes were saved. Check your connection, then reload and try again.');
                setConflict('We could not confirm whether your changes were saved. Reload the latest values before trying again.');
            }
        } finally {
            if (isCurrentSession(snapshot)) setSaving(false);
        }
    };

    const handleSaveAndContinue = async () => {
        if (!dirty) {
            navigateToExit();
            return;
        }
        const outcome = await saveDraft();
        if (outcome === 'saved') navigateToExit();
    };

    const writeCompleteLaterDeferral = () => {
        // The marker only suppresses prompts, and prompts never fire
        // while collection is disabled or the record is read-only — so a
        // Complete-later click in those states must not write storage.
        if (view?.featureEnabled !== true || view?.writeAvailable !== true) return;
        // The captured session fences the write: a late write from an
        // obsolete session removes only its own key and never suppresses
        // another login. Navigation proceeds regardless.
        const accountId = currentUser?.id ?? null;
        if (!accountId) return;
        writeDeferral(deferralStorage(), getSessionSnapshot(), accountId);
    };

    const navigateToPendingLeave = (pending: PendingLeave) => {
        // A confirmed leave must never trip the unload guard: the draft
        // was saved or explicitly discarded to reach this point, while
        // React state may not have flushed yet. The next edit re-arms.
        suppressUnloadGuard.current = true;
        if (pending.kind === 'history') {
            // The stack holds [previous, page, guard entry]: stepping back
            // twice replays the Back traversal the dialog interrupted.
            window.history.go(-2);
            return;
        }
        if (pending.href === null) {
            navigateToExit();
            return;
        }
        window.location.assign(pending.href);
    };

    const navigateAfterReconfirm = () => {
        // A reconfirmed dialog-save completes the stashed leave
        // (deferral included); a reconfirmed main save exits normally.
        const pending = saveLeaveRef.current;
        saveLeaveRef.current = null;
        setClaimReconfirm(null);
        if (pending) {
            if (pending.kind === 'exit' && pending.defer) writeCompleteLaterDeferral();
            navigateToPendingLeave(pending);
            return;
        }
        navigateToExit();
    };

    const requestLeave = (href: string | null, defer: boolean) => {
        // A save already in flight owns the exit decision: opening the
        // dialog now would let Discard navigate while the submitted
        // request can still commit, so leave actions wait for it.
        if (saving) return;
        if (!dirty) {
            if (defer) writeCompleteLaterDeferral();
            navigateToPendingLeave({ kind: 'exit', href, defer });
            return;
        }
        leaveTriggerRef.current = document.activeElement instanceof HTMLElement ? document.activeElement : null;
        setPendingLeave({ kind: 'exit', href, defer });
        setLeaveDialog(true);
    };

    const handleCompleteLater = () => {
        requestLeave(null, true);
    };

    const handleEraseProfile = async () => {
        const snapshot = getSessionSnapshot();
        setEraseState('erasing');
        setEraseError(null);
        try {
            const result = await eraseAcademicProfile();
            if (!isCurrentSession(snapshot)) return;
            setEraseState(result.erased ? 'erased' : 'noop');
            setAnnounce(result.erased
                ? 'Your academic profile was erased.'
                : 'No academic profile was saved, so there was nothing to erase.');
            await loadProfile(false);
        } catch (error: unknown) {
            if (!isCurrentSession(snapshot)) return;
            setEraseState('confirming');
            setEraseError(serverMessage(error) ?? 'We could not erase your academic profile. Please try again.');
        }
    };

    const renderEraseSection = () => (
        <section aria-label="Erase your academic profile" className="mt-6 rounded-2xl border border-slate-200 bg-white p-4">
            <h2 className="text-lg font-semibold text-slate-900">Erase your academic profile</h2>
            {eraseState === 'erased' ? (
                <p className="mt-2 text-sm text-slate-700">
                    Your saved academic details have been erased. Your student account stays active and you can keep browsing.
                </p>
            ) : eraseState === 'noop' ? (
                <p className="mt-2 text-sm text-slate-700">
                    No academic profile was saved, so there was nothing to erase. Your student account stays active and you can keep browsing.
                </p>
            ) : (
                <>
                    <p className="mt-2 text-sm text-slate-600">
                        This deletes the academic details you saved here from your live profile. Copies already
                        captured in routine backups stay under the backup retention policy - which may keep the
                        newest backup as a last-resort recovery copy - and are never restored into service.
                        Your student account, verification, and marketplace access are not affected.
                    </p>
                    {eraseError && (
                        <p role="alert" className="mt-3 rounded-lg border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-800">{eraseError}</p>
                    )}
                    {eraseState === 'confirming' || eraseState === 'erasing' ? (
                        <div className="mt-4 flex flex-col gap-3 sm:flex-row">
                            <button
                                type="button"
                                onClick={handleEraseProfile}
                                disabled={eraseState === 'erasing' || saving}
                                className="inline-flex min-h-[44px] items-center justify-center rounded-full bg-red-600 px-5 text-sm font-bold text-white hover:bg-red-700 disabled:opacity-50"
                            >
                                {eraseState === 'erasing' ? 'Erasing…' : 'Confirm erasure'}
                            </button>
                            <button
                                type="button"
                                onClick={() => { setEraseState('idle'); setEraseError(null); }}
                                disabled={eraseState === 'erasing'}
                                className="inline-flex min-h-[44px] items-center justify-center rounded-full border border-slate-300 px-5 text-sm font-bold text-slate-700 hover:bg-slate-50 disabled:opacity-50"
                            >
                                Cancel
                            </button>
                        </div>
                    ) : (
                        <button
                            type="button"
                            onClick={() => { setEraseState('confirming'); setEraseError(null); }}
                            disabled={saving}
                            className="mt-4 inline-flex min-h-[44px] items-center justify-center rounded-full border border-red-300 px-5 text-sm font-bold text-red-700 hover:bg-red-50 disabled:opacity-50"
                        >
                            Erase my academic profile
                        </button>
                    )}
                </>
            )}
        </section>
    );

    const handleGetEstimate = async () => {
        const programmeAnswered = programmeMarked === null && programmeText.trim() !== '';
        const entryYearAnswered = entryYearMarked === null && parsedEntryYearText !== null;
        const entryRouteAnswered = entryRouteMarked === null && entryRouteSel !== null;
        if (!programmeAnswered || !entryYearAnswered || !entryRouteAnswered) {
            setEstimateUi({ status: 'ready', result: { state: 'unavailable', reason: 'missing_input' } });
            return;
        }
        // A free-text course is answered but has no catalogue rule, so the
        // server could only return missing_input for its null ID. Say so
        // locally instead of asking the student to add fields they completed.
        if (effectiveProgrammeId === null) {
            setEstimateUi({ status: 'ready', result: { state: 'unavailable', reason: 'unknown_programme' } });
            setAnnounce('No estimate is available. You can still enter your expected year.');
            return;
        }
        // Scope the preview by the draft claim exactly as the save narrows by
        // the merged claim: a supplied draft sends its country, a removed or
        // marked draft sends explicit null (unconstrained), and an untouched
        // draft omits the field so the server falls back to the stored claim.
        const draftClaimCountry = draftClaimScopeForEstimate({
            dirty: editableInstitution && dirtyFields.includes('claimedInstitution'),
            marked: institutionMarked,
            name: institutionName,
            country: institutionCountry,
        });
        const snapshot = getSessionSnapshot();
        const requestId = ++estimateRequestId.current;
        setEstimateUi({ status: 'loading' });
        try {
            const result = await requestGraduationEstimate({
                programmeId: effectiveProgrammeId,
                entryYear: effectiveEntryYear,
                entryRoute: effectiveEntryRoute,
                ...(draftClaimCountry === undefined ? {} : { claimedCountryCode: draftClaimCountry }),
            });
            if (!isCurrentSession(snapshot) || requestId !== estimateRequestId.current) return;
            setEstimateUi({ status: 'ready', result });
            setAnnounce(result.state === 'available'
                ? `Estimated graduation year ${result.year}.`
                : 'No estimate is available. You can still enter your expected year.');
        } catch {
            if (!isCurrentSession(snapshot) || requestId !== estimateRequestId.current) return;
            setEstimateUi({ status: 'error' });
        }
    };

    const handleReload = async () => {
        const snapshot = getSessionSnapshot();
        setSaving(true);
        try {
            const fresh = await fetchAcademicProfile();
            if (!isCurrentSession(snapshot)) return;
            setView(fresh);
            resetDraft(fresh);
            setAnnounce('Profile reloaded.');
        } catch {
            if (!isCurrentSession(snapshot)) return;
            setSaveError('We could not reload your profile. Check your connection and try again.');
        } finally {
            if (isCurrentSession(snapshot)) setSaving(false);
        }
    };

    const { user } = useAuth();
    const greeting = academicProfileGreeting(user ?? null);

    if (loadState === 'loading') {
        return (
            <Shell>
                <p role="status" className="text-slate-600">Loading your academic profile…</p>
            </Shell>
        );
    }

    if (loadState === 'error' || !view) {
        return (
            <Shell>
                <h1 className="text-2xl font-bold text-slate-900">{greeting}</h1>
                <p className="mt-1 text-slate-600">Complete your student profile</p>
                <p role="alert" className="mt-4 rounded-lg border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-800">{loadError}</p>
                <button
                    type="button"
                    onClick={() => void loadProfile(true)}
                    className="mt-4 inline-flex min-h-[44px] items-center rounded-full bg-[#1D4ED8] px-5 text-sm font-bold text-white hover:bg-[#1E40AF]"
                >
                    Retry
                </button>
            </Shell>
        );
    }

    if (mustVerify) {
        return (
            <Shell>
                <h1 className="text-2xl font-bold text-slate-900">{greeting}</h1>
                <p className="mt-2 text-slate-600">Your verification needs attention before you continue.</p>
                <Link href="/student/verification" className="mt-4 inline-flex min-h-[44px] items-center rounded-full bg-[#1D4ED8] px-5 text-sm font-bold text-white hover:bg-[#1E40AF]">
                    Continue verification
                </Link>
                {renderEraseSection()}
            </Shell>
        );
    }

    if (!view.featureEnabled || !view.writeAvailable) {
        const saved = view.fields;
        // Marker answers are persisted choices too: a rollback view that
        // only counts supplied values would misreport skipped/unknown
        // profiles as never answered.
        const hasSaved = saved.claimedInstitution.state !== 'unanswered'
            || saved.programme.state !== 'unanswered'
            || saved.entryYear.state !== 'unanswered'
            || saved.entryRoute.state !== 'unanswered'
            || saved.expectedGraduationYear.state !== 'unanswered';
        const markerLabel = (state: ProfileFieldState): string | null => (
            state === 'unknown' ? 'Not sure' : state === 'skipped' ? 'Skipped' : null
        );
        return (
            <Shell>
                <h1 className="text-2xl font-bold text-slate-900">{greeting}</h1>
                <p className="mt-1 font-semibold text-slate-900">Complete your student profile</p>
                <p className="mt-2 text-slate-600">
                    {!view.featureEnabled
                        ? 'Academic profile collection is not currently available. Your account is unaffected, and you can keep browsing.'
                        : 'Your student record is not active, so your saved answers are read-only for now. Contact support if this is unexpected.'}
                </p>
                {view.assurance ? (
                    <dl className="mt-3 space-y-1 text-sm text-slate-700">
                        <div className="flex flex-wrap gap-x-1.5"><dt className="font-semibold">School account:</dt><dd>{schoolAccountLabel(view.assurance)}</dd></div>
                        <div className="flex flex-wrap gap-x-1.5"><dt className="font-semibold">Student status:</dt><dd>{studentStatusLabel(view.assurance)}</dd></div>
                    </dl>
                ) : (
                    <p className="mt-3 text-sm text-slate-600">Verification status is temporarily unavailable.</p>
                )}
                <section aria-label="Saved answers" className="mt-6 rounded-2xl border border-slate-200 bg-white p-4">
                    <h2 className="text-lg font-semibold text-slate-900">Your saved answers</h2>
                    {hasSaved ? (
                        <dl className="mt-2 space-y-1 text-sm text-slate-700">
                            {saved.claimedInstitution.state === 'supplied' && (
                                <div className="flex flex-wrap gap-x-1.5"><dt className="font-semibold">Institution:</dt><dd>{saved.claimedInstitution.value.name} ({saved.claimedInstitution.value.countryCode})</dd></div>
                            )}
                            {markerLabel(saved.claimedInstitution.state) !== null && (
                                <div className="flex flex-wrap gap-x-1.5"><dt className="font-semibold">Institution:</dt><dd>{markerLabel(saved.claimedInstitution.state)}</dd></div>
                            )}
                            {saved.programme.state === 'supplied' && (
                                <div className="flex flex-wrap gap-x-1.5"><dt className="font-semibold">Programme or course:</dt><dd>{saved.programme.value.programmeId === null ? saved.programme.value.courseLabel : (view.programmeLabel ?? saved.programme.value.programmeId)}</dd></div>
                            )}
                            {markerLabel(saved.programme.state) !== null && (
                                <div className="flex flex-wrap gap-x-1.5"><dt className="font-semibold">Programme or course:</dt><dd>{markerLabel(saved.programme.state)}</dd></div>
                            )}
                            {saved.entryYear.state === 'supplied' && (
                                <div className="flex flex-wrap gap-x-1.5"><dt className="font-semibold">Entry year:</dt><dd>{saved.entryYear.value}</dd></div>
                            )}
                            {markerLabel(saved.entryYear.state) !== null && (
                                <div className="flex flex-wrap gap-x-1.5"><dt className="font-semibold">Entry year:</dt><dd>{markerLabel(saved.entryYear.state)}</dd></div>
                            )}
                            {saved.entryRoute.state === 'supplied' && (
                                <div className="flex flex-wrap gap-x-1.5"><dt className="font-semibold">Entry route:</dt><dd>{entryRouteLabel(saved.entryRoute.value)}</dd></div>
                            )}
                            {markerLabel(saved.entryRoute.state) !== null && (
                                <div className="flex flex-wrap gap-x-1.5"><dt className="font-semibold">Entry route:</dt><dd>{markerLabel(saved.entryRoute.state)}</dd></div>
                            )}
                            {saved.expectedGraduationYear.state === 'supplied' && (
                                <div className="flex flex-wrap gap-x-1.5"><dt className="font-semibold">Expected graduation year:</dt><dd>{saved.expectedGraduationYear.value}</dd></div>
                            )}
                            {markerLabel(saved.expectedGraduationYear.state) !== null && (
                                <div className="flex flex-wrap gap-x-1.5"><dt className="font-semibold">Expected graduation year:</dt><dd>{markerLabel(saved.expectedGraduationYear.state)}</dd></div>
                            )}
                        </dl>
                    ) : (
                        <p className="mt-2 text-sm text-slate-600">No academic details saved yet.</p>
                    )}
                </section>
                {/* Always render: after a failed post-commit erase the reload
                    shows no saved profile, but DELETE still republishes the
                    committed ledger outbox record. */}
                {renderEraseSection()}
                <button
                    type="button"
                    onClick={handleCompleteLater}
                    className="mt-6 inline-flex min-h-[44px] items-center rounded-full border border-slate-300 px-5 text-sm font-bold text-slate-700 hover:bg-slate-50"
                >
                    Complete later
                </button>
            </Shell>
        );
    }

    const missingFields = view.optionalUnansweredFields;
    const savedGraduation = view.fields.expectedGraduationYear;
    const suggestion = view.entryYearSuggestion;
    const projectionEstimate = estimateInputsPristine
        && graduation.mode === 'pristine'
        && savedGraduation.state !== 'supplied'
        ? view.estimate
        : null;
    const errorSummary: Array<{ key: string; anchor: string; message: string }> = [];
    if (fieldErrors.institution) errorSummary.push({ key: 'institution', anchor: FIELD_ANCHORS.claimedInstitution, message: fieldErrors.institution });
    if (fieldErrors.programme) errorSummary.push({ key: 'programme', anchor: FIELD_ANCHORS.programme, message: fieldErrors.programme });
    if (fieldErrors.entryYear) errorSummary.push({ key: 'entryYear', anchor: FIELD_ANCHORS.entryYear, message: fieldErrors.entryYear });
    if (fieldErrors.graduation) errorSummary.push({ key: 'graduation', anchor: FIELD_ANCHORS.expectedGraduationYear, message: fieldErrors.graduation });

    const applyEstimate = (year: number) => {
        setGraduation({ mode: 'accept', year });
        markDirty('expectedGraduationYear');
        setEstimateUi({ status: 'idle' });
        setAnnounce(`Estimated year ${year} selected. Save to confirm it.`);
    };
    const enterDifferentYear = () => {
        setGraduation({ mode: 'self', text: savedGraduation.state === 'supplied' && view.fields.graduationYearOrigin === 'self_reported' ? String(savedGraduation.value) : '' });
    };

    return (
        <Shell onRequestLeave={(href) => requestLeave(href, false)}>
            <h1 className="text-2xl font-bold text-slate-900">{greeting}</h1>
            <p className="mt-1 font-semibold text-slate-900">{isVerified ? 'Add optional academic details' : 'Complete your student profile'}</p>
            <p className="mt-2 text-slate-600">
                These details help you review your academic profile and an estimated graduation year. They do not verify your enrollment.
            </p>
            {view.assurance ? (
                <dl className="mt-3 space-y-1 text-sm text-slate-700">
                    <div className="flex flex-wrap gap-x-1.5"><dt className="font-semibold">School account:</dt><dd>{schoolAccountLabel(view.assurance)}</dd></div>
                    <div className="flex flex-wrap gap-x-1.5"><dt className="font-semibold">Student status:</dt><dd>{studentStatusLabel(view.assurance)}</dd></div>
                </dl>
            ) : (
                <p className="mt-3 text-sm text-slate-600">Verification status is temporarily unavailable.</p>
            )}
            {view.verificationContinuationAvailable ? (
                <Link
                    href="/student/verification"
                    onClick={(event) => {
                        if (!shouldInterceptLinkClick(event)) return;
                        event.preventDefault();
                        requestLeave('/student/verification', false);
                    }}
                    className="mt-3 inline-flex min-h-[44px] items-center font-semibold text-[#1D4ED8] underline"
                >
                    Continue verification
                </Link>
            ) : assuranceStatus === 'pending' ? (
                <p className="mt-3 text-sm text-slate-600">
                    We haven&apos;t enabled verification for this institution yet. You can save your profile and browse; eligibility is decided by the existing verification journey.
                </p>
            ) : null}

            <p role="status" aria-live="polite" className="sr-only">{announce}</p>
            {saveOutcome === 'saved' && <p role="status" className="mt-4 rounded-lg border border-emerald-200 bg-emerald-50 px-4 py-3 text-sm font-semibold text-emerald-900">Profile saved</p>}
            {saveError && <p role="alert" className="mt-4 rounded-lg border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-800">{saveError}</p>}
            {conflict && (
                <div role="alert" className="mt-4 rounded-lg border border-amber-200 bg-amber-50 px-4 py-3 text-sm text-amber-900">
                    <p>{conflict}</p>
                    <button
                        type="button"
                        onClick={() => void handleReload()}
                        disabled={saving}
                        className="mt-2 inline-flex min-h-[44px] items-center font-semibold underline disabled:opacity-50"
                    >
                        Reload profile
                    </button>
                </div>
            )}
            {claimReconfirm && (
                <div role="alert" className="mt-4 rounded-lg border border-amber-200 bg-amber-50 px-4 py-3 text-sm text-amber-900">
                    <p>
                        {claimReconfirm.kind === 'supplied'
                            ? `Your school changed to ${claimReconfirm.schoolName}. Resubmit your saved answers under the new school?`
                            : claimReconfirm.kind === 'cleared'
                                ? 'You removed your school. Resubmit your saved answers without a school?'
                                : `You marked your school as ${claimReconfirm.marker === 'unknown' ? 'Not sure' : 'Skipped'}. Resubmit your saved answers without a confirmed school?`}
                        {' '}Nothing was saved yet.
                    </p>
                    <div className="mt-2 flex flex-wrap gap-2">
                        <button
                            type="button"
                            onClick={() => void handleClaimReconfirm()}
                            disabled={saving}
                            className="inline-flex min-h-[44px] items-center rounded-full bg-[#1D4ED8] px-5 text-sm font-bold text-white hover:bg-[#1E40AF] disabled:opacity-50"
                        >
                            Reconfirm saved answers
                        </button>
                        <button
                            type="button"
                            onClick={() => setClaimReconfirm(null)}
                            disabled={saving}
                            className="inline-flex min-h-[44px] items-center rounded-full border border-slate-300 px-5 text-sm font-bold text-slate-700 hover:bg-slate-50 disabled:opacity-50"
                        >
                            Keep editing
                        </button>
                    </div>
                </div>
            )}
            {navFailed && (
                <div role="alert" className="mt-4 rounded-lg border border-amber-200 bg-amber-50 px-4 py-3 text-sm text-amber-900">
                    <p className="font-semibold">Profile saved</p>
                    <p className="mt-1">We couldn&apos;t take you to the next page.</p>
                    {view.assurance && <p className="mt-1">Student status: {studentStatusLabel(view.assurance)}</p>}
                    <button
                        type="button"
                        onClick={navigateToExit}
                        className="mt-2 inline-flex min-h-[44px] items-center font-semibold underline"
                    >
                        Try again
                    </button>
                </div>
            )}
            {errorSummary.length > 0 && (
                <div role="alert" className="mt-4 rounded-lg border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-800">
                    <p className="font-semibold">Check the highlighted fields before saving.</p>
                    <ul className="mt-1 list-disc pl-5">
                        {errorSummary.map((entry) => (
                            <li key={entry.key}><a href={`#${entry.anchor}`} className="underline">{entry.message}</a></li>
                        ))}
                    </ul>
                </div>
            )}

            {missingFields.length > 0 ? (
                <section aria-label="Missing details" className="mt-6 rounded-2xl border border-slate-200 bg-white p-4">
                    <h2 className="text-base font-semibold text-slate-900">Still to add</h2>
                    <ul className="mt-2 flex flex-wrap gap-2">
                        {missingFields.map((field) => (
                            <li key={field}>
                                <a href={`#${FIELD_ANCHORS[field]}`} className="inline-flex min-h-[44px] items-center rounded-full bg-[#EEF2FF] px-4 text-sm font-semibold text-[#1D4ED8]">
                                    {FIELD_LABELS[field]}
                                </a>
                            </li>
                        ))}
                    </ul>
                </section>
            ) : (
                <p className="mt-6 text-sm text-slate-600">Your academic details are complete. You can still review or update them below.</p>
            )}

            <form
                className="mt-6 space-y-6"
                onSubmit={(event) => {
                    event.preventDefault();
                    void handleSaveAndContinue();
                }}
            >
                {/* Lock the whole draft while a save is in flight: edits typed
                    after submission would otherwise be discarded when the
                    response resets the draft to the submitted snapshot. */}
                <fieldset disabled={saving} className="m-0 min-w-0 border-0 p-0">
                    <section id={FIELD_ANCHORS.claimedInstitution} aria-labelledby="field-institution-heading" className="scroll-mt-24 rounded-2xl border border-slate-200 bg-white p-4">
                        <h2 id="field-institution-heading" className="text-lg font-semibold text-slate-900">Institution</h2>
                        {!editableInstitution ? (
                            <div className="mt-2">
                                <p className="text-sm text-slate-700">{view.institution.displayName ?? 'Your institution is bound to your school identity.'}</p>
                                <p className="mt-1 text-sm text-slate-500">This is bound to your school identity and cannot be changed here.</p>
                                <Link
                                    href="/student/profile/support"
                                    onClick={(event) => {
                                        if (!shouldInterceptLinkClick(event)) return;
                                        event.preventDefault();
                                        requestLeave('/student/profile/support', false);
                                    }}
                                    className="mt-2 inline-flex min-h-[44px] items-center text-sm font-semibold text-[#1D4ED8] underline"
                                >
                                    My institution is incorrect
                                </Link>
                            </div>
                        ) : (
                            <div className="mt-2 space-y-3">
                                <SearchCombobox<InstitutionCatalogueItem>
                                    id="institution-name"
                                    label="Institution name"
                                    maxLength={FREE_TEXT_MAX_LENGTH}
                                    value={institutionName}
                                    placeholder="Start typing your institution"
                                    onValueChange={(value) => {
                                        setInstitutionName(value);
                                        setInstitutionMarked(null);
                                        markDirty('claimedInstitution');
                                        handleInputsChanged();
                                    }}
                                    items={institutionSearch.results}
                                    itemKey={(item) => `${item.name}|${item.countryCode ?? ''}`}
                                    itemLabel={(item) => item.name}
                                    itemHint={(item) => (item.countryCode ? `Country: ${item.countryCode}` : null)}
                                    status={institutionSearch.status}
                                    onSelect={(item) => {
                                        setInstitutionName(item.name);
                                        setInstitutionCountry(item.countryCode ?? '');
                                        setInstitutionMarked(null);
                                        markDirty('claimedInstitution');
                                        handleInputsChanged();
                                    }}
                                    describedBy={fieldErrors.institution ? 'institution-error' : undefined}
                                    emptyText="No matches. Your entry will be saved as written."
                                />
                                <p className="text-sm text-slate-600">
                                    <button
                                        type="button"
                                        onClick={() => document.getElementById('institution-name')?.focus()}
                                        className="font-semibold text-[#1D4ED8] underline"
                                    >
                                        Can&apos;t find your institution? Add its name
                                    </button>
                                </p>
                                <div>
                                    <label htmlFor="institution-country" className="block text-sm font-semibold text-slate-900">Country (2-letter code)</label>
                                    <input
                                        id="institution-country"
                                        autoComplete="off"
                                        maxLength={2}
                                        className="mt-1 block w-32 rounded-lg border border-slate-300 bg-white px-3 py-2 uppercase text-slate-900 focus:border-[#1D4ED8] focus:outline-2 focus:outline-[#1D4ED8]"
                                        value={institutionCountry}
                                        onChange={(event) => {
                                            setInstitutionCountry(event.target.value);
                                            setInstitutionMarked(null);
                                            markDirty('claimedInstitution');
                                            handleInputsChanged();
                                        }}
                                        aria-describedby={fieldErrors.institution ? 'institution-error' : undefined}
                                    />
                                </div>
                                {institutionMarked && <MarkedBadge marked={institutionMarked} />}
                                {fieldErrors.institution && <p role="alert" id="institution-error" className="text-sm text-red-700">{fieldErrors.institution}</p>}
                                <MarkButtons
                                    field="Institution"
                                    marked={institutionMarked}
                                    onMark={(state) => toggleMark('claimedInstitution', institutionMarked, setInstitutionMarked, () => {
                                        setInstitutionName('');
                                        setInstitutionCountry('');
                                    }, state)}
                                />
                            </div>
                        )}
                    </section>

                    <section id={FIELD_ANCHORS.programme} aria-labelledby="field-programme-heading" className="scroll-mt-24 rounded-2xl border border-slate-200 bg-white p-4">
                        <h2 id="field-programme-heading" className="text-lg font-semibold text-slate-900">Programme or course</h2>
                        <div className="mt-2">
                            <SearchCombobox<ProgrammeCatalogueItem>
                                id="programme"
                                label="Programme or course"
                                value={programmeText}
                                placeholder="Start typing your programme or course"
                                maxLength={FREE_TEXT_MAX_LENGTH}
                                onValueChange={(value) => {
                                    setProgrammeText(value);
                                    setProgrammeSelectedId(null);
                                    setProgrammeMarked(null);
                                    markDirty('programme');
                                    handleInputsChanged();
                                }}
                                items={programmeSearch.results}
                                itemKey={(item) => item.programmeId}
                                itemLabel={(item) => item.label}
                                itemHint={(item) => item.award}
                                status={programmeSearch.status}
                                onSelect={(item) => {
                                    setProgrammeText(item.label);
                                    setProgrammeSelectedId(item.programmeId);
                                    setProgrammeMarked(null);
                                    markDirty('programme');
                                    handleInputsChanged();
                                }}
                                describedBy={fieldErrors.programme ? 'programme-error' : undefined}
                                emptyText="No matches. Your entry will be saved as written."
                            />
                            {fieldErrors.programme && <p role="alert" id="programme-error" className="mt-1 text-sm text-red-700">{fieldErrors.programme}</p>}
                            <p className="mt-2 text-xs text-slate-500">Suggestions are programme names, not a confirmed list of courses offered by your institution. You can also type your course as written.</p>
                            {programmeMarked && <MarkedBadge marked={programmeMarked} />}
                            <MarkButtons
                                field="Programme or course"
                                marked={programmeMarked}
                                onMark={(state) => toggleMark('programme', programmeMarked, setProgrammeMarked, () => {
                                    setProgrammeText('');
                                    setProgrammeSelectedId(null);
                                }, state)}
                            />
                        </div>
                    </section>

                    <section id={FIELD_ANCHORS.entryYear} aria-labelledby="field-entry-year-heading" className="scroll-mt-24 rounded-2xl border border-slate-200 bg-white p-4">
                        <h2 id="field-entry-year-heading" className="text-lg font-semibold text-slate-900">Entry year</h2>
                        {showSuggestion && suggestion?.state === 'suggested' && (
                            <div className="mt-2 rounded-lg border border-[#1D4ED8]/30 bg-[#EEF2FF] p-3">
                                <p className="text-sm text-slate-800">Your school record suggests you started in <strong>{suggestion.year}</strong>.</p>
                                <div className="mt-2 flex flex-wrap gap-2">
                                    <button
                                        type="button"
                                        onClick={() => {
                                            setEntryYearText(String(suggestion.year));
                                            setEntryYearMarked(null);
                                            setSuggestionDismissed(true);
                                            markDirty('entryYear');
                                            handleInputsChanged();
                                        }}
                                        className="inline-flex min-h-[44px] items-center rounded-full bg-[#1D4ED8] px-4 text-sm font-bold text-white hover:bg-[#1E40AF]"
                                    >
                                        Use suggested year
                                    </button>
                                    <button
                                        type="button"
                                        onClick={() => setSuggestionDismissed(true)}
                                        className="inline-flex min-h-[44px] items-center rounded-full border border-slate-300 bg-white px-4 text-sm font-semibold text-slate-700 hover:bg-slate-50"
                                    >
                                        Dismiss suggestion
                                    </button>
                                </div>
                                <p className="mt-2 text-xs text-slate-600">You can also edit the year before saving. Dismissing keeps your current value.</p>
                            </div>
                        )}
                        <div className="mt-2">
                            <label htmlFor="entry-year" className="block text-sm font-semibold text-slate-900">Entry year</label>
                            <input
                                id="entry-year"
                                inputMode="numeric"
                                autoComplete="off"
                                placeholder="For example 2021"
                                className="mt-1 block w-48 rounded-lg border border-slate-300 bg-white px-3 py-2 text-slate-900 focus:border-[#1D4ED8] focus:outline-2 focus:outline-[#1D4ED8]"
                                value={entryYearText}
                                onChange={(event) => {
                                    setEntryYearText(event.target.value);
                                    setEntryYearMarked(null);
                                    markDirty('entryYear');
                                    handleInputsChanged();
                                }}
                                aria-describedby={fieldErrors.entryYear ? 'entry-year-error' : undefined}
                            />
                            {entryYearMarked && <MarkedBadge marked={entryYearMarked} />}
                            {fieldErrors.entryYear && <p role="alert" id="entry-year-error" className="mt-1 text-sm text-red-700">{fieldErrors.entryYear}</p>}
                            <MarkButtons
                                field="Entry year"
                                marked={entryYearMarked}
                                onMark={(state) => toggleMark('entryYear', entryYearMarked, setEntryYearMarked, () => setEntryYearText(''), state)}
                            />
                        </div>
                    </section>

                    <section id={FIELD_ANCHORS.entryRoute} aria-labelledby="field-entry-route-heading" className="scroll-mt-24 rounded-2xl border border-slate-200 bg-white p-4">
                        <h2 id="field-entry-route-heading" className="text-lg font-semibold text-slate-900">Entry route</h2>
                        <fieldset className="mt-2">
                            <legend className="sr-only">Entry route</legend>
                            <div className="space-y-2">
                                {ENTRY_ROUTE_OPTIONS.map((option) => (
                                    <label key={option} htmlFor={`entry-route-${option}`} className="flex min-h-[44px] cursor-pointer items-center gap-3 rounded-lg border border-slate-200 px-3 py-2 has-checked:border-[#1D4ED8] has-checked:bg-[#EEF2FF]">
                                        <input
                                            id={`entry-route-${option}`}
                                            type="radio"
                                            name="entry-route"
                                            value={option}
                                            checked={entryRouteMarked === null && entryRouteSel === option}
                                            onChange={() => {
                                                setEntryRouteSel(option);
                                                setEntryRouteMarked(null);
                                                markDirty('entryRoute');
                                                handleInputsChanged();
                                            }}
                                            className="h-5 w-5 accent-[#1D4ED8]"
                                        />
                                        <span className="text-sm font-medium text-slate-800">{entryRouteLabel(option)}</span>
                                    </label>
                                ))}
                            </div>
                        </fieldset>
                        {entryRouteMarked && <MarkedBadge marked={entryRouteMarked} />}
                        {entryRouteMarked === null && entryRouteSel !== null && (
                            <button
                                type="button"
                                onClick={() => {
                                    setEntryRouteSel(null);
                                    markDirty('entryRoute');
                                    handleInputsChanged();
                                }}
                                className="mt-2 inline-flex min-h-[44px] items-center text-sm font-semibold text-slate-600 underline"
                            >
                                Clear answer
                            </button>
                        )}
                        <MarkButtons
                            field="Entry route"
                            marked={entryRouteMarked}
                            onMark={(state) => toggleMark('entryRoute', entryRouteMarked, setEntryRouteMarked, () => setEntryRouteSel(null), state)}
                        />
                    </section>

                    <section id={FIELD_ANCHORS.expectedGraduationYear} aria-labelledby="field-graduation-year-heading" className="scroll-mt-24 rounded-2xl border border-slate-200 bg-white p-4">
                        <h2 id="field-graduation-year-heading" className="text-lg font-semibold text-slate-900">Expected graduation year</h2>
                        {institutionConfirmed !== null ? (
                            <div className="mt-2">
                                <p className="text-sm text-slate-700">
                                    Graduation year confirmed by your institution: <strong>{institutionConfirmed.year}</strong>
                                    {' '}(observed {new Date(institutionConfirmed.observedAt).toLocaleDateString()}).
                                </p>
                                <p className="mt-1 text-sm text-slate-600">
                                    This value is read-only here. If this year is wrong,{' '}
                                    <Link
                                        href="/student/verification"
                                        onClick={(event) => {
                                            if (!shouldInterceptLinkClick(event)) return;
                                            event.preventDefault();
                                            requestLeave('/student/verification', false);
                                        }}
                                        className="font-semibold text-[#1D4ED8] underline"
                                    >continue verification</Link>
                                    {' '}to correct it.
                                </p>
                            </div>
                        ) : (
                            <div className="mt-2 space-y-3">
                                {savedGraduation.state === 'supplied' && graduation.mode === 'pristine' && (
                                    <p className="text-sm text-slate-700">
                                        Saved: <strong>{savedGraduation.value}</strong>
                                        {view.fields.graduationYearOrigin === 'calculated' ? ' (calculated estimate)' : ' (saved year)'}
                                    </p>
                                )}
                                {savedGraduation.state !== 'supplied' && graduation.mode === 'pristine' && (
                                    <p className="text-sm text-slate-500">Not answered yet.</p>
                                )}
                                {calculatedStale && (
                                    <p role="alert" className="rounded-lg border border-amber-200 bg-amber-50 px-3 py-2 text-sm text-amber-900">
                                        Your saved graduation year may be out of date because your answers or the programme reference changed. Confirm a new year below.
                                    </p>
                                )}
                                {projectionEstimate && (
                                    <div className="rounded-lg border border-[#1D4ED8]/30 bg-[#EEF2FF] p-3">
                                        <p className="text-sm text-slate-800">Estimated graduation year: <strong>{projectionEstimate.year}</strong></p>
                                        <p className="mt-1 text-xs text-slate-600">
                                            Calculated from your saved details using reviewed programme durations
                                            {view.referenceVersion ? ` (${view.referenceVersion})` : ''}. Estimates are advisory and do not verify your enrollment.
                                        </p>
                                        <div className="mt-2 flex flex-wrap gap-2">
                                            <button
                                                type="button"
                                                onClick={() => applyEstimate(projectionEstimate.year)}
                                                className="inline-flex min-h-[44px] items-center rounded-full bg-[#1D4ED8] px-4 text-sm font-bold text-white hover:bg-[#1E40AF]"
                                            >
                                                Use estimated year
                                            </button>
                                            <button
                                                type="button"
                                                onClick={enterDifferentYear}
                                                className="inline-flex min-h-[44px] items-center rounded-full border border-slate-300 bg-white px-4 text-sm font-semibold text-slate-700 hover:bg-slate-50"
                                            >
                                                Enter a different year
                                            </button>
                                        </div>
                                    </div>
                                )}
                                {!projectionEstimate && (
                                    <div>
                                        <button
                                            type="button"
                                            onClick={() => void handleGetEstimate()}
                                            disabled={estimateUi.status === 'loading'}
                                            className="inline-flex min-h-[44px] items-center rounded-full border border-[#1D4ED8] px-4 text-sm font-bold text-[#1D4ED8] hover:bg-[#EEF2FF] disabled:opacity-50"
                                        >
                                            {estimateUi.status === 'loading' ? 'Checking…' : 'Get estimated year'}
                                        </button>
                                        {estimateUi.status === 'ready' && estimateUi.result.state === 'available' && (
                                            <div className="mt-2 rounded-lg border border-[#1D4ED8]/30 bg-[#EEF2FF] p-3">
                                                <p className="text-sm text-slate-800">Estimated graduation year: <strong>{estimateUi.result.year}</strong></p>
                                                <p className="mt-1 text-xs text-slate-600">
                                                    {effectiveEntryRoute && effectiveEntryYear
                                                        ? `Calculated from ${entryRouteLabel(effectiveEntryRoute)} entry in ${effectiveEntryYear} using reviewed programme durations (${estimateUi.result.sourceVersion}). `
                                                        : `Calculated using reviewed programme durations (${estimateUi.result.sourceVersion}). `}
                                                    Estimates are advisory and do not verify your enrollment.
                                                </p>
                                                <div className="mt-2 flex flex-wrap gap-2">
                                                    <button
                                                        type="button"
                                                        onClick={() => {
                                                            if (estimateUi.status === 'ready' && estimateUi.result.state === 'available') applyEstimate(estimateUi.result.year);
                                                        }}
                                                        className="inline-flex min-h-[44px] items-center rounded-full bg-[#1D4ED8] px-4 text-sm font-bold text-white hover:bg-[#1E40AF]"
                                                    >
                                                        Use estimated year
                                                    </button>
                                                    <button
                                                        type="button"
                                                        onClick={enterDifferentYear}
                                                        className="inline-flex min-h-[44px] items-center rounded-full border border-slate-300 bg-white px-4 text-sm font-semibold text-slate-700 hover:bg-slate-50"
                                                    >
                                                        Enter a different year
                                                    </button>
                                                </div>
                                            </div>
                                        )}
                                        {estimateUi.status === 'ready' && estimateUi.result.state === 'unavailable' && (
                                            <p className="mt-2 text-sm text-slate-600">{estimateUnavailableMessage(estimateUi.result.reason)}</p>
                                        )}
                                        {estimateUi.status === 'error' && (
                                            <p role="alert" className="mt-2 text-sm text-red-700">We could not load an estimate. Try again.</p>
                                        )}
                                    </div>
                                )}
                                {graduation.mode === 'accept' && (
                                    <div className="rounded-lg border border-emerald-200 bg-emerald-50 p-3">
                                        <p className="text-sm text-emerald-900">Using estimated year <strong>{graduation.year}</strong>. Save to confirm it.</p>
                                        <button
                                            type="button"
                                            onClick={enterDifferentYear}
                                            className="mt-2 inline-flex min-h-[44px] items-center rounded-full border border-slate-300 bg-white px-4 text-sm font-semibold text-slate-700 hover:bg-slate-50"
                                        >
                                            Enter a different year
                                        </button>
                                    </div>
                                )}
                                {graduation.mode !== 'accept' && (
                                    <div>
                                        <label htmlFor="graduation-year" className="block text-sm font-semibold text-slate-900">Expected graduation year</label>
                                        <input
                                            id="graduation-year"
                                            inputMode="numeric"
                                            autoComplete="off"
                                            placeholder="For example 2025"
                                            className="mt-1 block w-48 rounded-lg border border-slate-300 bg-white px-3 py-2 text-slate-900 focus:border-[#1D4ED8] focus:outline-2 focus:outline-[#1D4ED8]"
                                            value={graduation.mode === 'self' ? graduation.text : ''}
                                            onChange={(event) => {
                                                setGraduation({ mode: 'self', text: event.target.value });
                                                markDirty('expectedGraduationYear');
                                            }}
                                            aria-describedby={fieldErrors.graduation ? 'graduation-error' : undefined}
                                        />
                                        {savedGraduation.state === 'supplied' && view.fields.graduationYearOrigin === 'self_reported' && graduation.mode === 'self' && (
                                            <p className="mt-1 text-xs text-slate-500">You entered this year.</p>
                                        )}
                                    </div>
                                )}
                                {graduation.mode === 'marked' && <MarkedBadge marked={graduation.state} />}
                                {fieldErrors.graduation && <p role="alert" id="graduation-error" className="mt-1 text-sm text-red-700">{fieldErrors.graduation}</p>}
                                {view.referenceVersion && (
                                    <p className="text-xs text-slate-500">Programme reference: {view.referenceVersion}</p>
                                )}
                                <MarkButtons
                                    field="Expected graduation year"
                                    marked={graduation.mode === 'marked' ? graduation.state : null}
                                    onMark={(state) => toggleMark(
                                        'expectedGraduationYear',
                                        graduation.mode === 'marked' ? graduation.state : null,
                                        (marked) => setGraduation(marked ? { mode: 'marked', state: marked } : { mode: 'self', text: '' }),
                                        () => undefined,
                                        state,
                                    )}
                                />
                            </div>
                        )}
                    </section>

                    <div className="flex flex-col gap-3 sm:flex-row">
                        <button
                            type="submit"
                            disabled={saving}
                            className="inline-flex min-h-[44px] items-center justify-center rounded-full bg-[#1D4ED8] px-5 text-sm font-bold text-white hover:bg-[#1E40AF] disabled:opacity-50"
                        >
                            {saving ? 'Saving…' : 'Save and continue'}
                        </button>
                        <button
                            type="button"
                            onClick={handleCompleteLater}
                            disabled={saving}
                            ref={completeLaterRef}
                            className="inline-flex min-h-[44px] items-center justify-center rounded-full border border-slate-300 bg-white px-5 text-sm font-bold text-slate-700 hover:bg-slate-50 disabled:opacity-50"
                        >
                            Complete later
                        </button>
                    </div>
                </fieldset>
            </form>

            {renderEraseSection()}

            {leaveDialog && (
                <div
                    role="alertdialog"
                    aria-modal="true"
                    aria-labelledby="leave-title"
                    aria-describedby="leave-desc"
                    ref={leaveDialogRef}
                    className="fixed inset-0 z-50 flex items-center justify-center bg-slate-900/50 p-4"
                    onKeyDown={(event) => {
                        if (event.key === 'Escape') {
                            setPendingLeave(null);
                            setLeaveDialog(false);
                            return;
                        }
                        // Keep keyboard focus inside the modal: Tab cycles
                        // across the dialog buttons instead of escaping to
                        // the page behind it.
                        if (event.key !== 'Tab') return;
                        const root = leaveDialogRef.current;
                        if (!root) return;
                        const focusable = Array.from(root.querySelectorAll('button:not([disabled])')) as HTMLButtonElement[];
                        if (focusable.length === 0) return;
                        const first = focusable[0] as HTMLButtonElement;
                        const last = focusable[focusable.length - 1] as HTMLButtonElement;
                        if (event.shiftKey && document.activeElement === first) {
                            event.preventDefault();
                            last.focus();
                        } else if (!event.shiftKey && document.activeElement === last) {
                            event.preventDefault();
                            first.focus();
                        }
                    }}
                >
                    <div className="w-full max-w-md rounded-2xl bg-white p-6 shadow-xl">
                        <h2 id="leave-title" className="text-lg font-bold text-slate-900">Leave without saving?</h2>
                        <p id="leave-desc" className="mt-2 text-sm text-slate-600">
                            You have unsaved changes. Save them before leaving, or discard them and continue.
                        </p>
                        <div className="mt-4 flex flex-col gap-2">
                            <button
                                type="button"
                                disabled={saving}
                                onClick={() => {
                                    const pending = pendingLeave ?? COMPLETE_LATER_LEAVE;
                                    setPendingLeave(null);
                                    setLeaveDialog(false);
                                    void saveDraft().then((outcome) => {
                                        // Defer only after the save is
                                        // confirmed or reconciled; a failed
                                        // save stays on the form instead.
                                        // A claim-change conflict stashes
                                        // the leave for the reconfirmation
                                        // to complete.
                                        if (outcome === 'saved') {
                                            if (pending.kind === 'exit' && pending.defer) writeCompleteLaterDeferral();
                                            navigateToPendingLeave(pending);
                                        } else if (outcome === 'claim-offer') {
                                            saveLeaveRef.current = pending;
                                        }
                                    });
                                }}
                                className="inline-flex min-h-[44px] items-center justify-center rounded-full bg-[#1D4ED8] px-5 text-sm font-bold text-white hover:bg-[#1E40AF] disabled:opacity-50"
                            >
                                {saving ? 'Saving…' : 'Save and continue'}
                            </button>
                            <button
                                type="button"
                                // Both leave actions lock while a save is in
                                // flight: Discard must not navigate away from
                                // a request that may still commit, and Save
                                // must not double-submit it. Staying needs no
                                // lock: closing the dialog leaves the save
                                // running to its own outcome.
                                disabled={saving}
                                onClick={() => {
                                    // Confirmed discard clears only this
                                    // page's unsaved local draft; saved
                                    // answers are untouched.
                                    const pending = pendingLeave ?? COMPLETE_LATER_LEAVE;
                                    if (view) resetDraft(view);
                                    setPendingLeave(null);
                                    setLeaveDialog(false);
                                    if (pending.kind === 'exit' && pending.defer) writeCompleteLaterDeferral();
                                    navigateToPendingLeave(pending);
                                }}
                                className="inline-flex min-h-[44px] items-center justify-center rounded-full border border-slate-300 px-5 text-sm font-bold text-slate-700 hover:bg-slate-50 disabled:opacity-50"
                            >
                                Discard and continue
                            </button>
                            <button
                                type="button"
                                autoFocus
                                onClick={() => {
                                    setPendingLeave(null);
                                    setLeaveDialog(false);
                                }}
                                className="inline-flex min-h-[44px] items-center justify-center rounded-full px-5 text-sm font-semibold text-slate-600 underline"
                            >
                                Stay on this page
                            </button>
                        </div>
                    </div>
                </div>
            )}
        </Shell>
    );
}

function Shell({ children, onRequestLeave }: { children: ReactNode; onRequestLeave?: (href: string) => void }) {
    const guardedClick = (href: string) => (event: ReactMouseEvent<HTMLAnchorElement>) => {
        if (!onRequestLeave || !shouldInterceptLinkClick(event)) return;
        event.preventDefault();
        onRequestLeave(href);
    };
    return (
        <div className="min-h-screen bg-[#F4F7FD] text-slate-900">
            <header className="sticky top-0 z-30 border-b border-slate-200/80 bg-white/80 backdrop-blur-md">
                <div className="mx-auto flex max-w-3xl items-center justify-between gap-3 px-4 py-3">
                    <Link href="/marketplace" onClick={guardedClick('/marketplace')} className="text-sm font-semibold text-slate-600 hover:text-[#1D4ED8]">
                        Marketplace
                    </Link>
                    <Link href="/marketplace" onClick={guardedClick('/marketplace')} aria-label="Awoof home">
                        <Logo width={100} height={32} />
                    </Link>
                    <span className="w-16 text-right text-sm font-bold text-slate-900">Profile</span>
                </div>
            </header>
            <main className="mx-auto w-full max-w-xl px-4 py-8">{children}</main>
        </div>
    );
}

export default function StudentProfileCompletePage() {
    const { user } = useAuth();
    const generation = useSyncExternalStore(subscribeSessionChanges, sessionGeneration, serverGeneration);
    return (
        <ProtectedRoute requiredRole="student">
            {user?.role === 'student' && <CompletionForm key={`${generation}:${user.id}`} />}
        </ProtectedRoute>
    );
}
