// Normal installed-extension profile: actual input, encrypted backups, SIGKILL, restart and recovery.
delete process.env.ELECTRON_RUN_AS_NODE;
const { spawn } = require('node:child_process');
const fs = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');
const { randomUUID } = require('node:crypto');
const { downloadAndUnzipVSCode } = require('@vscode/test-electron');
const { freePort } = require('./cdp.cjs');
(async () => {
    const binary = await downloadAndUnzipVSCode(process.env.VENC_TEST_VSCODE_VERSION || '1.95.3');
    const temp = await fs.mkdtemp(path.join(os.tmpdir(), 'venc-backup-probe-'));
    const extension = path.join(temp, 'extensions', 'venc-backup-probe');
    await fs.mkdir(extension, { recursive: true });
    await fs.writeFile(path.join(extension, 'package.json'), JSON.stringify({ name: 'venc-backup-probe', publisher: 'venc-test', version: '0.0.1',
        engines: { vscode: '^1.95.0' }, activationEvents: ['onStartupFinished'], main: './main.cjs',
        contributes: { customEditors: [{ viewType: 'venc.protectedEditor', displayName: 'venc Protected Editor', selector: [{ filenamePattern: '*' }], priority: 'option' }] } }));
    const marker = 'protected-real-' + randomUUID();
    try {
        for (const phase of ['write', 'recover']) {
            const result = path.join(temp, phase + '.json'), port = await freePort();
            await fs.writeFile(path.join(extension, 'main.cjs'), `exports.activate=async()=>{try{await require(${JSON.stringify(path.join(__dirname, phase === 'write' ? 'vscode-suite.cjs' : 'protected-suite.cjs'))}).run();require('node:fs').writeFileSync(${JSON.stringify(result)},JSON.stringify({passed:true}));}catch(error){require('node:fs').writeFileSync(${JSON.stringify(result)},JSON.stringify({passed:false,error:String(error.stack||error)}));}};`);
            const child = spawn(binary, ['--no-sandbox', '--disable-gpu', '--disable-workspace-trust', '--skip-welcome', '--skip-release-notes',
                '--remote-debugging-address=127.0.0.1', `--remote-debugging-port=${port}`, '--user-data-dir', path.join(temp, 'user'), '--extensions-dir', path.join(temp, 'extensions')], {
                detached: process.platform !== 'win32', env: { ...process.env, VENC_TEST_USER_DATA: path.join(temp, 'user'), VENC_PROBE_BACKUPS: '1', VENC_PROBE_PHASE: phase,
                    VENC_TEST_PROGRESS: path.join(temp, 'progress.txt'), VENC_TEST_CDP_PORT: String(port), VENC_TEST_MARKER: marker, VENC_TEST_RECOVERY_DIR: path.join(temp, 'vault'),
                    VENC_TEST_CORE: process.env.VENC_TEST_CORE || path.resolve(__dirname, '../../target/debug', process.platform === 'win32' ? 'venc.exe' : 'venc') }, stdio: ['ignore', 'pipe', 'pipe'] });
            let diagnostics = '', exited = false;
            child.stdout.on('data', data => { diagnostics = (diagnostics + data).slice(-20000); });
            child.stderr.on('data', data => { diagnostics = (diagnostics + data).slice(-20000); });
            const exit = new Promise(resolve => child.once('exit', () => { exited = true; resolve(); }));
            try {
                const deadline = Date.now() + 120000;
                let passed = false;
                while (Date.now() < deadline && !exited) {
                    const content = await fs.readFile(result, 'utf8').catch(() => undefined);
                    if (content) { const outcome = JSON.parse(content); if (!outcome.passed) throw new Error(outcome.error + '\nStage: ' + await fs.readFile(path.join(temp, 'progress.txt'), 'utf8').catch(() => 'unknown') + '\n' + diagnostics); passed = true; break; }
                    await new Promise(resolve => setTimeout(resolve, 100));
                }
                if (!passed) throw new Error(`Backup probe (${phase}) timed out or exited.\nStage: ` + await fs.readFile(path.join(temp, 'progress.txt'), 'utf8').catch(() => 'unknown') + '\n' + diagnostics);
            } finally {
                if (!exited) {
                    if (process.platform === 'win32') child.kill('SIGKILL');
                    else { try { process.kill(-child.pid, 'SIGKILL'); } catch (error) { if (error.code !== 'ESRCH') throw error; } }
                }
                await exit;
            }
            console.log(`Normal VS Code profile: ${phase} phase passed`);
        }
    } finally { await fs.rm(temp, { recursive: true, force: true }); }
})().catch(error => { console.error(error); process.exit(1); });
