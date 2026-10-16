const vscode = require('vscode');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const { CoreClient } = require('../dist/coreClient');
const { VaultProvider } = require('../dist/vaultProvider');
const { ProtectedEditor, PROTECTED_EDITOR } = require('../dist/protectedEditor');
const { recoverDrafts } = require('../dist/recovery');
const { connect, until } = require('./cdp.cjs');
async function contains(directory, needle) {
    for (const item of await fs.readdir(directory, { withFileTypes: true }).catch(() => [])) {
        const location = path.join(directory, item.name);
        if (item.isDirectory()) { if (await contains(location, needle)) return true; }
        else if (item.isFile() && (await fs.readFile(location).catch(() => Buffer.alloc(0))).includes(Buffer.from(needle))) return true;
    }
    return false;
}
exports.run = async () => {
    const vault = process.env.VENC_TEST_RECOVERY_DIR;
    const phase = process.env.VENC_PROBE_PHASE;
    const marker = process.env.VENC_TEST_MARKER;
    let client = new CoreClient(process.env.VENC_TEST_CORE);
    const provider = new VaultProvider('venc-protected-test');
    const editor = new ProtectedEditor(provider, 'venc-protected-test');
    const subscriptions = [];
    let driver, crashReady = false;
    const stage = name => fs.writeFile(process.env.VENC_TEST_PROGRESS, name);
    try {
        await vscode.workspace.getConfiguration('files').update('autoSave', 'off', vscode.ConfigurationTarget.Global);
        // The killed renderer's extension host/core may still be exiting when
        // the next process starts. Wait only for its cooperative lock release.
        const opened = await until(async () => {
            try { return await client.request(phase === 'recover' ? 'unlock' : 'init', { vault, passwordA: 'a', passwordB: 'b' }); }
            catch (error) {
                if (phase === 'recover' && error.message.includes('already open in another process')) {
                    client.dispose(); client = new CoreClient(process.env.VENC_TEST_CORE); return undefined;
                }
                throw error;
            }
        }, 'previous crash process released the vault lock');
        const root = provider.mount(opened.vaultId, client), file = vscode.Uri.joinPath(root, 'protected.txt');
        subscriptions.push(vscode.workspace.registerFileSystemProvider(root.scheme, provider, { isCaseSensitive: true }),
            vscode.window.registerCustomEditorProvider(PROTECTED_EDITOR, editor, { supportsMultipleEditorsPerDocument: false }));
        await stage('connect debugger');
        driver = await connect();
        if (phase === 'recover') {
            const page = await provider.listBackups(root);
            assert(page.entries.length, 'Crash left authenticated encrypted drafts');
            await stage('recovery drafts=' + page.entries.length);
            let recoveryError;
            const recovery = recoverDrafts(provider, root).catch(error => { recoveryError = error; });
            const quick = await driver.find('.quick-input-widget .monaco-inputbox input');
            const placeholder = () => driver.evaluate(quick, 'document.querySelector(".quick-input-widget .monaco-inputbox input").getAttribute("placeholder")');
            try { await until(async () => { if (recoveryError) throw recoveryError; return (await placeholder())?.includes('Choose an encrypted draft'); }, 'draft selection'); }
            catch (error) { throw new Error(error.message + '; placeholder=' + await placeholder()); }
            await driver.key(quick, 'Enter', 'Enter');
            await until(async () => (await placeholder()) === 'protected.txt', 'recovery action selection');
            await driver.key(quick, 'Enter', 'Enter');
            await until(async () => await driver.evaluate(quick, 'document.querySelector(".quick-input-widget").textContent.includes("New encrypted file path")'), 'recovery destination');
            await driver.evaluate(quick, 'document.querySelector(".quick-input-widget .monaco-inputbox input").focus();document.querySelector(".quick-input-widget .monaco-inputbox input").select()');
            await driver.insert(quick, 'Recovered/after-crash.txt');
            await driver.key(quick, 'Enter', 'Enter');
            await recovery; if (recoveryError) throw recoveryError;
            const recovered = vscode.Uri.joinPath(root, 'Recovered/after-crash.txt');
            const doc = await until(() => editor.documents.get(recovered.toString()), 'recovered custom document');
            assert.equal(doc.text, `\uFEFFstart\r\n日本語\r\n${marker}-REPLACED-UNSAVED`);
            await stage('find renderer');
            const renderer = await driver.find('textarea#text');
            await until(async () => (await driver.evaluate(renderer, 'document.getElementById("text").value')).includes(marker), 'recovered renderer');
            assert.equal((await provider.readDocument(file)).text, `\uFEFFstart\r\n日本語\r\n${marker}-REPLACED`, 'Recovery did not overwrite saved document');
            assert.equal(await contains(vault, marker), false);
            assert.equal(await contains(process.env.VENC_TEST_USER_DATA, marker), false);
            console.log('Crash/restart: authenticated recovery UI restored unsaved encrypted draft without overwriting source');
            return;
        }
        await provider.importFile(file, Buffer.from('\uFEFFstart\r\n'));
        await assert.rejects(vscode.workspace.fs.readFile(file));
        await assert.rejects(vscode.workspace.openTextDocument(file));
        await vscode.commands.executeCommand('vscode.openWith', file, PROTECTED_EDITOR);
        const doc = await until(() => editor.documents.get(file.toString()), 'custom document');
        await stage('find renderer');
        const renderer = await driver.find('textarea#text');
        await until(async () => await driver.evaluate(renderer, '!document.getElementById("text").disabled'), 'loaded renderer');
        assert.equal(vscode.workspace.textDocuments.some(d => d.uri.toString() === file.toString()), false);
        await driver.evaluate(renderer, 'document.getElementById("text").focus();document.getElementById("text").setSelectionRange(99999,99999)');
        await stage('IME');
        await driver.call('Input.imeSetComposition', { text: 'にほんご', selectionStart: 4, selectionEnd: 4 }, renderer.session);
        await driver.insert(renderer, '日本語');
        await driver.insert(renderer, '\n' + marker + '-a.b');
        const expected = `\uFEFFstart\r\n日本語\r\n${marker}-a.b`;
        await until(() => doc.text === expected, 'IME and actual typing reached model');
        await stage('undo');
        await driver.evaluate(renderer, 'document.getElementById("text").focus()');
        await driver.key(renderer, 'z', 'KeyZ', 2);
        await until(() => !doc.text.endsWith('-a.b'), 'VS Code undo');
        await until(async () => !(await driver.evaluate(renderer, 'document.getElementById("text").value')).endsWith('-a.b'), 'undo rendered');
        await stage('redo');
        await driver.evaluate(renderer, 'document.getElementById("text").focus()');
        await driver.key(renderer, 'z', 'KeyZ', 10);
        await until(() => doc.text === expected, 'VS Code redo');
        await until(async () => await driver.evaluate(renderer, 'document.getElementById("text").value') === expected.replace(/\r\n/g, '\n'), 'redo rendered');
        await stage('replace');
        await driver.evaluate(renderer, 'document.getElementById("text").focus()');
        await driver.key(renderer, 'h', 'KeyH', 2);
        await until(async () => await driver.evaluate(renderer, '!document.getElementById("search").hidden'), 'find/replace shortcut');
        await driver.evaluate(renderer, 'document.getElementById("query").value="a.b";document.getElementById("replacement").value="REPLACED";document.getElementById("replace-all").click()');
        const saved = `\uFEFFstart\r\n日本語\r\n${marker}-REPLACED`;
        try { await until(() => doc.text === saved, 'literal replacement'); }
        catch (error) { throw new Error(error.message + '; model=' + JSON.stringify(doc.text) + '; renderer=' + await driver.evaluate(renderer, 'JSON.stringify({text:document.getElementById("text").value,status:document.getElementById("status").textContent})')); }
        await stage('save');
        await driver.key(renderer, 's', 'KeyS', 2);
        try { await until(() => !doc.dirty, 'keyboard save'); }
        catch (error) {
            const status = await driver.evaluate(renderer, 'document.getElementById("status").textContent');
            throw new Error(error.message + '; editor status: ' + status + '; saving=' + doc.saving + '; active=' + doc.active);
        }
        assert.equal((await provider.readDocument(file)).text, saved, 'BOM and CRLF preserved');
        let trackedBackup;
        const makeBackup = editor.backupCustomDocument.bind(editor);
        editor.backupCustomDocument = async (...args) => { trackedBackup = await makeBackup(...args); return trackedBackup; };
        await driver.evaluate(renderer, 'document.getElementById("text").focus();document.getElementById("text").setSelectionRange(99999,99999)');
        await driver.insert(renderer, '-UNSAVED');
        await until(() => doc.text === saved + '-UNSAVED', 'unsaved typing');
        await until(() => trackedBackup, 'actual VS Code backup callback', 20000);
        assert.equal(await contains(vault, marker), false);
        assert.equal(await contains(process.env.VENC_TEST_USER_DATA, marker), false);
        const draft = await provider.readDocument(file, trackedBackup.id.split(':')[1]);
        assert.equal(draft.text, saved + '-UNSAVED');
        await assert.rejects(editor.saveCustomDocumentAs(doc, vscode.Uri.file(path.join(vault, 'export.txt')), { isCancellationRequested: false }));
        console.log('Real renderer: IME, typing, VS Code undo/redo, literal replace, save, BOM/CRLF, encrypted backup and no plaintext marker passed');
        crashReady = true; // Controller now SIGKILLs this disposable process group.
    } finally {
        driver?.close();
        if (!crashReady) {
            editor.dispose();
            subscriptions.forEach(item => item.dispose()); provider.dispose(); client.dispose();
        }
    }
};
