import * as vscode from 'vscode';
import { performance } from 'node:perf_hooks';
interface Entry { activity: number; generation: number; suspended: boolean }
export class IdleLock implements vscode.Disposable {
    private readonly entries = new Map<string, Entry>();
    private readonly events = new vscode.EventEmitter<void>();
    readonly onDidChange = this.events.event;
    private readonly timer: ReturnType<typeof setInterval>;
    private minutes = 5;
    private running = false;
    private disposed = false;
    constructor(private readonly lock: (authority: string, stillIdle: () => boolean) => Promise<boolean>, private readonly now = () => performance.now()) {
        this.timer = setInterval(() => { void this.tick(); }, 1000); this.timer.unref?.();
    }
    configure(minutes: number): void {
        this.minutes = Number.isFinite(minutes) ? Math.min(1440, Math.max(0, minutes)) : 5;
        this.touch();
    }
    sync(authorities: string[]): void {
        const ids = new Set(authorities);
        for (const id of this.entries.keys()) { if (!ids.has(id)) { this.entries.delete(id); } }
        for (const id of ids) { if (!this.entries.has(id)) { this.entries.set(id, { activity: this.now(), generation: 0, suspended: false }); } }
    }
    touch(authority?: string): void {
        for (const [id, entry] of this.entries) {
            if (!authority || id === authority) { entry.activity = this.now(); entry.generation++; entry.suspended = false; }
        }
        if (!this.disposed) { this.events.fire(); }
    }
    get summary(): string {
        if (!this.minutes) { return 'Auto-lock off'; }
        if ([...this.entries.values()].some(entry => entry.suspended)) { return 'Auto-lock paused — resolve the warning or retry manually'; }
        const remaining = [...this.entries.values()].map(entry => Math.max(0, this.minutes * 60000 - (this.now() - entry.activity)));
        if (!remaining.length) { return `Auto-lock ${this.minutes} min`; }
        const seconds = Math.ceil(Math.min(...remaining) / 1000);
        return `Auto-lock ${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, '0')}`;
    }
    async tick(): Promise<void> {
        if (this.disposed || this.running || !this.minutes) { return; }
        this.running = true;
        try {
            for (const [id, entry] of [...this.entries]) {
                if (entry.suspended || this.now() - entry.activity < this.minutes * 60000) { continue; }
                const generation = entry.generation;
                const stillIdle = () => !this.disposed && this.entries.get(id) === entry && entry.generation === generation
                    && this.minutes > 0 && this.now() - entry.activity >= this.minutes * 60000;
                try {
                    if (await this.lock(id, stillIdle)) { if (this.entries.get(id) === entry) { this.entries.delete(id); } }
                    else if (stillIdle()) { entry.suspended = true; }
                } catch { if (stillIdle()) { entry.suspended = true; } }
            }
        } finally { this.running = false; if (!this.disposed) { this.events.fire(); } }
    }
    dispose(): void { this.disposed = true; clearInterval(this.timer); this.entries.clear(); this.events.dispose(); }
}
