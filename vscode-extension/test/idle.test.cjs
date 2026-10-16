const { test } = require('node:test');
const assert = require('node:assert/strict');
const Module = require('node:module');
const load = Module._load;
class Emitter { listeners = []; event = fn => { this.listeners.push(fn); return { dispose() {} }; }; fire() { for (const fn of this.listeners) fn(); } dispose() { this.listeners = []; } }
Module._load = function (id, ...args) { return id === 'vscode' ? { EventEmitter: Emitter } : load.call(this, id, ...args); };
const { IdleLock } = require('../dist/idleLock');
Module._load = load;

test('idle locks are per vault, respect activity and disabled mode', async t => {
    let now = 0; const calls = [];
    const idle = new IdleLock(async (id, stillIdle) => { assert(stillIdle()); calls.push(id); return true; }, () => now);
    t.after(() => idle.dispose()); idle.configure(1); idle.sync(['a', 'b']);
    now = 59000; idle.touch('a'); await idle.tick(); assert.deepEqual(calls, []);
    now = 60000; await idle.tick(); assert.deepEqual(calls, ['b']);
    now = 119001; await idle.tick(); assert.deepEqual(calls, ['b', 'a']);
    idle.sync(['a']); idle.configure(0); now += 999999; await idle.tick(); assert.equal(calls.length, 2); assert.equal(idle.summary, 'Auto-lock off');
});
test('new activity during checkpoint cancels expiry and failed locks wait for new activity', async t => {
    let now = 0, calls = 0, mode = 'activity';
    const idle = new IdleLock(async (id, stillIdle) => {
        calls++;
        if (mode === 'activity') { idle.touch(id); assert(!stillIdle()); return false; }
        if (mode === 'blocked') { return false; }
        return true;
    }, () => now);
    t.after(() => idle.dispose()); idle.configure(1); idle.sync(['a']);
    now = 60001; await idle.tick(); assert.equal(calls, 1); assert(!idle.summary.includes('paused'));
    mode = 'blocked'; now += 60001; await idle.tick(); assert(idle.summary.includes('paused'));
    now += 60001; await idle.tick(); assert.equal(calls, 2, 'No repeated prompts while blocked');
    mode = 'success'; idle.touch('a'); now += 60001; await idle.tick(); assert.equal(calls, 3);
});
test('replacement sessions do not inherit a pending old session expiry', async t => {
    let now = 0;
    const idle = new IdleLock(async (_id, stillIdle) => { idle.sync([]); idle.sync(['a']); assert(!stillIdle()); return false; }, () => now);
    t.after(() => idle.dispose()); idle.configure(1); idle.sync(['a']); now = 60001;
    await idle.tick(); assert(!idle.summary.includes('paused')); assert.equal(idle.summary, 'Auto-lock 1:00');
});
