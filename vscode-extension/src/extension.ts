import * as vscode from 'vscode';
import * as path from 'node:path';
import { homedir } from 'node:os';
import { access, realpath, stat } from 'node:fs/promises';
import { constants } from 'node:fs';
import { CoreClient } from './coreClient';
import { VaultProvider, SCHEME } from './vaultProvider';
import { ProtectedEditor, PROTECTED_EDITOR } from './protectedEditor';
import { VaultImporter } from './importFiles';
import { VaultActions } from './vaultActions';
import { recoverDrafts } from './recovery';
import { ProtectedFiles, VaultRoot } from './protectedFiles';

interface Mount { client: CoreClient; root: vscode.Uri; name: string; capabilities: string[] }
interface Opened { vaultId: string; protocol: number; capabilities?: string[] }
const mounts = new Map<string, Mount>();
let provider: VaultProvider;
let status: vscode.StatusBarItem;
let protectedEditor: ProtectedEditor;
let protectedFiles: ProtectedFiles;
let vaultRoots: () => VaultRoot[] = () => [];
let plaintextAccess = false;
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
function dirtyFor(authority: string): (vscode.TextDocument | vscode.NotebookDocument)[] {
    return [...vscode.workspace.textDocuments, ...vscode.workspace.notebookDocuments]
        .filter(document => owned(document.uri, authority) && document.isDirty);
}
function locations(context: vscode.ExtensionContext): Record<string, string> {
    const saved = context.globalState.get<unknown>('vaultLocations');
    if (!saved || typeof saved !== 'object' || Array.isArray(saved)) { return {}; }
    return Object.fromEntries(Object.entries(saved).filter(([id, value]) => /^[a-f0-9]{32}$/.test(id) && typeof value === 'string' && path.isAbsolute(value)));
}
function sidebarRoots(context: vscode.ExtensionContext): VaultRoot[] {
    const roots = new Map<string, VaultRoot>();
    for (const [authority, location] of Object.entries(locations(context))) {
        roots.set(authority, { uri: vscode.Uri.from({ scheme: SCHEME, authority, path: '/' }), name: path.basename(location), locked: true });
    }
    for (const folder of vscode.workspace.workspaceFolders ?? []) {
        if (folder.uri.scheme === SCHEME && /^[a-f0-9]{32}$/.test(folder.uri.authority)) {
            roots.set(folder.uri.authority, { uri: folder.uri.with({ path: '/', query: '', fragment: '' }), name: folder.name.replace(/^venc: /, ''), locked: true });
        }
    }
    for (const [authority, mount] of mounts) { roots.set(authority, { uri: mount.root, name: mount.name, locked: false }); }
    return [...roots.values()];
}
function selectedVault(value: unknown): vscode.Uri {
    const uri = value instanceof vscode.Uri ? value : value && typeof value === 'object' && 'uri' in value ? value.uri : undefined;
    if (!(uri instanceof vscode.Uri) || uri.scheme !== SCHEME || !/^[a-f0-9]{32}$/.test(uri.authority)
        || uri.path !== '/' || uri.query || uri.fragment) { throw new Error('Choose a vault in the venc sidebar.'); }
    return uri;
}
function updateStatus(): void {
    const locked = vaultRoots().filter(root => root.locked).length;
    status.text = busy ? '$(sync~spin) venc' : `$(lock) venc: ${mounts.size} open${locked ? ` / ${locked} locked` : ''}`;
    status.tooltip = busy ? 'Vault operation in progress' : `Editor mode: ${plaintextAccess ? 'Standard (compatibility; plaintext access allowed)' : 'Protected (encrypted drafts)'}. Click to manage vaults.`;
    protectedFiles?.refresh();
    status.command = mounts.size ? 'venc.lockVault' : 'venc.openVault';
    status.show();
    void vscode.commands.executeCommand('setContext', 'venc.hasUnlockedVault', mounts.size > 0);
}
async function safetySettings(uri?: vscode.Uri): Promise<boolean> {
    if (!plaintextAccess) { return true; }
    const safe = () => vscode.workspace.getConfiguration('files', uri).get('hotExit') === 'off'
        && vscode.workspace.getConfiguration('workbench.localHistory', uri).get('enabled') === false;
    if (safe()) { return true; }
    const choice = await vscode.window.showWarningMessage(
        'Disable Hot Exit and Local History before editing vaults? This changes user settings for other files too. Background crash backups can still contain plaintext.',
        { modal: true }, 'Disable and Continue');
    if (choice !== 'Disable and Continue') { return false; }
    await vscode.workspace.getConfiguration('files').update('hotExit', 'off', vscode.ConfigurationTarget.Global);
    await vscode.workspace.getConfiguration('workbench.localHistory').update('enabled', false, vscode.ConfigurationTarget.Global);
    if (!safe()) { throw new Error('Workspace settings override the required settings. Set files.hotExit to off and workbench.localHistory.enabled to false.'); }
    return true;
}
interface Passwords { passwordA: string; passwordB: string }
function release(secret: Passwords): void { secret.passwordA = ''; secret.passwordB = ''; }
async function passwords(confirm: boolean, label = 'Vault'): Promise<Passwords | undefined> {
    const ask = (prompt: string) => vscode.window.showInputBox({ prompt, password: true, ignoreFocusOut: true,
        validateInput: value => !value || Buffer.byteLength(value) > 4096 ? 'Enter a password (maximum 4096 bytes).' : undefined });
    const passwordA = await ask(`${label} password A`); if (passwordA === undefined) { return; }
    const passwordB = await ask(`${label} password B`); if (passwordB === undefined) { return; }
    if (confirm) {
        const a = await ask('Confirm password A'); if (a === undefined) { return; }
        const b = await ask('Confirm password B'); if (b === undefined) { return; }
        if (a !== passwordA || b !== passwordB) { throw new Error('Password confirmation did not match.'); }
    }
    return { passwordA, passwordB };
}
async function executable(context: vscode.ExtensionContext): Promise<string> {
    const configured = vscode.workspace.getConfiguration('venc').get<string>('corePath', '');
    const candidate = configured || path.join(context.extensionPath, 'bin', process.platform === 'win32' ? 'venc.exe' : 'venc');
    if (!path.isAbsolute(candidate)) { throw new Error('venc.corePath must be an absolute path.'); }
    try {
        const binary = await realpath(candidate);
        if (!(await stat(binary)).isFile()) { throw new Error('not a file'); }
        await access(binary, process.platform === 'win32' ? constants.F_OK : constants.X_OK);
        return binary;
    } catch { throw new Error('Build the Rust core and set venc.corePath to its absolute executable path, or install a VSIX with a bundled core.'); }
}
async function chooseAuthority(context: vscode.ExtensionContext, activeOnly: boolean): Promise<string | undefined> {
    const saved = locations(context);
    const ids = activeOnly ? [...mounts.keys()] : [...new Set([...Object.keys(saved), ...mounts.keys()])];
    if (!ids.length) { void vscode.window.showInformationMessage('No vaults available. Use venc: Open Vault or Create Vault.'); return; }
    if (ids.length === 1) { return ids[0]; }
    const choice = await vscode.window.showQuickPick(ids.map(id => ({
        label: mounts.get(id)?.name ?? path.basename(saved[id] ?? id),
        description: mounts.has(id) ? 'Unlocked' : 'Locked', detail: saved[id] ?? id, id,
    })), { placeHolder: 'Choose a vault' });
    return choice?.id;
}
async function open(context: vscode.ExtensionContext, create: boolean, knownPath?: string, expectedAuthority?: string): Promise<void> {
    if (!vscode.workspace.isTrusted) { throw new Error('Trust this workspace before opening a vault.'); }
    let vault = knownPath;
    if (!vault) {
        const selected = await vscode.window.showOpenDialog({ canSelectFolders: true, canSelectFiles: false, canSelectMany: false,
            defaultUri: vscode.Uri.file(homedir()), openLabel: create ? 'Select parent directory' : 'Open Vault' });
        if (!selected?.length) { return; }
        if (selected[0].scheme !== 'file' && selected[0].scheme !== 'vscode-remote') { throw new Error('Choose a vault on the extension host filesystem.'); }
        vault = selected[0].fsPath;
        if (create) {
            const name = await vscode.window.showInputBox({ prompt: 'New vault directory name', validateInput: value =>
                !value || value === '.' || value === '..' || /[\\/\0:]/.test(value) ? 'Enter a directory name.' : undefined });
            if (!name) { return; }
            vault = path.join(vault, name);
        }
    }
    const binary = await executable(context); // Report setup errors before asking for secrets.
    const safetyUri = expectedAuthority ? vscode.Uri.from({ scheme: SCHEME, authority: expectedAuthority, path: '/' }) : undefined;
    if (!await safetySettings(safetyUri)) { return; }
    const accepted = !plaintextAccess ? 'Continue' : await vscode.window.showWarningMessage(
        'The standard VS Code editor can write plaintext crash backups even with Hot Exit disabled. Use a profile with appropriately protected storage.',
        { modal: true }, 'Continue');
    if (accepted !== 'Continue') { return; }
    let client: CoreClient | undefined;
    let secret: Passwords | undefined;
    try {
        client = new CoreClient(binary);
        try {
            const hello = await client.request<{ protocol: number; capabilities?: string[] }>('hello', {});
            if (!hello || hello.protocol !== 1 || (hello.capabilities !== undefined && (!Array.isArray(hello.capabilities) || hello.capabilities.some(c => typeof c !== 'string')))
                || (!plaintextAccess && !hello.capabilities?.includes('protectedEditor'))) { throw new Error('protocol mismatch'); }
        } catch { throw new Error('The executable does not support the current venc protocol. Update the Rust core before entering passwords.'); }
        secret = await passwords(create); if (!secret) { return; }
        let result: Opened;
        try {
            result = await vscode.window.withProgress({ location: vscode.ProgressLocation.Notification, title: create ? 'Creating vault…' : 'Unlocking vault…' },
                () => client!.request<Opened>(create ? 'init' : 'unlock', { vault, ...secret }));
        } finally { release(secret); }
        if (!result || result.protocol !== 1 || !/^[a-f0-9]{32}$/.test(result.vaultId)
            || (result.capabilities !== undefined && (!Array.isArray(result.capabilities) || result.capabilities.some(item => typeof item !== 'string')))
            || (!plaintextAccess && !result.capabilities?.includes('protectedEditor'))) {
            throw new Error('Unsupported core protocol. Update the Rust core and extension together.');
        }
        const authority = result.vaultId;
        if (expectedAuthority && expectedAuthority !== authority) { throw new Error('The vault at this location has a different identity. Use Open Another Vault to open it explicitly.'); }
        if (mounts.has(authority)) { throw new Error('Vault is already open.'); }
        const root = vscode.Uri.from({ scheme: SCHEME, authority, path: '/' });
        if (!await safetySettings(root)) { return; }
        const canonical = await realpath(vault);
        await context.globalState.update('vaultLocations', { ...locations(context), [authority]: canonical });
        const mountedClient = client;
        const mount: Mount = { client, root, name: path.basename(canonical), capabilities: result.capabilities ?? [] };
        provider.mount(authority, client); mounts.set(authority, mount);
        client.on('closed', () => {
            if (mounts.get(authority)?.client === mountedClient) {
                protectedEditor.revoke(authority); provider.unmount(authority); mounts.delete(authority); updateStatus();
                void vscode.window.showErrorMessage(`Vault “${mount.name}” disconnected. Protected editors were closed. Changes since the last encrypted backup may be lost. Reopen the vault before restoring editors; compatibility buffers may remain.`);
            }
        });
        client = undefined; // Mount now owns it.
        if (!vscode.workspace.workspaceFolders?.some(folder => folder.uri.toString() === root.toString())) {
            if (!vscode.workspace.updateWorkspaceFolders(vscode.workspace.workspaceFolders?.length ?? 0, 0, { uri: root, name: `venc: ${mount.name}` })) {
                protectedEditor.revoke(authority); provider.unmount(authority); mounts.delete(authority); mountedClient.dispose();
                throw new Error('Cannot add the virtual workspace folder.');
            }
        }
        updateStatus();
        await vscode.commands.executeCommand('workbench.view.extension.venc');
    } finally { if (secret) { release(secret); } client?.dispose(); }
}
async function lock(authority: string): Promise<boolean> {
    const mount = mounts.get(authority); if (!mount) { return true; }
    await protectedEditor.freezeAll(authority);
    try {
    if (protectedEditor.dirty(authority) || dirtyFor(authority).length || tabsFor(authority).some(tab => tab.isDirty)) {
        const choice = await vscode.window.showWarningMessage('Save vault changes before locking?', { modal: true }, 'Save and Lock');
        if (choice !== 'Save and Lock') { return false; }
        await protectedEditor.saveAll(authority);
        for (const document of dirtyFor(authority)) {
            if (!await document.save()) { throw new Error('Save failed. Vault remains open.'); }
        }
    }
    const tabs = tabsFor(authority);
    if (protectedEditor.dirty(authority) || tabs.some(tab => tab.isDirty) || dirtyFor(authority).length) { throw new Error('Save remaining vault editors before locking.'); }
    if (tabs.length && !await vscode.window.tabGroups.close(tabs, true)) { return false; }
    if (protectedEditor.dirty(authority) || dirtyFor(authority).length || tabsFor(authority).length) { throw new Error('Vault editors changed while locking. Close or save them and retry.'); }
    protectedEditor.revoke(authority); provider.unmount(authority); mounts.delete(authority); updateStatus();
    try { await mount.client.request('lock', {}); } finally { mount.client.dispose(); }
    return true; // Keep the locked workspace URI: removing the first folder restarts the host.
    } finally { if (mounts.get(authority) === mount) { protectedEditor.resumeAll(authority); } }
}
async function checkpointDisconnect(authority: string): Promise<void> {
    const mount = mounts.get(authority); if (!mount) { return; }
    try { await protectedEditor.checkpointAll(authority); }
    catch { void vscode.window.showErrorMessage('Could not complete an encrypted draft before disconnect. The last completed drafts remain available through Recover Drafts.'); }
    if (mounts.get(authority) !== mount) { return; }
    protectedEditor.revoke(authority); provider.unmount(authority); mounts.delete(authority); mount.client.dispose();
}

function under(uri: vscode.Uri, root: vscode.Uri): boolean {
    return uri.scheme === root.scheme && uri.authority === root.authority && (uri.path === root.path || uri.path.startsWith(root.path.replace(/\/$/, '') + '/'));
}
async function closeForMutation(uri: vscode.Uri): Promise<void> {
    const authority = uri.authority;
    await protectedEditor.freezeAll(authority);
    try {
        const docs = [...protectedEditor.documents.values()].filter(doc => under(doc.uri, uri));
        const native = dirtyFor(authority).filter(doc => under(doc.uri, uri));
        if (docs.some(doc => doc.dirty) || native.length) {
            const choice = await vscode.window.showWarningMessage('Save and close affected editors before changing this path?', { modal: true }, 'Save and Close');
            if (choice !== 'Save and Close') { throw new Error('Operation cancelled; vault files were unchanged.'); }
            for (const doc of docs) { if (doc.dirty) { await protectedEditor.saveViaWorkbench(doc); } }
            for (const doc of native) { if (!await doc.save()) { throw new Error('Save failed; path unchanged.'); } }
        }
        const tabs = tabsFor(authority).filter(tab => tabUris(tab).some(target => under(target, uri)));
        if (tabs.some(tab => tab.isDirty) || (tabs.length && !await vscode.window.tabGroups.close(tabs, true))) { throw new Error('Close cancelled; path unchanged.'); }
        if (tabsFor(authority).some(tab => tabUris(tab).some(target => under(target, uri)))) { throw new Error('An affected editor remains open; path unchanged.'); }
        for (const doc of docs) { if (doc.dirty) { throw new Error('Unsaved editor remains; path unchanged.'); } doc.dispose(); }
    } finally { protectedEditor.resumeAll(authority); }
}
async function changePasswords(context: vscode.ExtensionContext): Promise<void> {
    const authority = await chooseAuthority(context, true); if (!authority) { return; }
    const mount = mounts.get(authority)!;
    if (!mount.capabilities.includes('changePasswords')) { throw new Error('Update the Rust core to support password changes in VS Code.'); }
    const old = await passwords(false, 'Current'); if (!old) { return; }
    let next: Passwords | undefined;
    try {
        next = await passwords(true, 'New'); if (!next) { return; }
        await vscode.window.withProgress({ location: vscode.ProgressLocation.Notification, title: 'Changing vault passwords…' }, () =>
            mount.client.request('changePasswords', { oldA: old.passwordA, oldB: old.passwordB, newA: next!.passwordA, newB: next!.passwordB }));
    } finally { release(old); if (next) { release(next); } }
    void vscode.window.showInformationMessage('Vault passwords changed. Older vault backups still work with their older passwords.');
}
export async function activate(context: vscode.ExtensionContext): Promise<void> {
    busy = false;
    plaintextAccess = vscode.workspace.getConfiguration('venc').get<boolean>('allowPlaintextAccess', false) === true;
    provider = new VaultProvider(SCHEME, () => plaintextAccess);
    protectedEditor = new ProtectedEditor(provider);
    provider.guardMutation = uri => protectedEditor.guardMutation(uri);
    vaultRoots = () => sidebarRoots(context);
    protectedFiles = new ProtectedFiles(provider, vaultRoots);
    context.subscriptions.push(protectedEditor, protectedFiles,
        vscode.window.registerCustomEditorProvider(PROTECTED_EDITOR, protectedEditor, { supportsMultipleEditorsPerDocument: false, webviewOptions: { retainContextWhenHidden: true } }),
        vscode.commands.registerCommand('venc.openVaultFile', async (uri?: vscode.Uri) => {
            try {
                if (!uri || uri.scheme !== SCHEME) { throw new Error('Choose a vault file.'); }
                await vscode.commands.executeCommand(plaintextAccess ? 'vscode.open' : 'vscode.openWith', uri, ...(plaintextAccess ? [] : [PROTECTED_EDITOR]));
            } catch (error) { void vscode.window.showErrorMessage(error instanceof Error ? error.message : 'Cannot open vault file.'); }
        }),
        vscode.commands.registerCommand('venc.openProtectedFile', async (uri?: vscode.Uri) => {
            try {
                if (!uri || uri.scheme !== SCHEME) { throw new Error('Choose a file in the Protected Files view or the vault Explorer context menu.'); }
                await vscode.commands.executeCommand('vscode.openWith', uri, PROTECTED_EDITOR);
            } catch (error) { void vscode.window.showErrorMessage(error instanceof Error ? error.message : 'Cannot open protected file.'); }
        }));
    status = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, 10);
    status.name = 'venc Vaults';
    context.subscriptions.push(status, provider, vscode.workspace.registerFileSystemProvider(SCHEME, provider, { isCaseSensitive: true, isReadonly: false }));
    const command = (name: string, action: (value?: unknown) => Promise<unknown>) => context.subscriptions.push(vscode.commands.registerCommand(name, async (value?: unknown) => {
        if (busy) { void vscode.window.showInformationMessage('Finish or cancel the current vault operation before starting another.'); return; }
        busy = true; updateStatus();
        try { await action(value); } catch (error) { void vscode.window.showErrorMessage(error instanceof Error ? error.message : 'Vault operation failed.'); }
        finally { busy = false; updateStatus(); }
    }));
    const actions = new VaultActions(provider, async () => {
        const authority = await chooseAuthority(context, true); return authority ? mounts.get(authority)?.root : undefined;
    }, async uri => { await vscode.commands.executeCommand(plaintextAccess ? 'vscode.open' : 'vscode.openWith', uri, ...(plaintextAccess ? [] : [PROTECTED_EDITOR])); }, closeForMutation);
    const importer = new VaultImporter(provider, actions);
    context.subscriptions.push(vscode.window.createTreeView('venc.protectedFiles', { treeDataProvider: protectedFiles, dragAndDropController: importer }));
    command('venc.importFiles', value => importer.select(value));
    command('venc.selectEditorMode', async () => {
        const mode = await vscode.window.showQuickPick([
            { label: 'Protected editor', description: 'Encrypted drafts; no standard text model or plaintext filesystem reads', plaintext: false },
            { label: 'Standard editor (compatibility)', description: 'Native editor features; plaintext backups and access by other extensions are possible', plaintext: true },
        ], { placeHolder: `Current mode: ${plaintextAccess ? 'Standard editor (compatibility)' : 'Protected editor'}` });
        if (!mode || mode.plaintext === plaintextAccess) { return; }
        if (mode.plaintext && await vscode.window.showWarningMessage('Compatibility mode permits plaintext access by the standard editor and other extensions, and plaintext crash backups. Enable it?', { modal: true }, 'Enable Compatibility') !== 'Enable Compatibility') { return; }
        for (const authority of [...mounts.keys()]) { if (!await lock(authority)) { return; } }
        await vscode.workspace.getConfiguration('venc').update('allowPlaintextAccess', mode.plaintext, vscode.ConfigurationTarget.Global);
        void vscode.window.showInformationMessage('Editor mode changed. Unlock a vault to continue.');
    });
    command('venc.newFile', value => actions.create(value, false));
    command('venc.newFolder', value => actions.create(value, true));
    command('venc.renameEntry', value => actions.rename(value));
    command('venc.deleteEntry', value => actions.delete(value));
    command('venc.recoverDrafts', async () => {
        const authority = await chooseAuthority(context, true); if (!authority) { return; }
        if (!mounts.get(authority)!.capabilities.includes('draftRecovery')) { throw new Error('Update the Rust core to support encrypted draft recovery.'); }
        await recoverDrafts(provider, mounts.get(authority)!.root);
    });
    command('venc.createVault', () => open(context, true));
    command('venc.unlockVault', async value => {
        const uri = selectedVault(value);
        if (mounts.has(uri.authority)) { return; }
        const location = locations(context)[uri.authority];
        if (!location) { throw new Error('This vault location is not remembered. Use venc: Open Another Vault to locate it.'); }
        await open(context, false, location, uri.authority);
    });
    command('venc.lockSelectedVault', async value => { await lock(selectedVault(value).authority); });
    context.subscriptions.push(vscode.commands.registerCommand('venc.refreshVaults', () => protectedFiles.refresh()));
    command('venc.openAnotherVault', () => open(context, false));
    command('venc.openVault', async () => {
        const saved = locations(context);
        const locked = vscode.workspace.workspaceFolders?.filter(folder => folder.uri.scheme === SCHEME && !mounts.has(folder.uri.authority)) ?? [];
        if (locked.length) {
            const choice = locked.length === 1 ? locked[0] : await vscode.window.showQuickPick(locked.map(folder => ({ label: folder.name, folder })), { placeHolder: 'Choose a locked vault' }).then(item => item?.folder);
            if (!choice) { return; }
            await open(context, false, saved[choice.uri.authority], choice.uri.authority);
        } else { await open(context, false); }
    });
    command('venc.lockVault', async () => { const authority = await chooseAuthority(context, true); if (authority) { await lock(authority); } });
    command('venc.lockAllVaults', async () => { for (const authority of [...mounts.keys()]) { if (!await lock(authority)) { break; } } });
    command('venc.changePasswords', () => changePasswords(context));
    command('venc.forgetVault', async () => {
        const authority = await chooseAuthority(context, false); if (!authority) { return; }
        if (!await lock(authority)) { return; }
        const saved = locations(context); delete saved[authority];
        await context.globalState.update('vaultLocations', saved);
        void vscode.window.showInformationMessage('Remembered vault location removed. The encrypted vault is unchanged.');
    });
    context.subscriptions.push(vscode.workspace.onDidChangeConfiguration(async event => {
        if (event.affectsConfiguration('venc.allowPlaintextAccess')) {
            for (const authority of mounts.keys()) {
                await checkpointDisconnect(authority);
            }
            plaintextAccess = vscode.workspace.getConfiguration('venc').get<boolean>('allowPlaintextAccess', false) === true;
            void vscode.window.showWarningMessage('Vaults locked after changing plaintext access. Use Recover Drafts after unlocking to restore checkpointed edits. Reopen to use the new mode. Compatibility mode exposes plaintext to editor backups and other extensions.');
            updateStatus();
        }
        if (plaintextAccess && (event.affectsConfiguration('files.hotExit') || event.affectsConfiguration('workbench.localHistory.enabled'))) {
            for (const [authority, mount] of mounts) {
                if (vscode.workspace.getConfiguration('files', mount.root).get('hotExit') !== 'off'
                    || vscode.workspace.getConfiguration('workbench.localHistory', mount.root).get('enabled') !== false) {
                    await checkpointDisconnect(authority);
                    void vscode.window.showErrorMessage('Vault locked because Hot Exit or Local History was enabled. Editor buffers may still exist; restore the settings before reopening.');
                }
            }
            updateStatus();
        }
    }), vscode.workspace.onDidChangeWorkspaceFolders(async () => {
        for (const authority of mounts.keys()) {
            if (!vscode.workspace.workspaceFolders?.some(folder => owned(folder.uri, authority))) {
                const protectedDirty = protectedEditor.dirty(authority);
                await checkpointDisconnect(authority);
                if (protectedDirty) { void vscode.window.showWarningMessage('Protected editors checkpointed after removing the vault folder. Unlock and use Recover Drafts to restore edits.'); }
                if (dirtyFor(authority).length) { void vscode.window.showWarningMessage('Vault disconnected after removing its folder. Reopen it to save remaining editor buffers.'); }
            }
        }
        updateStatus();
    }));
    updateStatus();
    if (vscode.workspace.workspaceFolders?.some(folder => folder.uri.scheme === SCHEME)) {
        void vscode.window.showInformationMessage('Vault workspace is locked.', 'Unlock').then(choice => {
            if (choice === 'Unlock') { return vscode.commands.executeCommand('venc.openVault'); }
            return undefined;
        });
    }
}
export function deactivate(): void {
    const clients = [...mounts.values()].map(mount => mount.client);
    mounts.clear();
    protectedEditor?.dispose();
    for (const client of clients) { client.dispose(); }
}
