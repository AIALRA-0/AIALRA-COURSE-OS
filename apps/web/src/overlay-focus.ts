import { useEffect } from "react";

const focusable = 'button:not(:disabled), a[href], input:not(:disabled), select:not(:disabled), textarea:not(:disabled), [tabindex]:not([tabindex="-1"])';

// All existing dialogs keep their data/actions; this owns only their shared focus lifecycle.
export function useWorkspaceOverlays() {
  useEffect(() => {
    let top: HTMLElement | undefined;
    let returnFocus: HTMLElement | undefined;
    const inerted = new Map<HTMLElement, boolean>();
    const restoreBackground = () => { inerted.forEach((value, node) => { node.inert = value; }); inerted.clear(); };
    const update = () => {
      const dialogs = [...document.querySelectorAll<HTMLElement>('[role="dialog"][aria-modal="true"]')];
      const next = dialogs.at(-1);
      if (next === top) return;
      restoreBackground();
      if (!next) {
        top = undefined;
        if (returnFocus?.isConnected) returnFocus.focus({ preventScroll: true });
        returnFocus = undefined;
        return;
      }
      if (!top) returnFocus = document.activeElement instanceof HTMLElement ? document.activeElement : undefined;
      top = next;
      let child: HTMLElement = next;
      while (child.parentElement && child.parentElement !== document.body) {
        for (const sibling of child.parentElement.children) {
          if (sibling !== child && sibling instanceof HTMLElement && !["SCRIPT", "STYLE"].includes(sibling.tagName)) {
            inerted.set(sibling, sibling.inert); sibling.inert = true;
          }
        }
        child = child.parentElement;
      }
      if (!next.contains(document.activeElement)) {
        const target = next.querySelector<HTMLElement>('[autofocus], ' + focusable);
        if (target) target.focus({ preventScroll: true });
        else { next.tabIndex = -1; next.focus(); }
      }
    };
    const onKey = (event: KeyboardEvent) => {
      if (!top || event.key !== "Tab") return;
      const nodes = [...top.querySelectorAll<HTMLElement>(focusable)].filter(node => node.getClientRects().length && !node.closest('[inert]'));
      const first = nodes[0], last = nodes.at(-1);
      if (!first) { event.preventDefault(); top.focus(); }
      else if (event.shiftKey && (document.activeElement === first || !top.contains(document.activeElement))) { event.preventDefault(); last?.focus(); }
      else if (!event.shiftKey && (document.activeElement === last || !top.contains(document.activeElement))) { event.preventDefault(); first.focus(); }
    };
    const observer = new MutationObserver(update);
    observer.observe(document.getElementById("root") ?? document.body, { childList: true, subtree: true });
    document.addEventListener("keydown", onKey, true);
    update();
    return () => { observer.disconnect(); document.removeEventListener("keydown", onKey, true); restoreBackground(); };
  }, []);
}
