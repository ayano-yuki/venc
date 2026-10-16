const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const Module = require('node:module');

class Uri {
    constructor({ scheme, authority, path: uriPath, query = '', fragment = '' }) { Object.assign(this, { scheme, authority, path: uriPath, query, fragment }); }
    static from(parts) { return new Uri(parts); }
    static file(location) { return new Uri({ scheme: "file", authority: "", path: location }); }
    with(parts) { return new Uri({ ...this, ...parts }); }
    toString() { return `${this.scheme}://${this.authority}${this.path}`; }
}
class Disposable { constructor(fn) { this.dispose = fn; } }
class Emitter {
    listeners = [];
    event = callback => { this.listeners.push(callback); return new Disposable(() => { this.listeners = this.listeners.filter(fn => fn !== callback); }); };
    fire(value) { for (const callback of this.listeners) { callback(value); } }
    dispose() { this.listeners = []; }
}
class FileSystemError extends Error {
    constructor(code, message) { super(String(message)); this.code = code; }
}
for (const code of ['Unavailable', 'NoPermissions', 'FileNotFound', 'FileExists', 'FileNotADirectory', 'FileIsADirectory']) {
    FileSystemError[code] = message => new FileSystemError(code, message);
}
const mock = { __esModule: true, TreeItem: class { constructor(label, collapsibleState) { Object.assign(this, { label, collapsibleState }); } }, ThemeIcon: class { constructor(id) { this.id = id; } }, TreeItemCollapsibleState: { None: 0, Collapsed: 1, Expanded: 2 }, Uri, Disposable, EventEmitter: Emitter, FileSystemError, FileType: { File: 1, Directory: 2 }, FileChangeType: { Changed: 1, Created: 2, Deleted: 3 } };
const load = Module._load;
Module._load = function (id, ...args) { return id === 'vscode' ? mock : load.call(this, id, ...args); };
const { VaultProvider } = require('../dist/vaultProvider');
const { ProtectedEditor } = require('../dist/protectedEditor');
Module._load = load;
const { CoreClient } = require('../dist/coreClient');
const binary = process.env.VENC_TEST_CORE || path.resolve(__dirname, '../../target/debug', process.platform === 'win32' ? 'venc.exe' : 'venc');

test('provider with real Rust child: directories, binary data, options, events, rename, reopen, lock', async t => {
    const temp = await fs.mkdtemp(path.join(os.tmpdir(), 'venc-provider-'));
    const vault = path.join(temp, 'vault');
    const client = new CoreClient(binary);
    const provider = new VaultProvider('venc', () => true);
    t.after(async () => { client.dispose(); provider.dispose(); await fs.rm(temp, { recursive: true, force: true }); });
    const hello = await client.request('hello', {});
    assert.equal(hello.protocol, 1);
    assert.equal(client.closed, false);
    const result = await client.request('init', { vault, passwordA: 'alpha', passwordB: 'beta' });
    const root = provider.mount(result.vaultId, client);
    const uri = name => root.with({ path: '/' + name });
    const events = [];
    provider.onDidChangeFile(value => events.push(...value));
    await provider.createDirectory(uri('dir/nested'));
    await provider.createDirectory(uri('empty'));
    const bytes = Buffer.from([0, 1, 255, 10, 65]);
    await provider.writeFile(uri('dir/nested/日本語.txt'), bytes, { create: true, overwrite: false });
    assert.deepEqual(await provider.readFile(uri('dir/nested/日本語.txt')), bytes);
    assert.equal((await provider.stat(uri('dir/nested/日本語.txt'))).size, bytes.length);
    assert.deepEqual(await provider.readDirectory(root), [['dir', 2], ['empty', 2]]);
    await assert.rejects(provider.writeFile(uri('dir/nested/日本語.txt'), bytes, { create: true, overwrite: false }), { code: 'FileExists' });
    await assert.rejects(provider.writeFile(uri('missing'), bytes, { create: false, overwrite: true }), { code: 'FileNotFound' });
    await assert.rejects(provider.readFile(uri('dir')), { code: 'FileIsADirectory' });
    await assert.rejects(provider.readDirectory(uri('dir/nested/日本語.txt')), { code: 'FileNotADirectory' });
    await assert.rejects(provider.readFile(uri('../escape')), { code: 'NoPermissions' });
    await assert.rejects(provider.rename(uri('dir'), uri('dir/child'), { overwrite: false }), { code: 'NoPermissions' });
    await assert.rejects(provider.rename(uri('dir'), uri('other').with({ authority: 'other-vault' }), { overwrite: false }), { code: 'NoPermissions' });
    const eventCount = events.length;
    await provider.rename(uri('dir'), uri('dir'), { overwrite: false });
    assert.equal(events.length, eventCount);
    const before = await fs.readdir(path.join(vault, 'objects'));
    await provider.rename(uri('dir'), uri('moved'), { overwrite: false });
    assert.deepEqual(await fs.readdir(path.join(vault, 'objects')), before);
    assert.deepEqual(await provider.readFile(uri('moved/nested/日本語.txt')), bytes);
    await assert.rejects(provider.delete(uri('moved'), { recursive: false }), { code: 'NoPermissions' });
    await provider.delete(uri('moved'), { recursive: true });
    assert.deepEqual(await provider.readDirectory(root), [['empty', 2]]);
    assert(events.some(e => e.type === 2 && e.uri.path.endsWith('日本語.txt')));
    assert(events.some(e => e.type === 3 && e.uri.path === '/dir'));
    await client.request('lock', {});
    await assert.rejects(provider.stat(root), { code: 'Unavailable' });
    const reopened = new CoreClient(binary);
    t.after(() => reopened.dispose());
    await reopened.request('unlock', { vault, passwordA: 'alpha', passwordB: 'beta' });
    provider.unmount(root.authority);
    provider.mount(root.authority, reopened);
    assert.deepEqual(await provider.readDirectory(root), [['empty', 2]]);
    await reopened.request('lock', {});
});

test('client rejects failed authentication and child startup without logging secrets', async t => {
    const bad = new CoreClient(path.join(os.tmpdir(), 'venc-does-not-exist'));
    t.after(() => bad.dispose());
    await assert.rejects(bad.request('stat', { path: '' }), { code: 'Unavailable' });
    assert.equal(bad.closed, true);
});

test('dead child invalidates outstanding requests', async t => {
    const client = new CoreClient(binary);
    t.after(() => client.dispose());
    client.dispose();
    await assert.rejects(client.request('readFile', { path: 'secret' }), { code: 'Unavailable' });
});

test('extension commands: create, cancelled lock, failed save, cancelled close, successful lock', async t => {
    const temp = await fs.mkdtemp(path.join(os.tmpdir(), 'venc-commands-'));
    const handlers = new Map();
    const errors = [];
    let registered;
    let registeredProtected;
    let treeProvider;
    const executed = [];
    let compatibility = true;
    let closeAllowed = true;
    let saveAllowed = false;
    let choice = 'Save and Lock';
    const inputs = ['vault', 'alpha', 'beta', 'alpha', 'beta'];
    const notices = [];
    let configurationChanged;
    let historyEnabled = false;
    let configuredBinary = binary;
    let folderChanged;
    const status = { show() {}, dispose() {} };
    const folders = [{ uri: Uri.from({ scheme: 'file', authority: '', path: temp }), name: 'test', index: 0 }];
    const documents = [];
    class TabInputText { constructor(uri) { this.uri = uri; } }
    Object.assign(mock, {
        ConfigurationTarget: { Global: 1 }, ProgressLocation: { Notification: 1 }, StatusBarAlignment: { Left: 1 },
        TabInputText, TabInputNotebook: class {}, TabInputCustom: class extends TabInputText { constructor(uri) { super(uri); this.viewType = 'venc.protectedEditor'; } }, TabInputTextDiff: class {}, TabInputNotebookDiff: class {},
        workspace: {
            isTrusted: true, workspaceFolders: folders, textDocuments: documents, notebookDocuments: [],
            getConfiguration(section) { return { get(key, fallback) {
                if (section === 'files' && key === 'hotExit') return 'off';
                if (section === 'workbench.localHistory' && key === 'enabled') return historyEnabled;
                if (section === 'venc' && key === 'allowPlaintextAccess') return compatibility;
                if (section === 'venc' && key === 'corePath') return configuredBinary;
                return fallback;
            } }; },
            registerFileSystemProvider(_scheme, value) { registered = value; return new Disposable(() => {}); },
            updateWorkspaceFolders(_start, _deleteCount, folder) { folders.push({ ...folder, index: folders.length }); return true; },
            onDidChangeConfiguration(callback) { configurationChanged = callback; return new Disposable(() => {}); },
            onDidChangeWorkspaceFolders(callback) { folderChanged = callback; return new Disposable(() => {}); }
        },
        window: {
            showInputBox: async () => inputs.shift(),
            showOpenDialog: async () => [{ fsPath: temp, scheme: 'file' }],
            createStatusBarItem: () => status,
            registerCustomEditorProvider: (_name, value) => { registeredProtected = value; return new Disposable(() => {}); },
            createTreeView: (_id, options) => { treeProvider = options.treeDataProvider; return new Disposable(() => {}); },
            showInformationMessage: async message => { notices.push(message); },
            showWarningMessage: async message => message.startsWith('The standard') ? 'Continue' : choice,
            showErrorMessage: async message => { errors.push(message); },
            withProgress: async (_options, fn) => fn(),
            tabGroups: { all: [{ tabs: [] }], close: async () => { if (closeAllowed) mock.window.tabGroups.all[0].tabs = []; return closeAllowed; } },
        },
        commands: {
            registerCommand(name, fn) { handlers.set(name, fn); return new Disposable(() => {}); },
            executeCommand: async (...args) => { executed.push(args); },
        }
    });
    Module._load = function (id, ...args) { return id === 'vscode' ? mock : load.call(this, id, ...args); };
    const extension = require('../dist/extension');
    Module._load = load;
    const state = {};
    const context = { extensionPath: path.resolve(__dirname, '..'), subscriptions: [],
        globalState: { get: (key, fallback) => state[key] || fallback, update: async (key, value) => { state[key] = value; } } };
    t.after(async () => { extension.deactivate(); context.subscriptions.forEach(item => item.dispose()); await fs.rm(temp, { recursive: true, force: true }); });
    await extension.activate(context);
    await handlers.get('venc.createVault')();
    assert.deepEqual(errors, []);
    const root = folders[1].uri;
    assert(executed.some(args => args[0] === 'workbench.view.extension.venc'));
    const initialRoots = await treeProvider.getChildren();
    assert.equal(initialRoots.length, 1);
    assert.equal(treeProvider.getTreeItem(initialRoots[0]).contextValue, 'vencUnlockedVault');
    const file = root.with({ path: '/doc.txt' });
    await registered.writeFile(file, Buffer.from('before'), { create: true, overwrite: false });
    const document = { uri: file, isDirty: true, save: async () => {
        if (!saveAllowed) return false;
        await registered.writeFile(file, Buffer.from('saved'), { create: false, overwrite: true });
        document.isDirty = false; return true;
    } };
    documents.push(document);
    let notebookSaves = 0;
    mock.workspace.notebookDocuments.push({ uri: root.with({ path: "/notebook.ipynb" }), isDirty: true,
        save: async function () { notebookSaves++; if (saveAllowed) { this.isDirty = false; return true; } return false; } });
    mock.window.tabGroups.all[0].tabs = [{ input: new TabInputText(file), isDirty: false }];
    choice = undefined;
    await handlers.get('venc.lockVault')();
    assert.equal((await registered.stat(file)).size, 6);
    choice = 'Save and Lock';
    await handlers.get('venc.lockVault')();
    assert(errors.some(message => message.includes('Save failed')));
    assert.equal((await registered.stat(file)).size, 6);
    saveAllowed = true; closeAllowed = false;
    await handlers.get('venc.lockVault')();
    assert.equal(Buffer.from(await registered.readFile(file)).toString(), 'saved');
    assert.equal(notebookSaves, 1);
    closeAllowed = true;
    await handlers.get('venc.lockVault')();
    await assert.rejects(registered.stat(file), { code: 'Unavailable' });
    assert(!JSON.stringify(state).includes('alpha'));
    assert(!JSON.stringify(state).includes('beta'));
    assert(status.text.includes('0 open'));
    const lockedRoot = (await treeProvider.getChildren())[0];
    const lockedItem = treeProvider.getTreeItem(lockedRoot);
    assert.equal(lockedItem.contextValue, 'vencLockedVault');
    assert.equal(lockedItem.command.command, 'venc.unlockVault');
    const readDirectory = registered.readDirectory.bind(registered);
    let lockedReads = 0;
    registered.readDirectory = (...args) => { lockedReads++; return readDirectory(...args); };
    assert.deepEqual(await treeProvider.getChildren(lockedRoot), []);
    assert.equal(lockedReads, 0, 'Locked sidebar never requests decrypted file metadata');
    registered.readDirectory = readDirectory;
    inputs.push('alpha', 'beta');
    await handlers.get(lockedItem.command.command)(...lockedItem.command.arguments);
    assert.equal((await registered.stat(file)).size, 5);
    assert(status.text.includes('1 open'));
    // Confirmation cancellation releases references and leaves credentials unchanged.
    inputs.push('alpha', 'beta', 'new-a', 'new-b', undefined);
    await handlers.get('venc.changePasswords')();
    assert.equal((await registered.stat(file)).size, 5);
    inputs.push('alpha', 'beta', 'new-a', 'new-b', 'new-a', 'new-b');
    await handlers.get('venc.changePasswords')();
    assert(notices.some(message => message.includes('passwords changed')));
    await handlers.get('venc.lockAllVaults')();
    await assert.rejects(registered.stat(file), { code: 'Unavailable' });
    inputs.push('alpha', 'beta');
    await handlers.get('venc.openVault')();
    await assert.rejects(registered.stat(file), { code: 'Unavailable' });
    inputs.push('new-a', 'new-b');
    await handlers.get('venc.openVault')();
    assert.equal((await registered.stat(file)).size, 5);
    await configurationChanged({ affectsConfiguration: () => false });
    assert.equal((await registered.stat(file)).size, 5);
    historyEnabled = true;
    await configurationChanged({ affectsConfiguration: key => key === 'workbench.localHistory.enabled' });
    await assert.rejects(registered.stat(file), { code: 'Unavailable' });
    historyEnabled = false;
    // Allow EOF to release the old core's OS lock after emergency disconnect.
    await new Promise(resolve => setTimeout(resolve, 100));
    inputs.push('new-a', 'new-b');
    await handlers.get('venc.openVault')();
    assert.equal((await registered.stat(file)).size, 5);
    folders.splice(1);
    await folderChanged();
    await assert.rejects(registered.stat(file), { code: 'Unavailable' });
    await handlers.get('venc.forgetVault')();
    assert.deepEqual(state.vaultLocations, {});
    assert.deepEqual(await treeProvider.getChildren(), []);
    if (process.platform !== 'win32') {
        const incompatible = path.join(temp, 'old-core');
        await fs.writeFile(incompatible, '#!/bin/sh\nread -r line\nprintf \'{"id":1,"result":{"protocol":99},"locked":true}\\n\'\n', { mode: 0o700 });
        configuredBinary = incompatible;
        inputs.push('sensitive-a', 'sensitive-b');
        await handlers.get('venc.openAnotherVault')();
        assert.deepEqual(inputs, ['sensitive-a', 'sensitive-b']);
        assert(errors.some(message => message.includes('before entering passwords')));
    }
    compatibility = false;
    configuredBinary = binary;
    inputs.length = 0;
    await configurationChanged({ affectsConfiguration: key => key === 'venc.allowPlaintextAccess' });
    const errorsBefore = errors.length;
    inputs.push('vault-protected', 'a', 'b', 'a', 'b');
    await handlers.get('venc.createVault')();
    assert.equal(errors.length, errorsBefore, 'Protected opening needs no global history setting changes');
    const protectedRoot = folders.at(-1).uri;
    const protectedUri = protectedRoot.with({ path: '/note.txt' });
    await registered.writeFile(protectedUri, Buffer.alloc(0), { create: true, overwrite: false });
    await assert.rejects(registered.readFile(protectedUri), { code: 'NoPermissions' });
    const custom = await registeredProtected.openCustomDocument(protectedUri, {}, { isCancellationRequested: false });
    registeredProtected.update(custom, 'protected extension lifecycle');
    mock.window.tabGroups.activeTabGroup = mock.window.tabGroups.all[0];
    mock.commands.executeCommand = async (name, uri) => {
        if (name === 'vscode.openWith') {
            mock.window.tabGroups.all[0].tabs = [{ input: new mock.TabInputCustom(uri), isDirty: custom.dirty }];
            mock.window.tabGroups.activeTabGroup.activeTab = mock.window.tabGroups.all[0].tabs[0];
        } else if (name === 'workbench.action.files.save') {
            await registeredProtected.saveCustomDocument(custom, { isCancellationRequested: false });
            mock.window.tabGroups.all[0].tabs[0].isDirty = false;
        }
    };
    choice = 'Save and Lock';
    await handlers.get('venc.lockSelectedVault')({ uri: protectedRoot });
    assert.equal(errors.length, errorsBefore, JSON.stringify(errors));
    assert.equal(custom.active, false);
    assert.equal(custom.text, '');
    await assert.rejects(registered.stat(protectedUri), { code: 'Unavailable' });
    assert.equal(treeProvider.getTreeItem((await treeProvider.getChildren())[0]).contextValue, 'vencLockedVault');
    inputs.push('keep-secret-a', 'keep-secret-b');
    await handlers.get('venc.unlockVault')(protectedUri);
    assert.deepEqual(inputs, ['keep-secret-a', 'keep-secret-b'], 'Non-root sidebar targets are rejected before prompting');



});

test('timeout terminates core and rejects pending calls', { skip: process.platform === 'win32' }, async t => {
    const temp = await fs.mkdtemp(path.join(os.tmpdir(), 'venc-timeout-'));
    const script = path.join(temp, 'core');
    await fs.writeFile(script, '#!/bin/sh\ncat >/dev/null\n', { mode: 0o700 });
    const client = new CoreClient(script, 100);
    t.after(async () => { client.dispose(); await fs.rm(temp, { recursive: true, force: true }); });
    await assert.rejects(client.request('stat', { path: '' }), error => error.code === 'Unavailable' && error.message.includes('timed out'));
    assert.equal(client.closed, true);
});

test('malformed response revokes connection', { skip: process.platform === 'win32' }, async t => {
    const temp = await fs.mkdtemp(path.join(os.tmpdir(), 'venc-malformed-'));
    const script = path.join(temp, 'core');
    await fs.writeFile(script, "#!/bin/sh\nwhile IFS= read -r line; do printf 'not-json\\n'; done\n", { mode: 0o700 });
    const client = new CoreClient(script);
    t.after(async () => { client.dispose(); await fs.rm(temp, { recursive: true, force: true }); });
    await assert.rejects(client.request('stat', { path: '' }), error => error.code === 'Unavailable' && error.message.includes('Invalid core response'));
    assert.equal(client.closed, true);
});

test('revoked mount rejects an in-flight read before returning plaintext', async () => {
    const provider = new VaultProvider('venc', () => true);
    let reply;
    const client = { closed: false, request: () => new Promise(resolve => { reply = resolve; }) };
    const root = provider.mount('race', client);
    const reading = provider.readFile(root.with({ path: '/secret.txt' }));
    provider.unmount(root.authority);
    reply({ data: Buffer.from('secret').toString('base64') });
    await assert.rejects(reading, { code: 'Unavailable' });
    provider.dispose();
});

test('valid JSON with an invalid response envelope rejects immediately', { skip: process.platform === 'win32' }, async t => {
    const temp = await fs.mkdtemp(path.join(os.tmpdir(), 'venc-envelope-'));
    const script = path.join(temp, 'core');
    await fs.writeFile(script, '#!/bin/sh\nread -r line\nprintf \'{"id":1,"locked":false,"error":{"code":12}}\\n\'\nread -r line\n', { mode: 0o700 });
    const client = new CoreClient(script, 5000);
    t.after(async () => { client.dispose(); await fs.rm(temp, { recursive: true, force: true }); });
    await assert.rejects(client.request('stat', { path: '' }), error => error.message.includes('Invalid core response'));
    assert.equal(client.closed, true);
});

test('pending requests are bounded and shutdown rejects the accepted queue', { skip: process.platform === 'win32' }, async t => {
    const temp = await fs.mkdtemp(path.join(os.tmpdir(), 'venc-queue-'));
    const script = path.join(temp, 'core');
    await fs.writeFile(script, '#!/bin/sh\ncat >/dev/null\n', { mode: 0o700 });
    const client = new CoreClient(script, 5000);
    t.after(async () => { client.dispose(); await fs.rm(temp, { recursive: true, force: true }); });
    const pending = Array.from({ length: 32 }, () => client.request('stat', { path: '' }));
    const settled = Promise.allSettled(pending);
    await assert.rejects(client.request('stat', { path: '' }), error => error.message.includes('busy'));
    assert.equal(client.closed, false);
    client.dispose();
    assert((await settled).every(result => result.status === 'rejected'));
});

test('malformed file payload locks the provider instead of returning silently decoded data', async () => {
    const provider = new VaultProvider('venc', () => true);
    let closed = false;
    const client = { get closed() { return closed; }, request: async () => ({ data: '!!!!' }), dispose: () => { closed = true; } };
    const root = provider.mount('invalid-data', client);
    await assert.rejects(provider.readFile(root.with({ path: '/file' })), { code: 'Unavailable' });
    assert.equal(closed, true);
    await assert.rejects(provider.stat(root), { code: 'Unavailable' });
    provider.dispose();
});


test('protected editor: default deny, encrypted drafts, revision conflicts, Save As refusal, revoke', async t => {
    const temp = await fs.mkdtemp(path.join(os.tmpdir(), 'venc-protected-'));
    const vault = path.join(temp, 'vault');
    const client = new CoreClient(binary);
    const provider = new VaultProvider();
    const editor = new ProtectedEditor(provider);
    t.after(async () => { editor.dispose(); provider.dispose(); client.dispose(); await fs.rm(temp, { recursive: true, force: true }); });
    const opened = await client.request('init', { vault, passwordA: 'a', passwordB: 'b' });
    const root = provider.mount(opened.vaultId, client);
    const file = root.with({ path: '/protected.txt' });
    const token = { isCancellationRequested: false };
    await provider.writeFile(file, Buffer.alloc(0), { create: true, overwrite: false });
    await assert.rejects(provider.readFile(file), { code: 'NoPermissions' });
    await assert.rejects(provider.writeFile(file, Buffer.from('leak'), { create: false, overwrite: true }), { code: 'NoPermissions' });
    const doc = await editor.openCustomDocument(file, {}, token);
    const changes = [];
    editor.onDidChangeCustomDocument(event => changes.push(event));
    editor.update(doc, 'secret </script><script>leak()</script> 日本語\r\n');
    assert.equal(changes.length, 1);
    await assert.rejects(editor.saveCustomDocumentAs(doc, Uri.file(path.join(temp, 'export.txt')), token), { code: 'NoPermissions' });
    assert.equal(await fs.access(path.join(temp, 'export.txt')).then(() => true, () => false), false);
    provider.guardMutation = uri => editor.guardMutation(uri);
    await assert.rejects(provider.rename(file, file.with({ path: '/renamed' }), { overwrite: false }), { code: 'NoPermissions' });
    await assert.rejects(provider.delete(file, { recursive: false }), { code: 'NoPermissions' });
    let receive;
    let disposePanel;
    const posted = [];
    let snapshotSequence = 100;
    const panel = { webview: { options: {}, html: '',
        onDidReceiveMessage(fn) { receive = fn; return new Disposable(() => {}); },
        postMessage: async message => {
            posted.push(message);
            if (message.type === 'snapshot') {
                const load = posted.findLast(m => m.type === 'load');
                queueMicrotask(() => receive({ type: 'snapshot', request: message.request, text: doc.text, epoch: load.epoch, sequence: ++snapshotSequence }));
            }
            return true;
        } },
        onDidDispose(fn) { disposePanel = fn; return new Disposable(() => {}); },
        dispose() { disposePanel?.(); } };
    editor.resolveCustomEditor(doc, panel);
    assert(!panel.webview.html.includes('secret </script>'));
    assert(panel.webview.html.includes("default-src 'none'"));
    assert.deepEqual(panel.webview.options.localResourceRoots, []);
    assert(!panel.webview.html.includes('setState('));
    await receive({ type: 'ready' });
    const initial = posted.at(-1);
    assert.equal(initial.text, doc.text);
    const version = doc.version;
    await receive({ type: 'edit', text: 'wrong epoch', epoch: initial.epoch + 1, sequence: 1 });
    assert.equal(doc.version, version);
    await receive({ type: 'edit', text: 'invalid\0text', epoch: initial.epoch, sequence: 1 });
    assert.equal(doc.version, version);
    // Changes arriving while Rust saves must remain dirty, even if the first snapshot committed.
    const originalWrite = provider.writeDocument.bind(provider);
    provider.writeDocument = async (...args) => {
        const revision = await originalWrite(...args);
        editor.update(doc, doc.text + ' later edit');
        return revision;
    };
    await assert.rejects(editor.saveCustomDocument(doc, token), /New edits/);
    assert.equal(doc.dirty, true);
    provider.writeDocument = originalWrite;
    const destination = Uri.file(path.join(temp, 'backup-plaintext'));
    const backup = await editor.backupCustomDocument(doc, { destination }, token);
    assert.equal(await fs.access(destination.path).then(() => true, () => false), false);
    const expected = doc.text;
    doc.dispose();
    const restored = await editor.openCustomDocument(file, { backupId: backup.id }, token);
    assert.equal(restored.text, expected);
    await editor.saveCustomDocument(restored, token);
    assert.equal(restored.dirty, false);
    assert.equal((await provider.readDocument(file)).text, expected);
    const drafts = await provider.listBackups(root);
    assert(drafts.entries.some(item => backup.id.endsWith(item.id)));
    const recoveredUri = file.with({ path: '/Recovered/copy.txt' });
    await provider.recoverBackup(recoveredUri, backup.id.split(':')[1]);
    assert.equal((await provider.readDocument(recoveredUri)).text, expected);
    await assert.rejects(provider.recoverBackup(file, backup.id.split(':')[1]));
    // A restored stale backup must not overwrite a later saved revision.
    restored.dispose();
    const stale = await editor.openCustomDocument(file, { backupId: backup.id }, token);
    editor.update(stale, 'stale overwrite');
    await assert.rejects(editor.saveCustomDocument(stale, token));
    assert.equal(stale.dirty, true);
    assert.equal((await provider.readDocument(file)).text, expected);
    await editor.revertCustomDocument(stale, token);
    assert.equal(stale.dirty, false);
    editor.update(stale, 'checkpointed before disconnect');
    await editor.checkpointAll(root.authority);
    assert.equal(stale.frozen, true);
    editor.revoke(root.authority);
    const checkpointed = await provider.listBackups(root);
    assert(checkpointed.entries.length >= 1);
    let foundCheckpoint = false;
    for (const draft of checkpointed.entries) {
        if ((await provider.readDocument(file, draft.id)).text === 'checkpointed before disconnect') { foundCheckpoint = true; }
    }
    assert(foundCheckpoint, 'Encrypted checkpoint survives disposal independently of VS Code backup IDs');
    assert.equal(stale.text, '');
    assert.equal(stale.active, false);
    await assert.rejects(editor.saveCustomDocument(stale, token), { code: 'Unavailable' });
    for (const name of await fs.readdir(path.join(vault, 'objects'))) {
        assert.equal((await fs.readFile(path.join(vault, 'objects', name))).includes(Buffer.from('secret')), false);
    }
});
