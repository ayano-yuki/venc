delete process.env.ELECTRON_RUN_AS_NODE;
const path = require('node:path');
const fs = require('node:fs/promises');
const os = require('node:os');
const { runTests } = require('@vscode/test-electron');
(async () => {
    const temp = await fs.mkdtemp(path.join(os.tmpdir(), 'venc-vscode-'));
    try {
        await runTests({
            version: process.env.VENC_TEST_VSCODE_VERSION || '1.95.3',
            extensionDevelopmentPath: path.resolve(__dirname, '..'),
            extensionTestsPath: path.resolve(__dirname, 'vscode-suite.cjs'),
            launchArgs: ['--no-sandbox', '--disable-gpu', '--disable-workspace-trust', '--skip-welcome', '--skip-release-notes',
                '--user-data-dir', path.join(temp, 'user'), '--extensions-dir', path.join(temp, 'extensions')],
            extensionTestsEnv: { VENC_TEST_USER_DATA: path.join(temp, 'user'), VENC_TEST_CORE: process.env.VENC_TEST_CORE || path.resolve(__dirname, '../../target/debug', process.platform === 'win32' ? 'venc.exe' : 'venc') }
        });
    } finally { await fs.rm(temp, { recursive: true, force: true }); }
})().catch(error => { console.error(error); process.exit(1); });
