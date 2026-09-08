'use client';

import { useEffect, useRef, useState } from 'react';
import apiClient from '@/lib/api-client';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';

type Policy = {
    domains: string[];
    emailEvidenceValidityDays: number;
    enrollmentValidityDays: number;
    registrationNormalization: 'exact' | 'trim_upper' | null;
    isActive: boolean;
};

export function VerificationPolicyEditor({ institution, onClose }: {
    institution: { id: string; name: string; emailDomains?: string[] };
    onClose: () => void;
}) {
    const panel = useRef<HTMLElement>(null);
    useEffect(() => { panel.current?.focus(); }, []);
    const [policy, setPolicy] = useState<Policy | null>(null);
    const [domains, setDomains] = useState('');
    const [confirmed, setConfirmed] = useState(false);
    const [saving, setSaving] = useState(false);
    const [error, setError] = useState('');
    useEffect(() => {
        let active = true;
        void apiClient.get(`/admin/universities/${institution.id}/verification-policy`).then((response) => {
            if (!active) return;
            const current = response.data.data.policy as Policy;
            setPolicy(current);
            setDomains(current.domains.join(', '));
        }).catch(() => { if (active) setError('Could not load the verification policy. Close and retry.'); });
        return () => { active = false; };
    }, [institution.id]);

    async function save(event: React.FormEvent) {
        event.preventDefault();
        if (!policy || !confirmed || saving) return;
        setSaving(true);
        setError('');
        try {
            await apiClient.put(`/admin/universities/${institution.id}/verification-policy`, {
                domains: domains.split(',').map((domain) => domain.trim().toLowerCase()).filter(Boolean),
                emailEvidenceValidityDays: policy.emailEvidenceValidityDays,
                enrollmentValidityDays: policy.enrollmentValidityDays,
                registrationNormalization: policy.registrationNormalization,
                isActive: policy.isActive,
            });
            onClose();
        } catch {
            setError('Policy was not saved. Check the exact domains and your administrator access, then retry.');
        } finally { setSaving(false); }
    }

    return (
        <section ref={panel} tabIndex={-1} className="my-6 rounded-xl border bg-white p-6" aria-labelledby="policy-title">
            <h2 id="policy-title" className="text-lg font-semibold">Student verification: {institution.name}</h2>
            <p className="mt-2 text-sm">Approve exact student mailbox domains after confirming the institution’s student email rules. Website and directory domains are suggestions, not approval.</p>
            <p className="mt-2 text-sm">Directory candidates: {institution.emailDomains?.join(', ') || 'None recorded'}</p>
            {error && <p role="alert" className="my-3 text-red-700">{error}</p>}
            {!policy ? <p className="my-3">Loading policy…</p> : (
                <form onSubmit={save} className="mt-4 space-y-4">
                    <div><Label htmlFor="approved-domains">Approved student domains (comma-separated)</Label>
                        <Input id="approved-domains" value={domains} disabled={saving} onChange={(event) => { setDomains(event.target.value); setConfirmed(false); }} />
                        <p className="text-sm">An empty list disables student email signup. Removing a domain revokes eligibility based on it.</p></div>
                    <div><Label htmlFor="email-validity">Email evidence validity (days)</Label>
                        <Input id="email-validity" type="number" min={1} max={365} required disabled={saving} value={policy.emailEvidenceValidityDays} onChange={(event) => { setPolicy({ ...policy, emailEvidenceValidityDays: Number(event.target.value) }); setConfirmed(false); }} /></div>
                    <label className="flex items-start gap-2"><input type="checkbox" checked={confirmed} disabled={saving} onChange={(event) => setConfirmed(event.target.checked)} />
                        I have verified these student domains and approve this policy change. My administrator identity will be recorded.</label>
                    <Button type="submit" disabled={!confirmed || saving}>{saving ? 'Saving…' : 'Approve and save policy'}</Button>
                </form>
            )}
            <Button type="button" variant="outline" className="mt-3" disabled={saving} onClick={onClose}>Close</Button>
        </section>
    );
}
