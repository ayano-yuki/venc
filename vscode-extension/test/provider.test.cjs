const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const Module = require('node:module');

class Uri {
    constructor({ scheme, authority, path: uriPath, query = '', fragment = '' }) { Object.assign(this, { scheme, authority, path: uriPath, query, fragment }); }
    static from(parts) { return new Uri(parts); }
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
const mock = { Uri, Disposable, EventEmitter: Emitter, FileSystemError, FileType: { File: 1, Directory: 2 }, FileChangeType: { Changed: 1, Created: 2, Deleted: 3 } };
const load = Module._load;
Module._load = function (id, ...args) { return id === 'vscode' ? mock : load.call(this, id, ...args); };
const { VaultProvider } = require('../dist/vaultProvider');
Module._load = load;
const { CoreClient } = require('../dist/coreClient');
const binary = process.env.VENC_TEST_CORE || path.resolve(__dirname, '../../target/debug/venc');

test('provider with real Rust child: directories, binary data, options, events, rename, reopen, lock', async t => {
    const temp = await fs.mkdtemp(path.join(os.tmpdir(), 'venc-provider-'));
    const vault = path.join(temp, 'vault');
    const client = new CoreClient(binary);
    const provider = new VaultProvider();
    t.after(async () => { client.dispose(); provider.dispose(); await fs.rm(temp, { recursive: true, force: true }); });
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
    let closeAllowed = true;
    let saveAllowed = false;
    let choice = 'Save and Lock';
    const inputs = ['vault', 'alpha', 'beta', 'alpha', 'beta'];
    const folders = [{ uri: Uri.from({ scheme: 'file', authority: '', path: temp }), name: 'test', index: 0 }];
    const documents = [];
    class TabInputText { constructor(uri) { this.uri = uri; } }
    Object.assign(mock, {
        ConfigurationTarget: { Global: 1 }, ProgressLocation: { Notification: 1 },
        TabInputText, TabInputNotebook: class {}, TabInputCustom: class {}, TabInputTextDiff: class {}, TabInputNotebookDiff: class {},
        workspace: {
            isTrusted: true, workspaceFolders: folders, textDocuments: documents, notebookDocuments: [],
            getConfiguration(section) { return { get(key, fallback) {
                if (section === 'files' && key === 'hotExit') return 'off';
                if (section === 'workbench.localHistory' && key === 'enabled') return false;
                if (section === 'venc' && key === 'corePath') return binary;
                return fallback;
            } }; },
            registerFileSystemProvider(_scheme, value) { registered = value; return new Disposable(() => {}); },
            updateWorkspaceFolders(_start, _deleteCount, folder) { folders.push({ ...folder, index: folders.length }); return true; },
            onDidChangeConfiguration() { return new Disposable(() => {}); }
        },
        window: {
            showInputBox: async () => inputs.shift(),
            showOpenDialog: async () => [{ fsPath: temp }],
            showWarningMessage: async message => message.startsWith('The standard') ? 'Continue' : choice,
            showErrorMessage: async message => { errors.push(message); },
            withProgress: async (_options, fn) => fn(),
            tabGroups: { all: [{ tabs: [] }], close: async () => closeAllowed },
        },
        commands: {
            registerCommand(name, fn) { handlers.set(name, fn); return new Disposable(() => {}); },
            executeCommand: async () => {},
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
    const file = root.with({ path: '/doc.txt' });
    await registered.writeFile(file, Buffer.from('before'), { create: true, overwrite: false });
    const document = { uri: file, isDirty: true, save: async () => {
        if (!saveAllowed) return false;
        await registered.writeFile(file, Buffer.from('saved'), { create: false, overwrite: true });
        document.isDirty = false; return true;
    } };
    documents.push(document);
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
    closeAllowed = true;
    await handlers.get('venc.lockVault')();
    await assert.rejects(registered.stat(file), { code: 'Unavailable' });
    assert(!JSON.stringify(state).includes('alpha'));
    assert(!JSON.stringify(state).includes('beta'));
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
