const vscode = require('vscode');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { CoreClient } = require('../dist/coreClient');
const { VaultProvider } = require('../dist/vaultProvider');
const { ProtectedEditor, PROTECTED_EDITOR } = require('../dist/protectedEditor');

async function contains(directory, needle) {
    for (const item of await fs.readdir(directory, { withFileTypes: true }).catch(() => [])) {
        const location = path.join(directory, item.name);
        if (item.isDirectory()) { if (await contains(location, needle)) { return true; } }
        else if (item.isFile()) {
            const bytes = await fs.readFile(location).catch(() => Buffer.alloc(0));
            if (bytes.includes(Buffer.from(needle))) { return true; }
        }
    }
    return false;
}
exports.run = async () => {
    const temp = await fs.mkdtemp(path.join(os.tmpdir(), 'venc-protected-editor-'));
    const vault = path.join(temp, 'vault');
    const client = new CoreClient(process.env.VENC_TEST_CORE);
    const provider = new VaultProvider('venc-protected-test');
    const editor = new ProtectedEditor(provider, 'venc-protected-test');
    const subscriptions = [];
    const token = new vscode.CancellationTokenSource();
    try {
        await vscode.workspace.getConfiguration('files').update('autoSave', 'off', vscode.ConfigurationTarget.Global);
        const opened = await client.request('init', { vault, passwordA: 'a', passwordB: 'b' });
        const root = provider.mount(opened.vaultId, client);
        subscriptions.push(vscode.workspace.registerFileSystemProvider(root.scheme, provider, { isCaseSensitive: true }),
            vscode.window.registerCustomEditorProvider(PROTECTED_EDITOR, editor, { supportsMultipleEditorsPerDocument: false }));
        const file = vscode.Uri.joinPath(root, 'protected.txt');
        await vscode.workspace.fs.writeFile(file, Buffer.alloc(0));
        await assert.rejects(vscode.workspace.fs.readFile(file));
        await assert.rejects(vscode.workspace.openTextDocument(file));
        await vscode.commands.executeCommand('vscode.openWith', file, PROTECTED_EDITOR);
        const doc = editor.documents.get(file.toString());
        assert(doc, 'Real VS Code created our CustomDocument');
        assert.equal(vscode.workspace.textDocuments.some(d => d.uri.toString() === file.toString()), false);
        const secret = `protected-only-${require('node:crypto').randomUUID()} 日本語\r\n</script>`;
        let trackedBackup;
        const makeBackup = editor.backupCustomDocument.bind(editor);
        editor.backupCustomDocument = async (...args) => { trackedBackup = await makeBackup(...args); return trackedBackup; };
        editor.update(doc, secret);
        // Put the same plaintext in the real renderer as well as the custom model.
        // The test does not simulate typing, but it exercises renderer persistence.
        for (const panel of doc.panels) {
            assert.equal(panel.webview.html.includes(secret), false);
            await panel.webview.postMessage({ type: 'load', text: secret, dirty: true, epoch: 777 });
        }
        if (process.env.VENC_PROBE_BACKUPS === '1') {
            // Wait for VS Code's actual working-copy backup tracker, not a direct API call.
            const deadline = Date.now() + 15_000;
            while (!trackedBackup && Date.now() < deadline) { await new Promise(resolve => setTimeout(resolve, 100)); }
            assert(trackedBackup, 'Normal profile invoked backupCustomDocument for the dirty working copy');
            await new Promise(resolve => setTimeout(resolve, 1500));
            assert.equal(await contains(process.env.VENC_TEST_USER_DATA, secret), false, 'No document plaintext in normal VS Code profile');
        } else {
            trackedBackup = await makeBackup(doc, { destination: vscode.Uri.file(path.join(temp, 'unused-backup')) }, token.token);
        }
        assert.equal(await contains(vault, secret), false, 'Vault contains ciphertext only');
        const recovered = await provider.readDocument(file, trackedBackup.id.split(':')[1]);
        assert.equal(recovered.text, secret, 'Encrypted draft roundtrip');
        await assert.rejects(editor.saveCustomDocumentAs(doc, vscode.Uri.file(path.join(temp, 'export.txt')), token.token));
        await editor.saveAll(root.authority);
        assert.equal(doc.dirty, false);
        assert.equal((await provider.readDocument(file)).text, secret);
        await vscode.commands.executeCommand('workbench.action.closeAllEditors');
        assert.equal(doc.active, false);
        provider.unmount(root.authority);
        await client.request('lock', {});
        console.log('Protected CustomDocument: real editor, encrypted backup, blocked native reads/Save As, UTF-8 save and disposal passed');
    } finally {
        await vscode.commands.executeCommand('workbench.action.closeAllEditors');
        subscriptions.forEach(item => item.dispose());
        editor.dispose(); provider.dispose(); client.dispose(); token.dispose();
        await fs.rm(temp, { recursive: true, force: true });
    }
};
