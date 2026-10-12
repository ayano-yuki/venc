// Normal installed-extension mode: development/test windows can omit the disk
// backup location, so they cannot establish this security property.
delete process.env.ELECTRON_RUN_AS_NODE;
const { spawn } = require('node:child_process');
const fs = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');
const { downloadAndUnzipVSCode } = require('@vscode/test-electron');
(async () => {
    const binary = await downloadAndUnzipVSCode('1.95.3');
    const temp = await fs.mkdtemp(path.join(os.tmpdir(), 'venc-backup-probe-'));
    const extension = path.join(temp, 'extensions', 'venc-backup-probe');
    const result = path.join(temp, 'result.json');
    await fs.mkdir(extension, { recursive: true });
    await fs.writeFile(path.join(extension, 'package.json'), JSON.stringify({ name: 'venc-backup-probe', publisher: 'venc-test',
        version: '0.0.1', engines: { vscode: '^1.95.0' }, activationEvents: ['onStartupFinished'], main: './main.cjs' }));
    await fs.writeFile(path.join(extension, 'main.cjs'), `
exports.activate = async () => {
    try { await require(${JSON.stringify(path.join(__dirname, 'vscode-suite.cjs'))}).run();
        require('node:fs').writeFileSync(${JSON.stringify(result)}, JSON.stringify({passed:true}));
    } catch(error) { require('node:fs').writeFileSync(${JSON.stringify(result)}, JSON.stringify({passed:false,error:String(error)})); }
};`);
    const child = spawn(binary, ['--no-sandbox', '--disable-gpu', '--disable-workspace-trust', '--skip-welcome', '--skip-release-notes',
        '--user-data-dir', path.join(temp, 'user'), '--extensions-dir', path.join(temp, 'extensions')], {
        env: { ...process.env, VENC_TEST_USER_DATA: path.join(temp, 'user'), VENC_PROBE_BACKUPS: '1',
            VENC_TEST_CORE: process.env.VENC_TEST_CORE || path.resolve(__dirname, '../../target/debug', process.platform === 'win32' ? 'venc.exe' : 'venc') }, stdio: ['ignore', 'pipe', 'pipe']
    });
    let diagnostics = '';
    child.stdout.on('data', data => { diagnostics += data; });
    child.stderr.on('data', data => { diagnostics += data; });
    let exited = false;
    const exit = new Promise(resolve => child.once('exit', () => { exited = true; resolve(); }));
    try {
        const deadline = Date.now() + 45_000;
        while (Date.now() < deadline && !exited) {
            const content = await fs.readFile(result, 'utf8').catch(() => undefined);
            if (content) {
                const outcome = JSON.parse(content);
                if (!outcome.passed) { throw new Error(outcome.error); }
                console.log('Normal VS Code profile: confirmed plaintext backup with Hot Exit off; editor roundtrip passed');
                return;
            }
            await new Promise(resolve => setTimeout(resolve, 200));
        }
        throw new Error('Backup probe timed out or VS Code exited.\n' + diagnostics);
    } finally { child.kill(); await exit; await fs.rm(temp, { recursive: true, force: true }); }
})().catch(error => { console.error(error); process.exit(1); });
