import * as vscode from 'vscode';
import { VaultProvider } from './vaultProvider';

/** One encrypted checkpoint per open document, independent of VS Code backup IDs. */
export class DraftJournal {
    private timer?: ReturnType<typeof setTimeout>;
    private pending: Promise<void> = Promise.resolve();
    private latest?: string;
    private disposed = false;
    private failure?: unknown;
    constructor(private readonly provider: VaultProvider, private readonly uri: vscode.Uri,
        private readonly snapshot: () => { text: string; revision: string; dirty: boolean }) {}
    schedule(): void {
        if (this.disposed) { return; }
        clearTimeout(this.timer);
        this.timer = setTimeout(() => { void this.checkpoint().catch(() => {}); }, 250);
        this.timer.unref?.();
    }
    async checkpoint(): Promise<void> {
        clearTimeout(this.timer);
        if (this.disposed) { return; }
        const snapshot = this.snapshot();
        if (!snapshot.dirty) { return; }
        const next = this.pending.then(async () => {
            if (this.disposed) { return; }
            const id = await this.provider.createBackup(this.uri, snapshot.text, snapshot.revision);
            const previous = this.latest;
            this.latest = id; this.failure = undefined;
            if (previous) { await this.provider.deleteBackup(this.uri, previous).catch(() => {}); }
        });
        this.pending = next.catch(error => { this.failure = error; });
        await next;
    }
    async clear(): Promise<void> {
        clearTimeout(this.timer);
        await this.pending;
        const id = this.latest;
        if (id) { await this.provider.deleteBackup(this.uri, id); this.latest = undefined; }
    }
    get error(): unknown { return this.failure; }
    dispose(): void {
        clearTimeout(this.timer); this.disposed = true;
        // Leave completed checkpoints encrypted in the vault for authenticated recovery.
    }
}
