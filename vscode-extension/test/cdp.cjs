// Test-only CDP driver. It connects solely to the disposable VS Code instance.
const net = require('node:net');
const WebSocket = require('ws');
exports.freePort = () => new Promise((resolve, reject) => {
    const server = net.createServer(); server.on('error', reject);
    server.listen(0, '127.0.0.1', () => { const port = server.address().port; server.close(() => resolve(port)); });
});
exports.until = async (check, label, timeout = 12000) => {
    const deadline = Date.now() + timeout;
    while (Date.now() < deadline) { const value = await check(); if (value) return value; await new Promise(resolve => setTimeout(resolve, 50)); }
    throw new Error('Timed out: ' + label);
};
exports.connect = async () => {
    const endpoint = await (await fetch(`http://127.0.0.1:${process.env.VENC_TEST_CDP_PORT}/json/version`)).json();
    const socket = new WebSocket(endpoint.webSocketDebuggerUrl);
    await new Promise((resolve, reject) => { socket.addEventListener('open', resolve, { once: true }); socket.addEventListener('error', reject, { once: true }); });
    let sequence = 0; const pending = new Map(), contexts = new Map(), sessions = new Map();
    socket.addEventListener('message', event => {
        const message = JSON.parse(event.data);
        if (message.id) {
            const entry = pending.get(message.id); if (!entry) return;
            pending.delete(message.id); clearTimeout(entry.timer);
            if (message.error) entry.reject(new Error(message.error.message)); else entry.resolve(message.result);
        } else if (message.method === 'Runtime.executionContextCreated') {
            contexts.set(`${message.sessionId}:${message.params.context.id}`, { session: message.sessionId, id: message.params.context.id });
        } else if (message.method === 'Runtime.executionContextDestroyed') { contexts.delete(`${message.sessionId}:${message.params.executionContextId}`); }
        else if (message.method === 'Runtime.executionContextsCleared') { for (const [key, ctx] of contexts) if (ctx.session === message.sessionId) contexts.delete(key); }
    });
    const call = (method, params = {}, sessionId) => new Promise((resolve, reject) => {
        const id = ++sequence, timer = setTimeout(() => { pending.delete(id); reject(new Error('CDP timeout: ' + method)); }, 5000);
        pending.set(id, { resolve, reject, timer }); socket.send(JSON.stringify({ id, method, params, sessionId }));
    });
    const attach = async () => {
        const { targetInfos } = await call('Target.getTargets');
        for (const target of targetInfos.filter(t => ['page', 'iframe', 'webview'].includes(t.type))) {
            if (sessions.has(target.targetId)) continue;
            try {
                const { sessionId } = await call('Target.attachToTarget', { targetId: target.targetId, flatten: true });
                sessions.set(target.targetId, sessionId); await call('Runtime.enable', {}, sessionId);
            } catch { /* Target may disappear during editor navigation. */ }
        }
    };
    const evaluate = async (context, expression) => {
        const result = await call('Runtime.evaluate', { expression, contextId: context.id, returnByValue: true, awaitPromise: true }, context.session);
        if (result.exceptionDetails) throw new Error(result.exceptionDetails.text);
        return result.result.value;
    };
    const find = async selector => exports.until(async () => {
        await attach();
        for (const context of contexts.values()) {
            try { if (await evaluate(context, `!!document.querySelector(${JSON.stringify(selector)})`)) return context; } catch { /* Detached or non-DOM context. */ }
        }
    }, 'renderer selector ' + selector);
    const key = async (context, key, code, modifiers = 0) => {
        const windowsVirtualKeyCode = key === 'Enter' ? 13 : key.length === 1 ? key.toUpperCase().charCodeAt(0) : undefined;
        await call('Input.dispatchKeyEvent', { type: 'keyDown', key, code, modifiers, windowsVirtualKeyCode }, context.session);
        await call('Input.dispatchKeyEvent', { type: 'keyUp', key, code, modifiers, windowsVirtualKeyCode }, context.session);
    };
    return { call, evaluate, find, key, insert: (context, text) => call('Input.insertText', { text }, context.session),
        close() { for (const entry of pending.values()) { clearTimeout(entry.timer); entry.reject(new Error('CDP closed')); } pending.clear(); socket.close(); } };
};
