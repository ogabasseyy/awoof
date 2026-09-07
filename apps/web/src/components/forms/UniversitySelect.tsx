/** Public university directory combobox. */

'use client';

import React, { useCallback, useEffect, useId, useRef, useState } from 'react';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { publicApiClient } from '@/lib/api-client';

interface University {
    id: string;
    name: string;
    domain?: string;
    shortcode?: string;
    country?: string;
}

interface UniversitySelectProps {
    value?: string;
    onChange: (universityId: string | null, university: University | null) => void;
    error?: string;
    required?: boolean;
}

type SearchState = { value: string; draft: string | null; clearingFrom: string | null };

function normalizeUniversity(value: unknown): University | null {
    if (!value || typeof value !== 'object') return null;
    const record = value as Record<string, unknown>;
    if (typeof record.id !== 'string' || record.id.trim().length === 0) return null;
    if (typeof record.name !== 'string' || record.name.trim().length === 0) return null;
    return {
        id: record.id,
        name: record.name,
        shortcode: typeof record.shortcode === 'string' ? record.shortcode : undefined,
        domain: typeof record.domain === 'string' ? record.domain : undefined,
        country: typeof record.country === 'string' ? record.country : undefined,
    };
}

export function UniversitySelect({ value, onChange, error, required = false }: UniversitySelectProps) {
    const [universities, setUniversities] = useState<University[]>([]);
    const [loading, setLoading] = useState(true);
    const [fetchError, setFetchError] = useState<string | null>(null);
    const [open, setOpen] = useState(false);
    const [activeIndex, setActiveIndex] = useState(-1);
    const normalizedValue = value ?? '';
    const selected = universities.find((entry) => entry.id === normalizedValue) ?? null;
    const [search, setSearch] = useState<SearchState>({ value: normalizedValue, draft: null, clearingFrom: null });
    const requestRef = useRef(0);
    const abortRef = useRef<AbortController | null>(null);
    const fieldId = useId();
    const listboxId = `${fieldId}-listbox`;
    const directoryErrorId = `${fieldId}-directory-error`;
    const fieldErrorId = `${fieldId}-field-error`;
    const statusId = `${fieldId}-status`;

    let currentSearch = search;
    if (search.value !== normalizedValue) {
        const ownClear = normalizedValue === '' && search.clearingFrom === search.value;
        currentSearch = { value: normalizedValue, draft: ownClear ? search.draft : null, clearingFrom: null };
        setSearch(currentSearch);
        if (!ownClear) {
            setOpen(false);
            setActiveIndex(-1);
        }
    }

    const query = currentSearch.draft ?? selected?.name ?? '';
    const term = query.trim().toLowerCase();
    const matches = term ? universities.filter((entry) => [entry.name, entry.shortcode, entry.domain]
        .some((part) => part?.toLowerCase().includes(term))) : [];
    const noMatches = Boolean(term) && !loading && !fetchError && matches.length === 0;
    const activeUniversity = open && activeIndex >= 0 ? matches[activeIndex] : undefined;
    const activeUniversityId = activeUniversity?.id;

    const fetchUniversities = useCallback(async () => {
        abortRef.current?.abort();
        const controller = new AbortController();
        abortRef.current = controller;
        const request = ++requestRef.current;
        setLoading(true);
        setFetchError(null);
        try {
            const response = await publicApiClient.get('/universities', { signal: controller.signal });
            const raw = response.data?.data?.universities;
            if (!Array.isArray(raw)) throw new Error('Malformed university directory response.');
            const directory = raw.map(normalizeUniversity).filter((entry): entry is University => entry !== null);
            if (request !== requestRef.current || controller.signal.aborted) return;
            setUniversities(directory);
        } catch {
            if (request !== requestRef.current || controller.signal.aborted) return;
            setUniversities([]);
            setFetchError('Could not load universities. Check your connection and try again.');
        } finally {
            if (request === requestRef.current && !controller.signal.aborted) setLoading(false);
        }
    }, []);

    useEffect(() => {
        let active = true;
        void Promise.resolve().then(() => {
            if (active) return fetchUniversities();
        });
        return () => {
            active = false;
            abortRef.current?.abort();
        };
    }, [fetchUniversities]);

    useEffect(() => {
        if (!open || !activeUniversityId) return;
        document.getElementById(`${listboxId}-${activeUniversityId}`)?.scrollIntoView({ block: 'nearest', inline: 'nearest' });
    }, [activeUniversityId, listboxId, open]);

    function closePopup(): void {
        setOpen(false);
        setActiveIndex(-1);
    }

    function changeQuery(text: string): void {
        setSearch({ value: normalizedValue, draft: text, clearingFrom: normalizedValue || null });
        setActiveIndex(-1);
        setOpen(true);
        if (value) onChange(null, null);
    }

    function selectUniversity(university: University): void {
        setSearch({ value: normalizedValue, draft: null, clearingFrom: null });
        closePopup();
        onChange(university.id, university);
    }

    function handleKeyDown(event: React.KeyboardEvent<HTMLInputElement>): void {
        if ((event.key === 'ArrowDown' || event.key === 'ArrowUp') && matches.length) {
            event.preventDefault();
            setOpen(true);
            setActiveIndex((current) => event.key === 'ArrowDown'
                ? Math.min(current + 1, matches.length - 1)
                : (current < 0 ? matches.length - 1 : Math.max(current - 1, 0)));
        } else if (event.key === 'Enter' && open && activeIndex >= 0 && matches[activeIndex]) {
            event.preventDefault();
            selectUniversity(matches[activeIndex]);
        } else if (event.key === 'Escape' && open) {
            event.preventDefault();
            closePopup();
        }
    }

    const describedBy = [fetchError ? directoryErrorId : null, error ? fieldErrorId : null, noMatches ? statusId : null]
        .filter(Boolean).join(' ') || undefined;

    return (
        <div className="relative">
            <Label htmlFor={fieldId} className="text-left block mb-2">
                University
                {required ? <span className="text-red-500 ml-1">*</span> : <span className="text-gray-400 ml-1 text-xs">(Optional)</span>}
            </Label>
            <div className="relative">
                <Input
                    id={fieldId}
                    type="text"
                    role="combobox"
                    placeholder={loading ? 'Loading universities...' : 'Type to search by name or shortcode...'}
                    value={query}
                    onChange={(event) => changeQuery(event.target.value)}
                    onFocus={() => { if (matches.length > 0) setOpen(true); }}
                    onBlur={() => {
                        setSearch({ value: normalizedValue, draft: null, clearingFrom: null });
                        closePopup();
                    }}
                    onKeyDown={handleKeyDown}
                    className="w-full"
                    aria-invalid={error ? 'true' : 'false'}
                    aria-autocomplete="list"
                    aria-controls={listboxId}
                    aria-activedescendant={activeUniversity ? `${listboxId}-${activeUniversity.id}` : undefined}
                    aria-expanded={open}
                    aria-required={required || undefined}
                    aria-describedby={describedBy}
                    disabled={loading}
                />
                {open && matches.length > 0 && (
                    <div id={listboxId} role="listbox" className="absolute z-50 w-full mt-1 bg-white border border-gray-200 rounded-md shadow-lg max-h-60 overflow-auto">
                        {matches.map((university, index) => (
                            <div
                                key={university.id}
                                id={`${listboxId}-${university.id}`}
                                role="option"
                                aria-selected={index === activeIndex}
                                tabIndex={-1}
                                onPointerDown={(event) => event.preventDefault()}
                                onClick={() => selectUniversity(university)}
                                className={`w-full text-left px-4 py-2 cursor-pointer transition-colors ${index === activeIndex ? 'bg-gray-100' : 'hover:bg-gray-100'}`}
                            >
                                <div className="font-medium">{university.name}</div>
                                {(university.shortcode || university.country) && <div className="text-sm text-gray-500">{[university.shortcode, university.country].filter(Boolean).join(' • ')}</div>}
                            </div>
                        ))}
                    </div>
                )}
            </div>
            {noMatches && <p id={statusId} role="status" className="mt-1 text-sm text-slate-600">No matching university. Try another name or shortcode.</p>}
            {fetchError && (
                <p id={directoryErrorId} role="alert" className="mt-1 text-sm text-red-600 flex items-center gap-2">
                    {fetchError}
                    <button type="button" onClick={() => void fetchUniversities()} className="text-sm underline hover:no-underline">Retry</button>
                </p>
            )}
            {error && <p id={fieldErrorId} className="mt-1 text-sm text-red-600 flex items-center gap-1">{error}</p>}
        </div>
    );
}
