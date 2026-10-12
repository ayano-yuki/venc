import { spawn, ChildProcessWithoutNullStreams } from 'node:child_process';
import { EventEmitter } from 'node:events';

const MAX_FRAME = 24 * 1024 * 1024;
export class CoreError extends Error {
    constructor(public readonly code: string, message: string) { super(message); }
}
export interface CoreConnection {
    readonly closed: boolean;
    request<T>(method: string, params: Record<string, unknown>): Promise<T>;
}
/** A private child process and anonymous pipes per vault. No shell, TCP port, or secret arguments. */
export class CoreClient extends EventEmitter implements CoreConnection {
    private readonly child: ChildProcessWithoutNullStreams;
    private readonly pending = new Map<number, {
        resolve: (value: unknown) => void; reject: (error: Error) => void; timer: NodeJS.Timeout;
    }>();
    private chunks: Buffer[] = [];
    private frameBytes = 0;
    private nextId = 1;
    closed = false;
    constructor(binary: string, private readonly timeoutMs = 120_000) {
        super();
        this.child = spawn(binary, ['serve'], { stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true });
        this.child.stdout.on('data', (chunk: Buffer) => this.receive(chunk));
        // Do not forward potentially sensitive core diagnostics to logs or terminals.
        this.child.stderr.on('data', (chunk: Buffer) => chunk.fill(0));
        this.child.on('error', () => this.fail(new CoreError('Unavailable', 'Cannot start venc core. Check venc.corePath.')));
        this.child.on('exit', () => this.fail(new CoreError('Unavailable', 'Vault core stopped. Reopen the vault.')));
        this.child.stdin.on('error', () => this.fail(new CoreError('Unavailable', 'Vault connection closed.')));
    }
    request<T>(method: string, params: Record<string, unknown>): Promise<T> {
        if (this.closed) { return Promise.reject(new CoreError('Unavailable', 'Vault is locked.')); }
        const id = this.nextId++;
        const frame = Buffer.from(JSON.stringify({ id, method, params }) + '\n');
        if (frame.length > MAX_FRAME) {
            frame.fill(0);
            return Promise.reject(new CoreError('NoPermissions', 'File exceeds the 16 MiB limit.'));
        }
        return new Promise<T>((resolve, reject) => {
            const timer = setTimeout(() => this.fail(new CoreError('Unavailable', 'Core request timed out; vault locked.')), this.timeoutMs);
            this.pending.set(id, { resolve: value => resolve(value as T), reject, timer });
            this.child.stdin.write(frame, error => {
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
                const part = Buffer.from(chunk.subarray(start, end));
                this.chunks.push(part);
                this.frameBytes += part.length;
                if (this.frameBytes > MAX_FRAME) { throw new Error('oversized response'); }
                if (newline < 0) { break; }
                const frame = Buffer.concat(this.chunks, this.frameBytes);
                this.clearFrame();
                let response;
                try { response = JSON.parse(frame.toString('utf8')); } finally { frame.fill(0); }
                if (!Number.isSafeInteger(response.id) || typeof response.locked !== 'boolean') { throw new Error('invalid response'); }
                const request = this.pending.get(response.id);
                if (!request) { throw new Error('unexpected response'); }
                this.pending.delete(response.id);
                clearTimeout(request.timer);
                if (response.error) {
                    request.reject(new CoreError(response.error.code, response.error.message));
                } else { request.resolve(response.result); }
                if (response.locked) { this.fail(new CoreError('Unavailable', 'Vault is locked.')); return; }
                start = newline + 1;
            }
        } catch { this.fail(new CoreError('Unavailable', 'Invalid core response; vault locked.')); }
        finally { chunk.fill(0); }
    }
    private clearFrame(): void {
        for (const chunk of this.chunks) { chunk.fill(0); }
        this.chunks = []; this.frameBytes = 0;
    }
    private fail(error: Error): void {
        if (this.closed) { return; }
        this.closed = true;
        for (const request of this.pending.values()) { clearTimeout(request.timer); request.reject(error); }
        this.pending.clear(); this.clearFrame();
        this.child.stdin.destroy(); this.child.kill();
        this.emit('closed');
    }
    dispose(): void { this.fail(new CoreError('Unavailable', 'Vault is locked.')); }
}
