import * as vscode from 'vscode';
import { randomBytes } from 'node:crypto';
import { VaultProvider, SCHEME } from './vaultProvider';

export const PROTECTED_EDITOR = 'venc.protectedEditor';
const MAX_TEXT = 16 * 1024 * 1024;
export class ProtectedDocument implements vscode.CustomDocument {
    readonly panels = new Set<vscode.WebviewPanel>();
    version = 0;
    dirty: boolean;
    active = true;
    saving = false;
    constructor(readonly uri: vscode.Uri, public text: string, public revision: string, restored: boolean,
        private readonly remove: () => void) { this.dirty = restored; }
    dispose(): void {
        if (!this.active) { return; }
        this.active = false; this.text = ''; this.revision = '';
        for (const panel of this.panels) { void panel.webview.postMessage({ type: 'clear' }); panel.dispose(); }
        this.panels.clear(); this.remove();
    }
}
export class ProtectedEditor implements vscode.CustomEditorProvider<ProtectedDocument>, vscode.Disposable {
    private readonly events = new vscode.EventEmitter<vscode.CustomDocumentContentChangeEvent<ProtectedDocument>>();
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
        this.documents.set(uri.toString(), doc);
        return doc;
    }
    // The webview sends contents only in IPC messages, never HTML or persistent webview state.
    update(doc: ProtectedDocument, text: string): void {
        this.check(doc);
        if (typeof text !== 'string' || text.length > MAX_TEXT || Buffer.byteLength(text) > MAX_TEXT || text.includes('\0')) {
            throw vscode.FileSystemError.NoPermissions('Text must be UTF-8, without NUL bytes, and at most 16 MiB.');
        }
        doc.text = text; doc.version++; doc.dirty = true;
        this.events.fire({ document: doc });
    }
    resolveCustomEditor(doc: ProtectedDocument, panel: vscode.WebviewPanel): void {
        this.check(doc); doc.panels.add(panel);
        panel.webview.options = { enableScripts: true, localResourceRoots: [] };
        const nonce = randomBytes(24).toString('base64');
        panel.webview.html = `<!doctype html><html><head><meta charset="utf-8">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; script-src 'nonce-${nonce}'; style-src 'nonce-${nonce}'; form-action 'none'; base-uri 'none';">
<style nonce="${nonce}">body{margin:0;padding:12px;color:var(--vscode-editor-foreground);background:var(--vscode-editor-background);font-family:var(--vscode-font-family)}textarea{box-sizing:border-box;width:100%;height:calc(100vh - 65px);resize:none;color:inherit;background:inherit;border:1px solid var(--vscode-input-border);font-family:var(--vscode-editor-font-family);font-size:var(--vscode-editor-font-size);white-space:pre;tab-size:4}p{margin:0 0 10px}#status{font-size:12px}</style></head>
<body><p>Protected UTF-8 editor · Ctrl/Cmd+S to save · backups are encrypted</p><textarea id="text" spellcheck="false" aria-label="Vault document" disabled></textarea><p id="status" role="status">Loading…</p>
<script nonce="${nonce}">
const api=acquireVsCodeApi(),text=document.getElementById('text'),status=document.getElementById('status');
let sequence=0,epoch=0,accepted='';
window.addEventListener('message',event=>{const m=event.data;if(m.type==='load'){epoch=m.epoch;sequence=0;text.value=m.text;accepted=m.text;text.disabled=false;status.textContent=m.dirty?'Unsaved changes':'Saved';}else if(m.type==='status'){status.textContent=m.message;}else if(m.type==='clear'){text.value='';accepted='';text.disabled=true;status.textContent='Vault locked';}});
text.addEventListener('input',()=>{if(new TextEncoder().encode(text.value).length>16777216){text.value=accepted;status.textContent='Edit rejected: file exceeds 16 MiB.';return;}accepted=text.value;api.postMessage({type:'edit',text:text.value,epoch,sequence:++sequence});status.textContent='Unsaved changes';});
text.addEventListener('keydown',event=>{if((event.ctrlKey||event.metaKey)&&event.key.toLowerCase()==='s'){event.preventDefault();api.postMessage({type:'save'});}});
api.postMessage({type:'ready'});
</script></body></html>`;
        let sequence = 0;
        let epoch = 0;
        const send = () => { sequence = 0; epoch++; void panel.webview.postMessage({ type: 'load', text: doc.text, dirty: doc.dirty, epoch }); };
        const listener = panel.webview.onDidReceiveMessage(async (message: unknown) => {
            if (!doc.active || !message || typeof message !== 'object') { return; }
            const m = message as Record<string, unknown>;
            try {
                if (m.type === 'ready') { send(); }
                else if (m.type === 'edit' && m.epoch === epoch && Number.isSafeInteger(m.sequence) && (m.sequence as number) > sequence && typeof m.text === 'string') {
                    this.update(doc, m.text); sequence = m.sequence as number;
                } else if (m.type === 'save') { await this.saveViaWorkbench(doc); }
            } catch (error) {
                void panel.webview.postMessage({ type: 'status', message: error instanceof Error ? error.message : 'Operation failed' });
            }
        });
        const disposed = panel.onDidDispose(() => { listener.dispose(); disposed.dispose(); doc.panels.delete(panel); });
        // Refresh on Revert only; saves must not replace text typed during an in-flight save.
        this.refreshers.set(panel, send);
        panel.onDidDispose(() => this.refreshers.delete(panel));
    }
    private readonly refreshers = new Map<vscode.WebviewPanel, () => void>();
    async saveViaWorkbench(doc: ProtectedDocument): Promise<void> {
        this.check(doc);
        await vscode.commands.executeCommand('vscode.openWith', doc.uri, PROTECTED_EDITOR);
        const input = vscode.window.tabGroups.activeTabGroup.activeTab?.input;
        if (!(input instanceof vscode.TabInputCustom) || input.uri.toString() !== doc.uri.toString() || input.viewType !== PROTECTED_EDITOR) {
            throw new Error('Focus the protected editor and save it before locking.');
        }
        await vscode.commands.executeCommand('workbench.action.files.save');
        if (doc.dirty) { throw new Error('Save failed or more edits arrived. Vault remains open.'); }
    }
    async saveAll(authority: string): Promise<void> {
        for (const doc of this.documents.values()) { if (doc.uri.authority === authority && doc.dirty) { await this.saveViaWorkbench(doc); } }
    }
    async saveCustomDocument(doc: ProtectedDocument, token: vscode.CancellationToken): Promise<void> {
        this.check(doc, token);
        if (doc.saving) { throw new Error('A save is already in progress.'); }
        doc.saving = true;
        const version = doc.version;
        try {
            const revision = await this.provider.writeDocument(doc.uri, doc.text, doc.revision);
            this.check(doc); doc.revision = revision;
            if (version !== doc.version || token.isCancellationRequested) { throw new Error('New edits arrived during saving. Save again.'); }
            doc.dirty = false;
            for (const panel of doc.panels) { void panel.webview.postMessage({ type: 'status', message: 'Saved' }); }
        } finally { doc.saving = false; }
    }
    async saveCustomDocumentAs(_doc: ProtectedDocument, _destination: vscode.Uri, _token: vscode.CancellationToken): Promise<void> {
        // Deny all Save As until a destination/revision-aware encrypted copy flow is implemented.
        throw vscode.FileSystemError.NoPermissions('Save As is disabled in the protected editor. Save to the original encrypted file.');
    }
    async revertCustomDocument(doc: ProtectedDocument, token: vscode.CancellationToken): Promise<void> {
        this.check(doc, token);
        if (doc.saving) { throw new Error('Wait for the current save.'); }
        const version = doc.version;
        const snapshot = await this.provider.readDocument(doc.uri);
        this.check(doc, token);
        if (version !== doc.version) { snapshot.text = ''; throw new Error('New edits arrived during reverting. Retry.'); }
        doc.text = snapshot.text; doc.revision = snapshot.revision; doc.version++; doc.dirty = false;
        for (const panel of doc.panels) { this.refreshers.get(panel)?.(); }
    }
    async backupCustomDocument(doc: ProtectedDocument, _context: vscode.CustomDocumentBackupContext, token: vscode.CancellationToken): Promise<vscode.CustomDocumentBackup> {
        this.check(doc, token);
        const backup = await this.provider.createBackup(doc.uri, doc.text, doc.revision);
        // A new encrypted backup is valid even if cancellation arrives during the write.
        return { id: `${doc.uri.authority}:${backup}`, delete: () => { void this.provider.deleteBackup(doc.uri, backup).catch(() => {}); } };
    }
    dispose(): void {
        for (const doc of [...this.documents.values()]) { doc.dispose(); }
        this.refreshers.clear(); this.events.dispose();
    }
}
