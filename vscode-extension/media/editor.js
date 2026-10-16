/* Trusted, bundled script. Never persist plaintext with webview state or browser storage. */
(() => {
    const api = acquireVsCodeApi();
    const text = document.getElementById('text'), status = document.getElementById('status');
    const search = document.getElementById('search'), query = document.getElementById('query');
    const replacement = document.getElementById('replacement'), matchCase = document.getElementById('match-case');
    const eol = document.getElementById('eol');
    let sequence = 0, epoch = 0, accepted = '', frozen = false, composing = false;
    const pendingSnapshots = [];
    const emit = () => {
        if (frozen) { text.value = accepted; return; }
        if (new TextEncoder().encode(text.value).length > 16777216) { text.value = accepted; status.textContent = 'Edit rejected: file exceeds 16 MiB.'; return; }
        accepted = text.value;
        api.postMessage({ type: 'edit', text: text.value, epoch, sequence: ++sequence });
        status.textContent = 'Unsaved changes';
    };
    const snapshot = message => {
        if (message.freeze) { frozen = true; text.readOnly = true; eol.disabled = true; }
        api.postMessage({ type: 'snapshot', request: message.request, text: text.value, epoch, sequence: ++sequence });
    };
    window.addEventListener('message', event => {
        const m = event.data;
        if (m.type === 'load') {
            epoch = m.epoch; sequence = 0; text.value = m.text; accepted = text.value;
            frozen = !!m.frozen; text.disabled = false; text.readOnly = frozen;
            eol.value = m.eol || 'LF'; eol.disabled = frozen;
            status.textContent = m.dirty ? 'Unsaved changes' : 'Saved';
        } else if (m.type === 'status') { status.textContent = m.message; }
        else if (m.type === 'focus') { text.focus(); }
        else if (m.type === 'snapshot') { if (composing) { pendingSnapshots.push(m); } else { snapshot(m); } }
        else if (m.type === 'resume') { frozen = false; text.readOnly = false; eol.disabled = false; }
        else if (m.type === 'clear') {
            text.value = ''; accepted = ''; query.value = ''; replacement.value = '';
            pendingSnapshots.length = 0; frozen = true; text.disabled = true; status.textContent = 'Vault locked';
        }
    });
    text.addEventListener('compositionstart', () => { composing = true; });
    text.addEventListener('compositionend', () => { composing = false; emit(); for (const message of pendingSnapshots.splice(0)) { snapshot(message); } });
    text.addEventListener('input', () => { if (!composing) { emit(); } });
    text.addEventListener('keydown', event => {
        if (event.key === 'Tab' && !event.ctrlKey && !event.metaKey && !frozen) { event.preventDefault(); event.stopPropagation(); text.setRangeText('\t', text.selectionStart, text.selectionEnd, 'end'); emit(); }
    });
    const pattern = () => {
        if (!query.value) { status.textContent = 'Enter search text'; return; }
        const escaped = query.value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
        return new RegExp(escaped, matchCase.checked ? 'g' : 'gi');
    };
    const next = () => {
        const re = pattern(); if (!re) { return; }
        re.lastIndex = text.selectionEnd;
        let found = re.exec(text.value);
        if (!found) { re.lastIndex = 0; found = re.exec(text.value); }
        if (!found) { status.textContent = 'No matches'; return; }
        text.focus(); text.setSelectionRange(found.index, found.index + found[0].length);
        status.textContent = 'Match selected';
    };
    document.getElementById('find-next').addEventListener('click', next);
    document.getElementById('replace').addEventListener('click', () => {
        if (frozen) { return; }
        const re = pattern(); if (!re) { return; }
        const selected = text.value.slice(text.selectionStart, text.selectionEnd);
        re.lastIndex = 0;
        const found = re.exec(selected);
        if (found && found.index === 0 && found[0].length === selected.length) {
            text.setRangeText(replacement.value, text.selectionStart, text.selectionEnd, 'end'); emit();
        }
        next();
    });
    document.getElementById('replace-all').addEventListener('click', () => {
        if (frozen) { return; }
        const re = pattern(); if (!re) { return; }
        const updated = text.value.replace(re, () => replacement.value);
        if (new TextEncoder().encode(updated).length > 16777216) { status.textContent = 'Replacement exceeds 16 MiB'; return; }
        text.value = updated; emit(); text.focus();
    });
    document.getElementById('close-search').addEventListener('click', () => { search.hidden = true; text.focus(); });
    eol.addEventListener('change', () => { if (!frozen) { api.postMessage({ type: 'eol', value: eol.value }); } });
    document.getElementById('save').addEventListener('click', () => api.postMessage({ type: 'save' }));
    document.addEventListener('keydown', event => {
        if ((event.ctrlKey || event.metaKey) && !event.altKey) {
            const key = event.key.toLowerCase();
            if (key === 's') { event.preventDefault(); event.stopPropagation(); api.postMessage({ type: 'save' }); }
            else if (key === 'f' || key === 'h') { event.preventDefault(); event.stopPropagation(); search.hidden = false; query.focus(); query.select(); }
            else if (event.target === text && (key === 'z' || key === 'y')) {
                event.preventDefault(); event.stopPropagation(); api.postMessage({ type: key === 'y' || event.shiftKey ? 'redo' : 'undo' });
            }
        } else if (event.key === 'Escape' && !search.hidden) { search.hidden = true; text.focus(); }
    });
    api.postMessage({ type: 'ready' });
})();
