import * as vscode from 'vscode';
import * as path from 'node:path';
import { open } from 'node:fs/promises';
import { constants } from 'node:fs';
import { VaultProvider } from './vaultProvider';
import { VaultActions, validateName } from './vaultActions';
import type { Node } from './protectedFiles';
const LIMIT = 16 * 1024 * 1024;
export async function readImportFile(uri: vscode.Uri): Promise<Buffer> {
    if (!['file', 'vscode-remote'].includes(uri.scheme)) { throw new Error('Only extension-host files can be imported.'); }
    const file = await open(uri.fsPath, constants.O_RDONLY | (process.platform === 'win32' ? 0 : constants.O_NOFOLLOW | constants.O_NONBLOCK));
    const bytes = Buffer.alloc(LIMIT + 1);
    try {
        const stat = await file.stat();
        if (!stat.isFile() || stat.size > LIMIT) { throw new Error('Import requires a regular file of at most 16 MiB.'); }
        let length = 0;
        while (length < bytes.length) {
            const result = await file.read(bytes, length, Math.min(1024 * 1024, bytes.length - length), null);
            if (!result.bytesRead) { break; } length += result.bytesRead;
        }
        if (length > LIMIT) { throw new Error('Source grew beyond 16 MiB; nothing was imported.'); }
        return Buffer.from(bytes.subarray(0, length));
    } finally { bytes.fill(0); await file.close(); }
}
export class VaultImporter implements vscode.TreeDragAndDropController<Node> {
    readonly dropMimeTypes = ['text/uri-list', 'files'];
    readonly dragMimeTypes: string[] = [];
    constructor(private readonly provider: VaultProvider, private readonly actions: VaultActions) {}
    async select(value?: unknown): Promise<void> {
        const folder = await this.actions.folder(value); if (!folder) { return; }
        const selected = await vscode.window.showOpenDialog({ canSelectFiles: true, canSelectFolders: false, canSelectMany: true, openLabel: 'Import into encrypted vault (originals retained)' });
        if (selected?.length) { await this.import(folder, selected); }
    }
    async handleDrop(target: Node | undefined, transfer: vscode.DataTransfer, token: vscode.CancellationToken): Promise<void> {
        if (token.isCancellationRequested) { return; }
        const uris: vscode.Uri[] = [];
        transfer.forEach(item => { const file = item.asFile(); if (file?.uri) { uris.push(file.uri); } });
        const list = transfer.get('text/uri-list');
        if (list) {
            const text = await list.asString();
            if (text.length > 1024 * 1024) { throw new Error('Too many dropped files. Import at most 100 files at a time.'); }
            for (const line of text.split(/\r?\n/).filter(l => l && !l.startsWith('#'))) { uris.push(vscode.Uri.parse(line)); }
        }
        const unique = [...new Map(uris.map(uri => [uri.toString(), uri])).values()];
        if (!unique.length) { throw new Error('This drop has no extension-host file paths. Use Import Files to choose files on the vault host.'); }
        const folder = await this.actions.folder(target); if (folder && !token.isCancellationRequested) { await this.import(folder, unique, token); }
    }
    async import(folder: vscode.Uri, sources: vscode.Uri[], outer?: vscode.CancellationToken): Promise<void> {
        if (sources.length > 100) { throw new Error('Import at most 100 files at a time.'); }
        const details = sources.map(uri => uri.fsPath).join('\n');
        const consent = await vscode.window.showWarningMessage(`Import ${sources.length} file(s) into ${folder.path}? Originals will remain unchanged. Existing vault files will not be overwritten.`,
            { modal: true, detail: details }, 'Import Files');
        if (consent !== 'Import Files') { return; }
        await vscode.window.withProgress({ location: vscode.ProgressLocation.Notification, title: 'Encrypting imported files', cancellable: true }, async (progress, token) => {
            let imported = 0; const failures: string[] = [];
            for (const uri of sources) {
                if (token.isCancellationRequested || outer?.isCancellationRequested) { break; }
                const name = path.basename(uri.fsPath);
                progress.report({ message: name, increment: 100 / sources.length });
                let bytes: Buffer | undefined;
                try {
                    const invalid = validateName(name); if (invalid) { throw new Error(invalid); }
                    bytes = await readImportFile(uri);
                    if (token.isCancellationRequested || outer?.isCancellationRequested) { break; }
                    await this.provider.importFile(vscode.Uri.joinPath(folder, name), bytes); imported++;
                } catch (error) { failures.push(`${name}: ${error instanceof Error ? error.message : 'Import failed'}`); }
                finally { bytes?.fill(0); }
            }
            const summary = `${imported}/${sources.length} file(s) imported. Originals retained.${failures.length ? ' ' + failures.slice(0, 3).join('; ') : ''}`;
            if (failures.length) { void vscode.window.showWarningMessage(summary); }
            else { void vscode.window.showInformationMessage(summary); }
        });
    }
}
