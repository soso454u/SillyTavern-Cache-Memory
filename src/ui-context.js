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
    let fullHeight = viewportSize(root).height;
    let fullWidth = root.innerWidth;
    const editable = () => {
        const input = root.document?.activeElement;
        return overlay.contains(input) && input?.matches('input:not([type="checkbox"]):not([type="radio"]), textarea, select, [contenteditable="true"]') ? input : null;
    };
    const keepInputVisible = () => {
        const input = editable();
        if (!input) return;
        const scroller = input.closest('.cache-memory-modal-content, .cache-memory-config-panel');
        if (!scroller) return;
        const bounds = scroller.getBoundingClientRect(), rect = input.getBoundingClientRect();
        const pinned = scroller.querySelector('.cache-memory-pinned');
        const top = Math.max(bounds.top, pinned?.getBoundingClientRect().bottom ?? bounds.top) + 8;
        const bottom = Math.min(bounds.bottom, viewportSize(root).top + viewportSize(root).height) - 8;
        // Scroll the plugin content only; scrolling the page moves fixed dialogs
        // a second time on browsers that already pan for the keyboard.
        if (rect.top < top) scroller.scrollTop += rect.top - top;
        else {
            const visibleBottom = rect.top + Math.min(rect.bottom - rect.top, Math.max(48, bottom - top));
            if (visibleBottom > bottom) scroller.scrollTop += visibleBottom - bottom;
        }
    };
    const update = () => {
        frame = null;
        const view = viewportSize(root);
        // A confirmation lives within both the plugin frame and the visual viewport.
        // Use viewport coordinates because this overlay is fixed on document.body.
        const mobile = (root.matchMedia?.('(pointer: coarse)')?.matches || view.width <= 650);
        const input = editable();
        if (Math.abs(root.innerWidth - fullWidth) > 80) { fullHeight = view.height; fullWidth = root.innerWidth; }
        if (!input && view.height >= fullHeight - 100 || view.height > fullHeight) fullHeight = view.height;
        const keyboard = mobile && Boolean(input) && fullHeight - view.height > 100;
        overlay.dataset.keyboardOpen = String(keyboard);
        // A nested mobile editor uses the visible viewport directly. Intersecting
        // it with its keyboard-resized parent compounds the shrink/pan.
        const stableMain = keyboard && overlay.classList?.contains('cache-memory-overlay');
        const rect = !mobile ? anchor?.getBoundingClientRect() : null;
        const left = rect ? Math.max(view.left, rect.left) : view.left;
        const top = rect ? Math.max(view.top, rect.top) : view.top;
        const right = rect ? Math.min(view.left + view.width, rect.right) : view.left + view.width;
        const bottom = rect ? Math.min(view.top + view.height, rect.bottom) : view.top + view.height;
        const width = Math.max(0, right - left), height = stableMain ? fullHeight : Math.max(0, bottom - top);
        // Keep the main settings window at its normal height when keyboard opens.
        // Only the visible content area scrolls to reveal the focused field.
        overlay.style.setProperty('--cm-keyboard-inset', stableMain ? `${Math.max(0, fullHeight - view.height)}px` : '0px');
        Object.assign(overlay.style, { top: `${top}px`, left: `${left}px`,
            width: `${width}px`, height: `${height}px`, right: 'auto', bottom: 'auto' });
        overlay.style.setProperty('--cm-dialog-height', `${height}px`);
        keepInputVisible();
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
        overlay.removeEventListener('focusin', schedule);
        overlay.removeEventListener('focusout', schedule);
        root.visualViewport?.removeEventListener('resize', schedule);
        root.visualViewport?.removeEventListener('scroll', schedule);
        signal?.removeEventListener('abort', dispose);
        resizeObserver?.disconnect();
        styleObserver?.disconnect();
    };
    update();
    root.addEventListener('resize', schedule);
    overlay.addEventListener('focusin', schedule);
    overlay.addEventListener('focusout', schedule);
    root.visualViewport?.addEventListener('resize', schedule);
    root.visualViewport?.addEventListener('scroll', schedule);
    signal?.addEventListener('abort', dispose, { once: true });
    return dispose;
}
