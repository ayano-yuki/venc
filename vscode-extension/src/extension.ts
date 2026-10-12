import * as vscode from 'vscode';
import * as path from 'node:path';
import { access } from 'node:fs/promises';
import { constants } from 'node:fs';
import { CoreClient } from './coreClient';
import { VaultProvider, SCHEME } from './vaultProvider';

interface Mount { client: CoreClient; root: vscode.Uri }
const mounts = new Map<string, Mount>();
let provider: VaultProvider;
let busy = false;

function owned(uri: vscode.Uri, authority: string): boolean { return uri.scheme === SCHEME && uri.authority === authority; }
function tabUris(tab: vscode.Tab): vscode.Uri[] {
    const input = tab.input;
    if (input instanceof vscode.TabInputText || input instanceof vscode.TabInputNotebook || input instanceof vscode.TabInputCustom) { return [input.uri]; }
    if (input instanceof vscode.TabInputTextDiff || input instanceof vscode.TabInputNotebookDiff) { return [input.original, input.modified]; }
    return [];
}
function tabsFor(authority: string): vscode.Tab[] {
    return vscode.window.tabGroups.all.flatMap(group => group.tabs).filter(tab => tabUris(tab).some(uri => owned(uri, authority)));
}
async function safetySettings(uri?: vscode.Uri): Promise<boolean> {
    const files = vscode.workspace.getConfiguration('files', uri);
    const history = vscode.workspace.getConfiguration('workbench.localHistory', uri);
    if (files.get('hotExit') === 'off' && history.get('enabled') === false) { return true; }
    const choice = await vscode.window.showWarningMessage(
        'Vault editing requires Hot Exit and Local History to be disabled. Apply these user settings? This affects other files too.',
        { modal: true }, 'Disable and Continue');
    if (choice !== 'Disable and Continue') { return false; }
    await vscode.workspace.getConfiguration('files').update('hotExit', 'off', vscode.ConfigurationTarget.Global);
    await vscode.workspace.getConfiguration('workbench.localHistory').update('enabled', false, vscode.ConfigurationTarget.Global);
    if (vscode.workspace.getConfiguration('files', uri).get('hotExit') !== 'off'
        || vscode.workspace.getConfiguration('workbench.localHistory', uri).get('enabled') !== false) {
        throw new Error('Workspace settings override the required settings. Set files.hotExit to off and workbench.localHistory.enabled to false.');
    }
    return true;
}
async function passwords(confirm: boolean): Promise<{ passwordA: string; passwordB: string } | undefined> {
    const ask = (prompt: string) => vscode.window.showInputBox({ prompt, password: true, ignoreFocusOut: true,
        validateInput: value => !value || Buffer.byteLength(value) > 4096 ? 'Enter 1–4096 bytes.' : undefined });
    const passwordA = await ask('Vault password A'); if (passwordA === undefined) { return; }
    const passwordB = await ask('Vault password B'); if (passwordB === undefined) { return; }
    if (confirm) {
        if (await ask('Confirm password A') !== passwordA || await ask('Confirm password B') !== passwordB) {
            throw new Error('Password confirmation did not match.');
        }
    }
    return { passwordA, passwordB };
}
async function executable(context: vscode.ExtensionContext): Promise<string> {
    const configured = vscode.workspace.getConfiguration('venc').get<string>('corePath', '');
    const binary = configured || path.join(context.extensionPath, 'bin', process.platform === 'win32' ? 'venc.exe' : 'venc');
    if (!path.isAbsolute(binary)) { throw new Error('venc.corePath must be an absolute path.'); }
    await access(binary, process.platform === 'win32' ? constants.F_OK : constants.X_OK)
        .catch(() => { throw new Error('Build the Rust core and set venc.corePath to its absolute path, or package it in bin/.'); });
    return binary;
}
async function open(context: vscode.ExtensionContext, create: boolean, knownPath?: string): Promise<void> {
    if (!vscode.workspace.isTrusted) { throw new Error('Trust this workspace before opening a vault.'); }
    if (!await safetySettings()) { return; }
    const accepted = await vscode.window.showWarningMessage(
        'The standard VS Code editor can write plaintext crash backups even with Hot Exit disabled. Use a profile with appropriately protected storage.',
        { modal: true }, 'Continue');
    if (accepted !== 'Continue') { return; }
    let vault = knownPath;
    if (!vault) {
        const selected = await vscode.window.showOpenDialog({ canSelectFolders: true, canSelectFiles: false, canSelectMany: false,
            openLabel: create ? 'Select parent directory' : 'Open Vault' });
        if (!selected?.length) { return; }
        vault = selected[0].fsPath;
        if (create) {
            const name = await vscode.window.showInputBox({ prompt: 'New vault directory name', validateInput: value =>
                !value || value === '.' || value === '..' || /[\\/\0:]/.test(value) ? 'Enter a directory name.' : undefined });
            if (!name) { return; }
            vault = path.join(vault, name);
        }
    }
    const secret = await passwords(create); if (!secret) { return; }
    let client: CoreClient | undefined;
    try {
        client = new CoreClient(await executable(context));
        const result = await vscode.window.withProgress({ location: vscode.ProgressLocation.Notification, title: create ? 'Creating vault…' : 'Unlocking vault…' },
            () => client!.request<{ vaultId: string; protocol: number }>(create ? 'init' : 'unlock', { vault, ...secret }));
        if (result.protocol !== 1 || !/^[a-f0-9]{32}$/.test(result.vaultId)) { throw new Error('Unsupported core protocol.'); }
        const authority = result.vaultId;
        if (mounts.has(authority)) { throw new Error('Vault is already open.'); }
        const root = vscode.Uri.from({ scheme: SCHEME, authority, path: '/' });
        if (!await safetySettings(root)) { return; }
        const locations = context.globalState.get<Record<string, string>>('vaultLocations', {});
        await context.globalState.update('vaultLocations', { ...locations, [authority]: vault });
        provider.mount(authority, client);
        mounts.set(authority, { client, root });
        const mountedClient = client;
        client.on('closed', () => {
            if (mounts.get(authority)?.client === mountedClient) { provider.unmount(authority); mounts.delete(authority); }
        });
        client = undefined; // Mount now owns it.
        if (!vscode.workspace.workspaceFolders?.some(folder => folder.uri.toString() === root.toString())) {
            if (!vscode.workspace.updateWorkspaceFolders(vscode.workspace.workspaceFolders?.length ?? 0, 0, { uri: root, name: 'venc Vault' })) {
                provider.unmount(authority); mounts.delete(authority); mountedClient.dispose();
                throw new Error('Cannot add the virtual workspace folder.');
            }
        }
        await vscode.commands.executeCommand('workbench.view.explorer');
    } finally {
        // JavaScript strings cannot be reliably zeroized; release references promptly.
        secret.passwordA = ''; secret.passwordB = '';
        client?.dispose();
    }
}
async function lock(authority: string): Promise<void> {
    const mount = mounts.get(authority); if (!mount) { return; }
    const documents = () => vscode.workspace.textDocuments.filter(document => owned(document.uri, authority) && document.isDirty);
    if (documents().length || tabsFor(authority).some(tab => tab.isDirty)) {
        const choice = await vscode.window.showWarningMessage('Save vault changes before locking?', { modal: true }, 'Save and Lock');
        if (choice !== 'Save and Lock') { return; }
        for (const document of documents()) { if (!await document.save()) { throw new Error('Save failed. Vault remains open.'); } }
        for (const notebook of vscode.workspace.notebookDocuments.filter(document => owned(document.uri, authority) && document.isDirty)) {
            if (!await notebook.save()) { throw new Error('Notebook save failed. Vault remains open.'); }
        }
    }
    const tabs = tabsFor(authority);
    if (tabs.some(tab => tab.isDirty)) { throw new Error('Close or save remaining vault editors before locking.'); }
    if (tabs.length && !await vscode.window.tabGroups.close(tabs, true)) { return; }
    if (documents().length) { throw new Error('Vault changed while locking. Save and retry.'); }
    // Revoke the provider before the await so no new file requests can be sent.
    provider.unmount(authority); mounts.delete(authority);
    try { await mount.client.request('lock', {}); } finally { mount.client.dispose(); }
    // Keep a locked workspace URI. Removing the first folder restarts the extension host.
}
export async function activate(context: vscode.ExtensionContext): Promise<void> {
    provider = new VaultProvider();
    context.subscriptions.push(provider, vscode.workspace.registerFileSystemProvider(SCHEME, provider, { isCaseSensitive: true, isReadonly: false }));
    const command = (name: string, action: () => Promise<void>) => context.subscriptions.push(vscode.commands.registerCommand(name, async () => {
        if (busy) { return; }
        busy = true;
        try { await action(); } catch (error) { await vscode.window.showErrorMessage(error instanceof Error ? error.message : 'Vault operation failed.'); }
        finally { busy = false; }
    }));
    command('venc.createVault', () => open(context, true));
    command('venc.openVault', async () => {
        const locations = context.globalState.get<Record<string, string>>('vaultLocations', {});
        const locked = vscode.workspace.workspaceFolders?.filter(folder => folder.uri.scheme === SCHEME && !mounts.has(folder.uri.authority)) ?? [];
        if (locked.length === 1 && locations[locked[0].uri.authority]) { await open(context, false, locations[locked[0].uri.authority]); }
        else { await open(context, false); }
    });
    command('venc.lockVault', async () => {
        const authority = mounts.size === 1 ? mounts.keys().next().value : (await vscode.window.showQuickPick([...mounts.keys()], { placeHolder: 'Choose vault to lock' }));
        if (authority) { await lock(authority); }
    });
    context.subscriptions.push(vscode.workspace.onDidChangeConfiguration(event => {
        if (event.affectsConfiguration('files.hotExit') || event.affectsConfiguration('workbench.localHistory.enabled')) {
            for (const [authority, mount] of mounts) {
                if (vscode.workspace.getConfiguration('files', mount.root).get('hotExit') !== 'off'
                    || vscode.workspace.getConfiguration('workbench.localHistory', mount.root).get('enabled') !== false) {
                    provider.unmount(authority); mounts.delete(authority); mount.client.dispose();
                    void vscode.window.showErrorMessage('Vault locked because Hot Exit or Local History was enabled. Editor buffers may still exist; restore the settings before reopening.');
                }
            }
        }
    }));
    // Adding the first workspace folder can restart the extension host. Reauthenticate
    // after the restart; persist only the public vault location, never a password/key.
    if (vscode.workspace.workspaceFolders?.some(folder => folder.uri.scheme === SCHEME)) {
        void vscode.window.showInformationMessage('Vault workspace is locked.', 'Unlock').then(choice => {
            if (choice === 'Unlock') { return vscode.commands.executeCommand('venc.openVault'); }
            return undefined;
        });
    }
}
export function deactivate(): void { for (const mount of mounts.values()) { mount.client.dispose(); } mounts.clear(); }
