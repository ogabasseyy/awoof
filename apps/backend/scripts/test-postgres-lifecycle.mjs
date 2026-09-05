/** Cleanup policy for the runner's own synthetic cluster only. */
export function cleanupOwnedCluster({ scratch, dataDirectory, pgCtl, startupAttempted, spawn, remove, write }) {
    if (!startupAttempted || !pgCtl) {
        remove(scratch);
        return { removed: true, retained: false };
    }
    const status = spawn(pgCtl, ['-D', dataDirectory, 'status'], 10_000);
    if (isExactStopped(status)) {
        remove(scratch);
        return { removed: true, retained: false };
    }
    if (!status.error && !status.signal && status.status === 0) {
        const stopped = spawn(pgCtl, ['-D', dataDirectory, 'stop', '-m', 'fast', '-w', '-t', '15'], 20_000);
        const confirmation = spawn(pgCtl, ['-D', dataDirectory, 'status'], 10_000);
        if (stopped.error || stopped.signal || stopped.status !== 0 || !isExactStopped(confirmation)) return retain(scratch, write);
        remove(scratch);
        return { removed: true, retained: false };
    }
    return retain(scratch, write);
}

function isExactStopped(result) {
    return !result.error && !result.signal && result.status === 3;
}

function retain(scratch, write) {
    write(`Disposable PostgreSQL shutdown could not be confirmed; retaining exact scratch directory: ${scratch}\n`);
    return { removed: false, retained: true };
}
