import * as vscode from 'vscode';
import { VaultProvider } from './vaultProvider';
import { recoverDrafts } from './recovery';
function size(bytes: number): string { return bytes < 1024 ? `${bytes} B` : bytes < 1024 * 1024 ? `${(bytes / 1024).toFixed(1)} KiB` : `${(bytes / 1024 / 1024).toFixed(1)} MiB`; }
export async function showStorage(provider: VaultProvider, root: vscode.Uri): Promise<void> {
    const info = await provider.storageInfo(root);
    if (info.missing_live_files) { throw new Error(`${info.missing_live_files} current object(s) are missing. Cleanup is disabled; restore a complete vault backup.`); }
    const message = `Encrypted storage: ${size(info.total_bytes)}\nCurrent documents: ${size(info.live_bytes)}\nEncrypted drafts: ${size(info.backup_bytes)}\nEligible old data: ${size(info.reclaimable_bytes)}\nRecent retired data (kept 24 hours): ${size(info.recent_retired_bytes)}\nUnrecognized files (kept): ${size(info.unknown_bytes)}`;
    const choice = await vscode.window.showInformationMessage(message, { modal: true }, 'Clean Up Eligible Objects', 'Recover Drafts');
    if (choice === 'Recover Drafts') { await recoverDrafts(provider, root); return; }
    if (choice !== 'Clean Up Eligible Objects') { return; }
    if (!info.reclaimable_files) { void vscode.window.showInformationMessage('No unused objects older than 24 hours. Drafts and unrecognized files are always retained.'); return; }
    if (await vscode.window.showWarningMessage('Permanently remove unused encrypted objects older than 24 hours? Current documents, encrypted drafts, and unrecognized files are retained.', { modal: true }, 'Clean Up') !== 'Clean Up') { return; }
    await vscode.window.withProgress({ location: vscode.ProgressLocation.Notification, title: 'Reclaiming encrypted storage', cancellable: true }, async (progress, token) => {
        let removed = 0, bytes = 0;
        for (;;) {
            if (token.isCancellationRequested) { break; }
            const result = await provider.collectGarbage(root);
            removed += result.removed_files; bytes += result.removed_bytes;
            progress.report({ message: `${removed} objects · ${size(bytes)} reclaimed`, increment: result.removed_files / info.reclaimable_files * 100 });
            if (!result.remaining.reclaimable_files || !result.removed_files) { break; }
        }
        void vscode.window.showInformationMessage(`Reclaimed ${size(bytes)} from ${removed} unused object(s).`);
    });
}
