// Minimal in-app toast store. A module-level list with subscribe/emit so any
// code (e.g. the comment notifier) can push a toast and the <Toaster> renders
// it. Kept tiny on purpose — no dependencies, no provider.

export interface ToastItem {
  id: string;
  title: string;
  body?: string;
  // Optional click handler (e.g. jump to the project). Toaster dismisses
  // the toast after invoking it.
  onClick?: () => void;
}

type Listener = (toasts: ToastItem[]) => void;

let toasts: ToastItem[] = [];
const listeners = new Set<Listener>();
let seq = 0;

function emit() {
  for (const l of listeners) l(toasts);
}

export function pushToast(t: Omit<ToastItem, "id">): string {
  seq += 1;
  const id = `toast_${seq}`;
  // Cap the stack so a burst can't pile up unboundedly.
  toasts = [...toasts.slice(-4), { ...t, id }];
  emit();
  return id;
}

export function dismissToast(id: string) {
  toasts = toasts.filter((t) => t.id !== id);
  emit();
}

export function subscribeToasts(l: Listener): () => void {
  listeners.add(l);
  l(toasts);
  return () => {
    listeners.delete(l);
  };
}
