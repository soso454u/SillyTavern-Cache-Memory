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
export function bindDialogViewport(overlay, root, signal, anchor = null) {
    let frame = null;
    const update = () => {
        frame = null;
        const view = viewportSize(root);
        // A confirmation lives within both the plugin frame and the visual viewport.
        // Use viewport coordinates because this overlay is fixed on document.body.
        const rect = anchor?.getBoundingClientRect();
        const left = rect ? Math.max(view.left, rect.left) : view.left;
        const top = rect ? Math.max(view.top, rect.top) : view.top;
        const right = rect ? Math.min(view.left + view.width, rect.right) : view.left + view.width;
        const bottom = rect ? Math.min(view.top + view.height, rect.bottom) : view.top + view.height;
        const width = Math.max(0, right - left), height = Math.max(0, bottom - top);
        Object.assign(overlay.style, { top: `${top}px`, left: `${left}px`,
            width: `${width}px`, height: `${height}px`, right: 'auto', bottom: 'auto' });
        overlay.style.setProperty('--cm-dialog-height', `${height}px`);
    };
    const schedule = () => { if (frame === null) frame = root.requestAnimationFrame(update); };
    const resizeObserver = anchor && root.ResizeObserver ? new root.ResizeObserver(schedule) : null;
    const styleObserver = anchor && root.MutationObserver ? new root.MutationObserver(schedule) : null;
    resizeObserver?.observe(anchor);
    styleObserver?.observe(anchor, { attributes: true, attributeFilter: ['style'] });
    const dispose = () => {
        if (frame !== null) root.cancelAnimationFrame(frame);
        frame = null;
        root.removeEventListener('resize', schedule);
        root.visualViewport?.removeEventListener('resize', schedule);
        root.visualViewport?.removeEventListener('scroll', schedule);
        signal?.removeEventListener('abort', dispose);
        resizeObserver?.disconnect();
        styleObserver?.disconnect();
    };
    update();
    root.addEventListener('resize', schedule);
    root.visualViewport?.addEventListener('resize', schedule);
    root.visualViewport?.addEventListener('scroll', schedule);
    signal?.addEventListener('abort', dispose, { once: true });
    return dispose;
}
