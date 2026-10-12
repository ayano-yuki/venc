import { spawn, ChildProcessWithoutNullStreams } from 'node:child_process';
import { EventEmitter } from 'node:events';

const MAX_FRAME = 24 * 1024 * 1024;
const MAX_PENDING = 32;
const ERROR_CODES = new Set(['FileNotFound', 'FileExists', 'FileNotADirectory', 'FileIsADirectory', 'NoPermissions', 'Unavailable']);
export class CoreError extends Error {
    constructor(public readonly code: string, message: string) { super(message); }
}
export interface CoreConnection {
    readonly closed: boolean;
    request<T>(method: string, params: Record<string, unknown>): Promise<T>;
    dispose?(): void;
}
/** A private child process and anonymous pipes per vault. No shell, TCP port, or secret arguments. */
export class CoreClient extends EventEmitter implements CoreConnection {
    private readonly child: ChildProcessWithoutNullStreams;
    private readonly pending = new Map<number, {
        method: string; resolve: (value: unknown) => void; reject: (error: Error) => void; timer: NodeJS.Timeout;
    }>();
    private readonly outgoing = new Set<Buffer>();
    private outgoingBytes = 0;
    private chunks: Buffer[] = [];
    private frameBytes = 0;
    private nextId = 1;
    closed = false;
    constructor(binary: string, private readonly timeoutMs = 120_000) {
        super();
        this.child = spawn(binary, ['serve'], { stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true });
        this.child.stdout.on('data', (chunk: Buffer) => this.receive(chunk));
        this.child.stdout.on('end', () => this.fail(new CoreError('Unavailable', 'Vault connection ended. Reopen the vault.')));
        // Do not forward potentially sensitive core diagnostics to logs or terminals.
        this.child.stderr.on('data', (chunk: Buffer) => chunk.fill(0));
        this.child.on('error', () => this.fail(new CoreError('Unavailable', 'Cannot start venc core. Check venc.corePath.')));
        this.child.on('exit', () => this.fail(new CoreError('Unavailable', 'Vault core stopped. Reopen the vault.')));
        this.child.stdin.on('error', () => this.fail(new CoreError('Unavailable', 'Vault connection closed.')));
    }
    request<T>(method: string, params: Record<string, unknown>): Promise<T> {
        if (this.closed) { return Promise.reject(new CoreError('Unavailable', 'Vault is locked.')); }
        if (this.pending.size >= MAX_PENDING) { return Promise.reject(new CoreError('Unavailable', 'Vault is busy. Retry the operation.')); }
        const id = this.nextId++;
        const frame = Buffer.from(JSON.stringify({ id, method, params }) + '\n');
        if (frame.length > MAX_FRAME || this.outgoingBytes + frame.length > MAX_FRAME) {
            const oversized = frame.length > MAX_FRAME;
            frame.fill(0);
            return Promise.reject(new CoreError(oversized ? 'NoPermissions' : 'Unavailable', oversized ? 'Request exceeds the vault size limit.' : 'Vault is busy. Retry the operation.'));
        }
        this.outgoing.add(frame); this.outgoingBytes += frame.length;
        return new Promise<T>((resolve, reject) => {
            const timer = setTimeout(() => this.fail(new CoreError('Unavailable', 'Core request timed out; vault locked.')), this.timeoutMs);
            this.pending.set(id, { method, resolve: value => resolve(value as T), reject, timer });
            this.child.stdin.write(frame, error => {
                if (this.outgoing.delete(frame)) { this.outgoingBytes -= frame.length; }
                frame.fill(0);
                if (error) { this.fail(new CoreError('Unavailable', 'Vault connection closed.')); }
            });
        });
    }
    private receive(chunk: Buffer): void {
        if (this.closed) { chunk.fill(0); return; }
        let start = 0;
        try {
            while (start < chunk.length) {
                const newline = chunk.indexOf(10, start);
                const end = newline < 0 ? chunk.length : newline;
                this.frameBytes += end - start;
                if (this.frameBytes > MAX_FRAME) { throw new Error('oversized response'); }
                this.chunks.push(Buffer.from(chunk.subarray(start, end)));
                if (newline < 0) { break; }
                const frame = Buffer.concat(this.chunks, this.frameBytes);
                this.clearFrame();
                let response;
                try { response = JSON.parse(frame.toString('utf8')); } finally { frame.fill(0); }
                if (!response || typeof response !== 'object' || Array.isArray(response)
                    || !Number.isSafeInteger(response.id) || response.id <= 0 || typeof response.locked !== 'boolean'
                    || Object.hasOwn(response, 'error') === Object.hasOwn(response, 'result')) { throw new Error('invalid response'); }
                if (Object.hasOwn(response, 'error') && (!response.error || !ERROR_CODES.has(response.error.code)
                    || typeof response.error.message !== 'string' || response.error.message.length > 4096)) { throw new Error('invalid error'); }
                const request = this.pending.get(response.id);
                if (!request) { throw new Error('unexpected response'); }
                // Validate before removing the pending request so a malformed response
                // rejects it immediately instead of leaving an unsettled Promise.
                this.pending.delete(response.id);
                clearTimeout(request.timer);
                if (response.error) { request.reject(new CoreError(response.error.code, response.error.message)); }
                else { request.resolve(response.result); }
                if (response.locked && (request.method !== 'hello' || response.error)) { this.fail(new CoreError('Unavailable', 'Vault is locked.')); return; }
                start = newline + 1;
            }
        } catch { this.fail(new CoreError('Unavailable', 'Invalid core response; vault locked.')); }
        finally { chunk.fill(0); }
    }
    private clearFrame(): void {
        for (const chunk of this.chunks) { chunk.fill(0); }
        this.chunks = []; this.frameBytes = 0;
    }
    private fail(error: Error, graceful = false): void {
        if (this.closed) { return; }
        this.closed = true;
        for (const request of this.pending.values()) { clearTimeout(request.timer); request.reject(error); }
        this.pending.clear(); this.clearFrame();
        if (graceful && this.outgoingBytes === 0) {
            // EOF allows Rust to drop and zeroize its session during normal shutdown.
            this.child.stdin.end();
            const timer = setTimeout(() => this.child.kill(), 1000);
            timer.unref();
            this.child.once('exit', () => clearTimeout(timer));
        } else { this.child.stdin.destroy(); this.child.kill(); }
        for (const frame of this.outgoing) { frame.fill(0); }
        this.outgoing.clear(); this.outgoingBytes = 0;
        this.emit('closed', error);
    }
    dispose(): void { this.fail(new CoreError('Unavailable', 'Vault is locked.'), true); }
}
