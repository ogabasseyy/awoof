/** Cleanup policy for the runner's own synthetic cluster only. */
export function cleanupOwnedCluster({ scratch, dataDirectory, pgCtl, startupAttempted, spawn, remove, write }) {
    if (!startupAttempted || !pgCtl) {
        remove(scratch);
        return { removed: true, retained: false };
    }
    const status = spawn(pgCtl, ['-D', dataDirectory, 'status'], 10_000);
    if (status.error) return retain(scratch, write);
    if (status.status === 0) {
        const stopped = spawn(pgCtl, ['-D', dataDirectory, 'stop', '-m', 'fast', '-w', '-t', '15'], 20_000);
        const confirmation = spawn(pgCtl, ['-D', dataDirectory, 'status'], 10_000);
        if (stopped.error || stopped.status !== 0 || confirmation.error || confirmation.status === 0) return retain(scratch, write);
    } else if (status.status !== 3) return retain(scratch, write);
    remove(scratch);
    return { removed: true, retained: false };
}

function retain(scratch, write) {
    write(`Disposable PostgreSQL shutdown could not be confirmed; retaining exact scratch directory: ${scratch}\n`);
    return { removed: false, retained: true };
}
