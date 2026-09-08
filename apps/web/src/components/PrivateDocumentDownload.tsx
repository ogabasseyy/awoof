'use client';

import { useState } from 'react';
import apiClient from '@/lib/api-client';

export function PrivateDocumentDownload({ path }: { path: string }) {
    const [busy, setBusy] = useState(false);
    const [error, setError] = useState('');
    async function download() {
        setBusy(true); setError('');
        try {
            if (!/^\/uploads\/(?:private-vendors|vendors)\/[a-f0-9-]{36}\.[a-zA-Z0-9]+$/.test(path)) throw new Error();
            const response = await apiClient.get<Blob>(path, {
                baseURL: apiClient.defaults.baseURL?.replace(/\/api$/, ''), responseType: 'blob',
            });
            const url = URL.createObjectURL(response.data);
            const link = document.createElement('a');
            link.href = url; link.download = `document.${path.split('.').pop()}`; link.click();
            setTimeout(() => URL.revokeObjectURL(url), 30_000);
        } catch { setError('Unable to download this document. Please try again.'); }
        finally { setBusy(false); }
    }
    return <><button type="button" disabled={busy} onClick={download} className="text-sm text-blue-700 underline">{busy ? 'Downloading…' : 'Download current document'}</button>{error && <p role="alert">{error}</p>}</>;
}
