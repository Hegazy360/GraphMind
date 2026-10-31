/**
 * Close a popover on an outside click or Escape.
 *
 * Extracted because the toolbar grew a second popover: every disclosure in
 * the viewer has to dismiss the same way, and two copies of this drift the
 * moment one of them learns something the other does not.
 */
import { useEffect, type RefObject } from 'react';

export function useDismissable(
  open: boolean,
  close: () => void,
  host: RefObject<HTMLElement | null>,
): void {
  useEffect(() => {
    if (!open) return;
    const onDown = (event: MouseEvent) => {
      if (host.current !== null && !host.current.contains(event.target as Node)) close();
    };
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        // The canvas also listens for Escape (it clears the selection); a
        // popover being open is the more local intent, so it eats the key.
        event.stopPropagation();
        close();
      }
    };
    window.addEventListener('mousedown', onDown);
    window.addEventListener('keydown', onKey, true);
    return () => {
      window.removeEventListener('mousedown', onDown);
      window.removeEventListener('keydown', onKey, true);
    };
  }, [open, close, host]);
}
