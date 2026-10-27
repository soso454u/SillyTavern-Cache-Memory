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

// Capture layout space once. lvh also works when a dialog is first opened
// while a keyboard has already reduced innerHeight on Android.
function layoutViewport(root) {
    let width = root.innerWidth, height = Math.max(root.innerHeight || 0, root.document?.documentElement?.clientHeight || 0);
    if (root.CSS?.supports?.('height', '100lvh') && root.document?.body) {
        const probe = root.document.createElement('div');
        probe.style.cssText = 'position:fixed;visibility:hidden;pointer-events:none;width:100lvw;height:100lvh;inset:0;border:0;padding:0;margin:0;';
        root.document.body.append(probe);
        const rect = probe.getBoundingClientRect();
        width = Math.max(width || 0, rect.width); height = Math.max(height, rect.height);
        probe.remove();
    }
    return { width, height, left: 0, top: 0 };
}

export function lockDialogSize(panel) {
    if (!panel || panel.dataset.memorySizeLocked) return;
    const rect = panel.getBoundingClientRect();
    if (!(rect.width > 0 && rect.height > 0)) return;
    panel.style.width = `${rect.width}px`;
    panel.style.height = `${rect.height}px`;
    panel.dataset.memorySizeLocked = 'true';
}

// Keyboard/focus events may scroll content, never change a window's geometry.
export function bindDialogViewport(overlay, root, signal, anchor = null) {
    let frame = null;
    const view = layoutViewport(root);
    const mobile = root.matchMedia?.('(pointer: coarse)')?.matches || view.width <= 650;
    const rect = !mobile ? anchor?.getBoundingClientRect() : null;
    const left = rect ? Math.max(view.left, rect.left) : view.left;
    const top = rect ? Math.max(view.top, rect.top) : view.top;
    const right = rect ? Math.min(view.width, rect.right) : view.width;
    const bottom = rect ? Math.min(view.height, rect.bottom) : view.height;
    Object.assign(overlay.style, { top: `${top}px`, left: `${left}px`,
        width: `${Math.max(0, right - left)}px`, height: `${Math.max(0, bottom - top)}px`, right: 'auto', bottom: 'auto' });
    overlay.style.setProperty('--cm-dialog-height', `${Math.max(0, bottom - top)}px`);
    lockDialogSize(overlay.querySelector?.('.cache-memory-modal-panel'));
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
        const visible = viewportSize(root);
        const input = editable();
        const inset = Math.max(0, view.height - visible.height);
        const keyboard = mobile && Boolean(input) && inset > 100;
        overlay.dataset.keyboardOpen = String(keyboard);
        overlay.style.setProperty('--cm-keyboard-inset', keyboard ? `${inset}px` : '0px');
        keepInputVisible();
    };
    const schedule = () => { if (frame === null) frame = root.requestAnimationFrame(update); };
    const dispose = () => {
        if (frame !== null) root.cancelAnimationFrame(frame);
        frame = null;
        root.removeEventListener('resize', schedule);
        overlay.removeEventListener('focusin', schedule);
        overlay.removeEventListener('focusout', schedule);
        root.visualViewport?.removeEventListener('resize', schedule);
        root.visualViewport?.removeEventListener('scroll', schedule);
        signal?.removeEventListener('abort', dispose);
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
