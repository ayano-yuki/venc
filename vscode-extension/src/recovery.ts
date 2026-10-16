import * as vscode from 'vscode';
import * as path from 'node:path';
import { BackupInfo, VaultProvider } from './vaultProvider';
import { PROTECTED_EDITOR } from './protectedEditor';

export function validateRelativePath(value: string): string | undefined {
    return !value || Buffer.byteLength(value) > 4096 || /[\\\0:]/.test(value)
        || value.split('/').some(p => !p || p === '.' || p === '..') ? 'Enter a relative vault path without empty, . or .. components.' : undefined;
}
export async function recoverDrafts(provider: VaultProvider, root: vscode.Uri): Promise<void> {
    let after = '';
    for (;;) {
        const page = await provider.listBackups(root, after);
        if (page.invalid) { void vscode.window.showWarningMessage(`${page.invalid} draft(s) could not be authenticated. They were kept unchanged.`); }
        const items: { label: string; description?: string; backup?: BackupInfo; more?: boolean }[] = page.entries.map(backup => ({
            label: backup.path, description: `${new Date(backup.modified).toLocaleString()} · ${backup.size} bytes`, backup,
        }));
        if (page.next) { items.push({ label: 'Load next page of encrypted drafts…', more: true }); }
        if (!items.length) { void vscode.window.showInformationMessage('No recoverable encrypted drafts on this page.'); return; }
        const selected = await vscode.window.showQuickPick(items, { placeHolder: 'Choose an encrypted draft to recover or discard' });
        if (!selected) { return; }
        if (selected.more) { after = page.next!; continue; }
        const backup = selected.backup!;
        const action = await vscode.window.showQuickPick(['Recover as a new encrypted file', 'Delete this encrypted draft'], { placeHolder: backup.path });
        if (!action) { return; }
        if (action === 'Delete this encrypted draft') {
            const consent = await vscode.window.showWarningMessage('Permanently delete this encrypted draft?', { modal: true }, 'Delete Draft');
            if (consent === 'Delete Draft') { await provider.deleteBackup(root, backup.id); }
            return;
        }
        const name = path.posix.basename(backup.path);
        const target = await vscode.window.showInputBox({ prompt: 'New encrypted file path; existing files will never be overwritten',
            value: `Recovered/${backup.id.slice(0, 8)}-${name}`, validateInput: validateRelativePath });
        if (target === undefined) { return; }
        const invalid = validateRelativePath(target); if (invalid) { throw new Error(invalid); }
        const uri = root.with({ path: '/' + target });
        await provider.recoverBackup(uri, backup.id);
        void vscode.window.showInformationMessage('Draft recovered as a new encrypted file. The original draft was retained.');
        await vscode.commands.executeCommand('vscode.openWith', uri, PROTECTED_EDITOR);
        return;
    }
}
