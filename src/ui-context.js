// Read parent.document only inside the access check; cross-origin and sandboxed frames fall back safely.
export function resolveUIRoot(current = globalThis.window ?? globalThis) {
    try { return current.parent?.document ? current.parent : current; }
    catch { return current; }
}

export function viewportSize(root) {
    return { width: root.visualViewport?.width || root.innerWidth,
        height: root.visualViewport?.height || root.innerHeight,
        left: root.visualViewport?.offsetLeft || 0, top: root.visualViewport?.offsetTop || 0 };
}
