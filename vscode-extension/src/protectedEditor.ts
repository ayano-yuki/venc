import * as vscode from 'vscode';
import { randomBytes } from 'node:crypto';
import { readFileSync } from 'node:fs';
import * as path from 'node:path';
import { TextPatch, difference, applyPatch, preferredEol, normalizeEol, fromRenderer } from './textModel';
const script = readFileSync(path.join(__dirname, '../media/editor.js'), 'utf8');
const styles = readFileSync(path.join(__dirname, '../media/editor.css'), 'utf8');
import { DraftJournal } from './draftJournal';
import { VaultProvider, SCHEME } from './vaultProvider';

export const PROTECTED_EDITOR = 'venc.protectedEditor';
const MAX_TEXT = 16 * 1024 * 1024;
export class ProtectedDocument implements vscode.CustomDocument {
    readonly panels = new Set<vscode.WebviewPanel>();
    version = 0;
    dirty: boolean;
    active = true;
    saving = false;
    frozen = false;
    journal?: DraftJournal;
    savedText: string;
    eol: '\n' | '\r\n';
    readonly edits: TextPatch[] = [];
    historyBytes = 0;
    constructor(readonly uri: vscode.Uri, public text: string, public revision: string, restored: boolean,
        private readonly remove: () => void) { this.dirty = restored; this.savedText = text; this.eol = preferredEol(text); }
    dispose(): void {
        if (!this.active) { return; }
        this.journal?.dispose();
        this.active = false; this.text = ''; this.savedText = ''; this.revision = '';
        for (const edit of this.edits) { edit.removed = ''; edit.inserted = ''; edit.released = true; }
        this.edits.length = 0;
        for (const panel of this.panels) { void panel.webview.postMessage({ type: 'clear' }); panel.dispose(); }
        this.panels.clear(); this.remove();
    }
}
export class ProtectedEditor implements vscode.CustomEditorProvider<ProtectedDocument>, vscode.Disposable {
    private readonly events = new vscode.EventEmitter<vscode.CustomDocumentEditEvent<ProtectedDocument>>();
    readonly onDidChangeCustomDocument = this.events.event;
    readonly documents = new Map<string, ProtectedDocument>();
    constructor(private readonly provider: VaultProvider, private readonly scheme = SCHEME) {}
    dirty(authority: string): boolean { return [...this.documents.values()].some(d => d.uri.authority === authority && d.dirty); }
    guardMutation(uri: vscode.Uri): void {
        if ([...this.documents.values()].some(d => d.uri.authority === uri.authority &&
            (d.uri.path === uri.path || d.uri.path.startsWith(uri.path.replace(/\/$/, '') + '/')))) {
            throw vscode.FileSystemError.NoPermissions('Save and close protected editors before renaming or deleting their files or folders.');
        }
    }
    revoke(authority: string): void {
        for (const doc of [...this.documents.values()]) { if (doc.uri.authority === authority) { doc.dispose(); } }
    }
    private check(doc: ProtectedDocument, token?: vscode.CancellationToken): void {
        if (!doc.active || this.documents.get(doc.uri.toString()) !== doc) { throw vscode.FileSystemError.Unavailable('Protected document is closed.'); }
        if (token?.isCancellationRequested) { throw new vscode.CancellationError(); }
    }
    async openCustomDocument(uri: vscode.Uri, context: vscode.CustomDocumentOpenContext, token: vscode.CancellationToken): Promise<ProtectedDocument> {
        if (uri.scheme !== this.scheme || context.untitledDocumentData) { throw vscode.FileSystemError.NoPermissions('Open an existing encrypted vault file.'); }
        let backup: string | undefined;
        if (context.backupId) {
            const match = /^([a-f0-9]{32}):([a-f0-9]{32})$/.exec(context.backupId);
            if (!match || match[1] !== uri.authority) { throw vscode.FileSystemError.NoPermissions('Invalid encrypted backup reference.'); }
            backup = match[2];
        }
        if (this.documents.has(uri.toString())) { throw new Error('Protected document is already open.'); }
        const snapshot = await this.provider.readDocument(uri, backup);
        if (token.isCancellationRequested) { snapshot.text = ''; throw new vscode.CancellationError(); }
        const doc = new ProtectedDocument(uri, snapshot.text, snapshot.revision, !!backup, () => {
            if (this.documents.get(uri.toString()) === doc) { this.documents.delete(uri.toString()); }
        });
        if (backup) {
            try { doc.savedText = (await this.provider.readDocument(uri)).text; }
            catch (error) { if (!(error instanceof vscode.FileSystemError) || error.code !== 'FileNotFound') { throw error; } doc.savedText = ''; }
        }
        doc.journal = new DraftJournal(this.provider, uri, () => ({ text: doc.text, revision: doc.revision, dirty: doc.dirty }));
        this.documents.set(uri.toString(), doc);
        return doc;
    }
    // The webview sends contents only in IPC messages, never HTML or persistent webview state.
    update(doc: ProtectedDocument, text: string): void {
        this.check(doc);
        if (doc.frozen) { throw new Error('Editing is paused while the vault is closing.'); }
        if (typeof text !== 'string' || text.length > MAX_TEXT || Buffer.byteLength(text) > MAX_TEXT || text.includes('\0')) {
            throw vscode.FileSystemError.NoPermissions('Text must be UTF-8, without NUL bytes, and at most 16 MiB.');
        }
        if (doc.text === text) { return; }
        const before = doc.text;
        doc.text = text; doc.version++; doc.dirty = text !== doc.savedText;
        const edit = difference(before, text);
        doc.edits.push(edit); doc.historyBytes += Buffer.byteLength(edit.removed) + Buffer.byteLength(edit.inserted);
        while (doc.historyBytes > 32 * 1024 * 1024 && doc.edits.length > 1) {
            const oldest = doc.edits.shift()!;
            doc.historyBytes -= Buffer.byteLength(oldest.removed) + Buffer.byteLength(oldest.inserted);
            oldest.removed = ''; oldest.inserted = ''; oldest.released = true;
        }
        this.events.fire({ document: doc, label: 'Edit encrypted document',
            undo: () => this.history(doc, edit, true), redo: () => this.history(doc, edit, false) });
        doc.journal?.schedule();
    }
    resolveCustomEditor(doc: ProtectedDocument, panel: vscode.WebviewPanel): void {
        this.check(doc); doc.panels.add(panel);
        panel.webview.options = { enableScripts: true, localResourceRoots: [] };
        const nonce = randomBytes(24).toString('base64');
        panel.webview.html = `<!doctype html><html><head><meta charset="utf-8">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; script-src 'nonce-${nonce}'; style-src 'nonce-${nonce}'; form-action 'none'; base-uri 'none';">
<style nonce="${nonce}">${styles}</style></head>
<body><div id="toolbar">Protected UTF-8 editor · encrypted backups <button id="save">Save</button><label>Line endings <select id="eol"><option>LF</option><option>CRLF</option></select></label></div>
<div id="search" hidden><input id="query" aria-label="Find text" placeholder="Find"><input id="replacement" aria-label="Replacement text" placeholder="Replace with"><label><input id="match-case" type="checkbox">Match case</label><button id="find-next">Next</button><button id="replace">Replace</button><button id="replace-all">Replace All</button><button id="close-search" aria-label="Close search">Close</button></div>
<textarea id="text" spellcheck="false" aria-label="Vault document" disabled></textarea><p id="status" role="status">Loading…</p>
<script nonce="${nonce}">${script}</script></body></html>`;
        let sequence = 0;
        let epoch = 0;
        let ready = false;
        const send = () => { sequence = 0; epoch++; void panel.webview.postMessage({ type: 'load', text: doc.text, dirty: doc.dirty, epoch, frozen: doc.frozen, eol: doc.eol === '\r\n' ? 'CRLF' : 'LF' }); };
        const listener = panel.webview.onDidReceiveMessage(async (message: unknown) => {
            if (!doc.active || !message || typeof message !== 'object') { return; }
            const m = message as Record<string, unknown>;
            try {
                if (m.type === 'ready') { ready = true; send(); }
                else if (m.type === 'edit' && m.epoch === epoch && Number.isSafeInteger(m.sequence) && (m.sequence as number) > sequence && typeof m.text === 'string') {
                    this.update(doc, fromRenderer(doc.text, m.text, doc.eol)); sequence = m.sequence as number;
                } else if (m.type === 'snapshot' && typeof m.request === 'string' && m.epoch === epoch && typeof m.text === 'string'
                    && Number.isSafeInteger(m.sequence) && (m.sequence as number) > sequence) {
                    const pending = this.snapshots.get(m.request);
                    if (pending?.doc === doc) {
                        const text = fromRenderer(doc.text, m.text, doc.eol);
                        if (text !== doc.text) { this.update(doc, text); }
                        sequence = m.sequence as number;
                        doc.frozen = doc.frozen || pending.freeze;
                        clearTimeout(pending.timer); this.snapshots.delete(m.request); pending.resolve();
                    }
                } else if (m.type === 'eol' && (m.value === 'LF' || m.value === 'CRLF')) {
                    await this.flush(doc);
                    const eol = m.value === 'CRLF' ? '\r\n' : '\n';
                    this.update(doc, normalizeEol(doc.text).replace(/\n/g, eol)); doc.eol = eol; this.refresh(doc);
                } else if (m.type === 'undo' || m.type === 'redo') {
                    await this.flush(doc); await this.focus(doc); await vscode.commands.executeCommand(m.type);
                    void panel.webview.postMessage({ type: 'focus' });
                } else if (m.type === 'save') { await this.saveViaWorkbench(doc); }
            } catch (error) {
                void panel.webview.postMessage({ type: 'status', message: error instanceof Error ? error.message : 'Operation failed' });
            }
        });
        const disposed = panel.onDidDispose(() => { listener.dispose(); disposed.dispose(); doc.panels.delete(panel); });
        // Refresh on Revert only; saves must not replace text typed during an in-flight save.
        this.refreshers.set(panel, send);
        this.renderers.set(panel, { ready: () => ready, doc });
        panel.onDidDispose(() => { this.refreshers.delete(panel); this.renderers.delete(panel); });
    }
    private history(doc: ProtectedDocument, edit: TextPatch, reverse: boolean): void {
        this.check(doc);
        if (doc.frozen) { throw new Error('Editing is paused while closing.'); }
        doc.text = applyPatch(doc.text, edit, reverse); doc.version++; doc.dirty = doc.text !== doc.savedText;
        doc.eol = preferredEol(doc.text); doc.journal?.schedule(); this.refresh(doc);
    }
    private refresh(doc: ProtectedDocument): void { for (const panel of doc.panels) { this.refreshers.get(panel)?.(); } }
    private async focus(doc: ProtectedDocument): Promise<void> {
        await vscode.commands.executeCommand('vscode.openWith', doc.uri, PROTECTED_EDITOR);
        const input = vscode.window.tabGroups.activeTabGroup.activeTab?.input;
        if (!(input instanceof vscode.TabInputCustom) || input.uri.toString() !== doc.uri.toString() || input.viewType !== PROTECTED_EDITOR) { throw new Error('Focus the protected editor and retry.'); }
    }
    private readonly refreshers = new Map<vscode.WebviewPanel, () => void>();
    private readonly renderers = new Map<vscode.WebviewPanel, { ready: () => boolean; doc: ProtectedDocument }>();
    private readonly snapshots = new Map<string, { doc: ProtectedDocument; freeze: boolean; timer: ReturnType<typeof setTimeout>; resolve: () => void; reject: (e: Error) => void }>();
    async flush(doc: ProtectedDocument, freeze = false): Promise<void> {
        this.check(doc);
        if (doc.frozen) { return; }
        const panel = [...doc.panels][0];
        if (!panel) { doc.frozen = freeze; return; }
        const deadline = Date.now() + 3000;
        while (!this.renderers.get(panel)?.ready() && Date.now() < deadline && doc.active) { await new Promise(resolve => setTimeout(resolve, 20)); }
        this.check(doc);
        if (!this.renderers.get(panel)?.ready()) { throw new Error('Editor is still loading. Retry without closing it.'); }
        const request = randomBytes(16).toString('hex');
        await new Promise<void>((resolve, reject) => {
            const timer = setTimeout(() => { this.snapshots.delete(request); reject(new Error('Editor did not confirm its latest contents. Vault remains open.')); }, 3000);
            this.snapshots.set(request, { doc, freeze, timer, resolve, reject });
            void panel.webview.postMessage({ type: 'snapshot', request, freeze }).then(delivered => {
                if (!delivered && this.snapshots.delete(request)) { clearTimeout(timer); reject(new Error('Editor is unavailable. Retry before closing.')); }
            });
        });
    }
    async freezeAll(authority: string): Promise<void> {
        try { for (const doc of this.documents.values()) { if (doc.uri.authority === authority) { await this.flush(doc, true); } } }
        catch (error) { this.resumeAll(authority); throw error; }
    }
    resumeAll(authority: string): void {
        for (const doc of this.documents.values()) {
            if (doc.uri.authority === authority) { doc.frozen = false; for (const panel of doc.panels) { void panel.webview.postMessage({ type: 'resume' }); } }
        }
    }
    async checkpointAll(authority: string): Promise<void> {
        await this.freezeAll(authority);
        for (const doc of this.documents.values()) { if (doc.uri.authority === authority) { await doc.journal?.checkpoint(); } }
    }
    async saveViaWorkbench(doc: ProtectedDocument): Promise<void> {
        this.check(doc);
        await this.focus(doc);
        await vscode.commands.executeCommand('workbench.action.files.save');
        if (doc.dirty) { throw new Error('Save failed or more edits arrived. Vault remains open.'); }
    }
    async saveAll(authority: string): Promise<void> {
        for (const doc of this.documents.values()) { if (doc.uri.authority === authority && doc.dirty) { await this.saveViaWorkbench(doc); } }
    }
    async saveCustomDocument(doc: ProtectedDocument, token: vscode.CancellationToken): Promise<void> {
        this.check(doc, token);
        await this.flush(doc);
        if (doc.saving) { throw new Error('A save is already in progress.'); }
        doc.saving = true;
        const version = doc.version;
        const written = doc.text;
        try {
            const revision = await this.provider.writeDocument(doc.uri, doc.text, doc.revision);
            this.check(doc); doc.revision = revision; doc.savedText = written;
            if (version !== doc.version || token.isCancellationRequested) { throw new Error('New edits arrived during saving. Save again.'); }
            doc.dirty = false;
            await doc.journal?.clear();
            for (const panel of doc.panels) { void panel.webview.postMessage({ type: 'status', message: 'Saved' }); }
        } finally { doc.saving = false; }
    }
    async saveCustomDocumentAs(_doc: ProtectedDocument, _destination: vscode.Uri, _token: vscode.CancellationToken): Promise<void> {
        // Deny all Save As until a destination/revision-aware encrypted copy flow is implemented.
        throw vscode.FileSystemError.NoPermissions('Save As is disabled in the protected editor. Save to the original encrypted file.');
    }
    async revertCustomDocument(doc: ProtectedDocument, token: vscode.CancellationToken): Promise<void> {
        this.check(doc, token);
        await this.flush(doc);
        if (doc.saving) { throw new Error('Wait for the current save.'); }
        const version = doc.version;
        const snapshot = await this.provider.readDocument(doc.uri);
        this.check(doc, token);
        if (version !== doc.version) { snapshot.text = ''; throw new Error('New edits arrived during reverting. Retry.'); }
        doc.text = snapshot.text; doc.savedText = snapshot.text; doc.eol = preferredEol(snapshot.text); doc.revision = snapshot.revision; doc.version++; doc.dirty = false;
        await doc.journal?.clear();
        for (const panel of doc.panels) { this.refreshers.get(panel)?.(); }
    }
    async backupCustomDocument(doc: ProtectedDocument, _context: vscode.CustomDocumentBackupContext, token: vscode.CancellationToken): Promise<vscode.CustomDocumentBackup> {
        this.check(doc, token);
        await this.flush(doc);
        const backup = await this.provider.createBackup(doc.uri, doc.text, doc.revision);
        // A new encrypted backup is valid even if cancellation arrives during the write.
        return { id: `${doc.uri.authority}:${backup}`, delete: () => { void this.provider.deleteBackup(doc.uri, backup).catch(() => {}); } };
    }
    dispose(): void {
        for (const doc of [...this.documents.values()]) { doc.dispose(); }
        for (const pending of this.snapshots.values()) { clearTimeout(pending.timer); pending.reject(new Error('Editor closed.')); }
        this.snapshots.clear(); this.renderers.clear(); this.refreshers.clear(); this.events.dispose();
    }
}
