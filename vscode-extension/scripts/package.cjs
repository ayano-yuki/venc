const { execFileSync } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');
const { randomUUID } = require('node:crypto');
const root = path.resolve(__dirname, '../..');
const extension = path.join(root, 'vscode-extension');
const args = process.argv.slice(2);
const target = `${process.platform}-${process.arch === 'arm' ? 'armhf' : process.arch}`;
const index = args.indexOf('--target');
if (args.filter(arg => arg === '--target').length > 1) { throw new Error('Specify --target only once.'); }
if (index >= 0 && args[index + 1] !== target) {
    throw new Error(`This script builds for the current host (${target}). Package each platform on its matching host.`);
}
if (index < 0) { args.push('--target', target); }
if (args.some(arg => arg.startsWith('--target='))) { throw new Error('Use --target with a separate value.'); }
const host = /^host: (.+)$/m.exec(execFileSync('rustc', ['-vV'], { encoding: 'utf8' }))[1].trim();
const rustArch = host.split('-')[0];
const matching = { x64: ['x86_64'], arm64: ['aarch64'], ia32: ['i686', 'i586'], arm: ['armv7', 'arm'] };
if (!matching[process.arch]?.includes(rustArch)) { throw new Error('Node and Rust must use the same host CPU architecture.'); }
const metadata = JSON.parse(execFileSync('cargo', ['metadata', '--no-deps', '--format-version', '1'], { cwd: root, encoding: 'utf8' }));
// Explicit host target keeps static-link RUSTFLAGS away from host procedural macros.
execFileSync('cargo', ['build', '--release', '--locked', '--target', host, '--bin', 'venc'], { cwd: root, stdio: 'inherit' });
const name = process.platform === 'win32' ? 'venc.exe' : 'venc';
const binary = path.join(metadata.target_directory, host, 'release', name);
execFileSync(binary, ['--version'], { stdio: 'inherit' });
fs.mkdirSync(path.join(extension, 'bin'), { recursive: true });
const stagedCore = path.join(extension, 'bin', `.venc.${randomUUID()}.tmp`);
try {
    fs.copyFileSync(binary, stagedCore);
    if (process.platform !== 'win32') { fs.chmodSync(stagedCore, 0o755); }
    fs.renameSync(stagedCore, path.join(extension, 'bin', name));
} catch (error) {
    throw new Error('Cannot replace the bundled core. Close extension hosts that lock the executable and retry.', { cause: error });
} finally { fs.rmSync(stagedCore, { force: true }); }
// A local VSIX has no repository URL for relative documentation links. Bundle
// both languages and the security model into one self-contained README instead
// of inventing a public repository location or publishing broken links.
const body = name => fs.readFileSync(path.join(extension, name), 'utf8')
    .replace(/^# venc for VS Code\s*\n/, '')
    .replace(/\[English\]\(README\.md\) \| \[日本語\]\(README\.ja\.md\)/, '')
    .replace(/\(\.\.\/SECURITY\.md\)/g, '(#security-model-and-hardening-status)');
const readme = `.venc-readme.${randomUUID()}.md`;
const location = path.join(extension, readme);
try {
    fs.writeFileSync(location, '# venc for VS Code\n\n[English](#english) | [日本語](#japanese)\n\n<a id="english"></a>\n\n'
        + body('README.md') + '\n<a id="japanese"></a>\n\n' + body('README.ja.md')
        + '\n' + fs.readFileSync(path.join(root, 'SECURITY.md'), 'utf8'), { flag: 'wx' });
    execFileSync(process.execPath, [require.resolve('@vscode/vsce/vsce'), 'package', '--no-dependencies', '--allow-missing-repository', '--readme-path', readme, ...args],
        { cwd: extension, stdio: 'inherit' });
} finally { fs.rmSync(location, { force: true }); }
