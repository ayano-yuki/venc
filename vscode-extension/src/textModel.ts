export interface TextPatch { start: number; removed: string; inserted: string; released?: boolean }
export function difference(before: string, after: string): TextPatch {
    let start = 0, end = 0;
    while (start < before.length && start < after.length && before[start] === after[start]) { start++; }
    while (end < before.length - start && end < after.length - start && before[before.length - 1 - end] === after[after.length - 1 - end]) { end++; }
    return { start, removed: before.slice(start, before.length - end), inserted: after.slice(start, after.length - end) };
}
export function applyPatch(text: string, patch: TextPatch, reverse: boolean): string {
    if (patch.released) { throw new Error('Older undo history was released to limit plaintext memory.'); }
    const from = reverse ? patch.inserted : patch.removed, to = reverse ? patch.removed : patch.inserted;
    if (text.slice(patch.start, patch.start + from.length) !== from) { throw new Error('Undo history no longer matches this document.'); }
    return text.slice(0, patch.start) + to + text.slice(patch.start + from.length);
}
export function preferredEol(text: string): '\n' | '\r\n' { return text.match(/\r\n|\n|\r/)?.[0] === '\r\n' ? '\r\n' : '\n'; }
export function normalizeEol(text: string): string { return text.replace(/\r\n|\r/g, '\n'); }
/** Preserve exact unchanged bytes, including mixed EOLs and BOMs, around textarea's LF edit. */
export function fromRenderer(before: string, incoming: string, eol: string): string {
    const normalized = normalizeEol(before), after = normalizeEol(incoming);
    if (normalized === after) { return before; }
    const patch = difference(normalized, after);
    const toOriginal = (offset: number) => {
        let index = 0, count = 0;
        while (count < offset && index < before.length) { if (before[index] === '\r' && before[index + 1] === '\n') { index++; } index++; count++; }
        return index;
    };
    return before.slice(0, toOriginal(patch.start)) + patch.inserted.replace(/\n/g, eol) + before.slice(toOriginal(patch.start + patch.removed.length));
}
