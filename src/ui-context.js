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

// iOS keyboards and zoom change the visible area without changing layout vh.
export function bindDialogViewport(overlay, root, signal) {
    let frame = null;
    const update = () => {
        frame = null;
        const view = viewportSize(root);
        Object.assign(overlay.style, { top: `${view.top}px`, left: `${view.left}px`,
            width: `${view.width}px`, height: `${view.height}px`, right: 'auto', bottom: 'auto' });
    };
    const schedule = () => { if (frame === null) frame = root.requestAnimationFrame(update); };
    const dispose = () => {
        if (frame !== null) root.cancelAnimationFrame(frame);
        frame = null;
        root.removeEventListener('resize', schedule);
        root.visualViewport?.removeEventListener('resize', schedule);
        root.visualViewport?.removeEventListener('scroll', schedule);
        signal?.removeEventListener('abort', dispose);
    };
    update();
    root.addEventListener('resize', schedule);
    root.visualViewport?.addEventListener('resize', schedule);
    root.visualViewport?.addEventListener('scroll', schedule);
    signal?.addEventListener('abort', dispose, { once: true });
    return dispose;
}
