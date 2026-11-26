import { useLayoutEffect, useRef, type RefObject } from 'react';

const tabbable = 'a[href], button, input, select, textarea, [tabindex]';

export function useOverlayFocus(
  open: boolean,
  panelRef: RefObject<HTMLElement | null>,
  initialFocusRef: RefObject<HTMLElement | null>,
  triggerRef: RefObject<HTMLElement | null>,
  restoreOnClose = true,
) {
  const wasOpen = useRef(false);

  useLayoutEffect(() => {
    if (!open) {
      if (wasOpen.current && restoreOnClose) triggerRef.current?.focus();
      wasOpen.current = false;
      return;
    }

    const panel = panelRef.current;
    if (!panel) return;
    wasOpen.current = true;
    initialFocusRef.current?.focus();

    const keepTabInside = (event: KeyboardEvent) => {
      if (event.key !== 'Tab' || event.defaultPrevented) return;

      const controls = Array.from(panel.querySelectorAll<HTMLElement>(tabbable)).filter(
        el => el.tabIndex >= 0 && !el.matches(':disabled') && !el.closest('[inert]') && el.getClientRects().length > 0,
      );
      const first = controls[0];
      const last = controls.at(-1);
      const active = document.activeElement;
      if (!panel.contains(active) || (event.shiftKey ? active === first : active === last)) {
        event.preventDefault();
        (event.shiftKey ? last : first)?.focus();
      }
    };

    document.addEventListener('keydown', keepTabInside);
    return () => document.removeEventListener('keydown', keepTabInside);
  }, [open, panelRef, initialFocusRef, triggerRef, restoreOnClose]);
}
