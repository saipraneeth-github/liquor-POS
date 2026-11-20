/**
 * Page-wide interface translation. Screens keep their plain English text; this swaps any text node or
 * placeholder / title / aria-label whose whole text is a known phrase, and keeps doing so as React re-renders.
 * Exact whole-phrase matches only, so product names, customer names, amounts and other data are left alone.
 * An element (or ancestor) with translate="no" is skipped. The English original is remembered, so switching
 * language (or back to English) always starts from the real text.
 */
const ATTRS = ['placeholder', 'title', 'aria-label', 'alt'] as const;
const SKIP = new Set(['SCRIPT', 'STYLE', 'TEXTAREA', 'CODE', 'PRE']);

interface Seen { orig: string; shown: string }
const textSeen = new WeakMap<Text, Seen>();
const attrSeen = new WeakMap<Element, Record<string, Seen>>();

let dict: Record<string, string> | null = null;   // null = English (nothing to do)
let observer: MutationObserver | null = null;
let queued = false;
const pending = new Set<Node>();
const pendingAttr = new Set<Element>();

const skipped = (el: Element | null): boolean => {
  for (let e = el; e; e = e.parentElement) if (SKIP.has(e.tagName) || e.getAttribute('translate') === 'no') return true;
  return false;
};

function lookup(raw: string): string | null {
  if (!dict) return null;
  const core = raw.trim();
  if (!core) return null;
  const hit = dict[core.replace(/\s+/g, ' ')];
  if (!hit) return null;
  const lead = raw.slice(0, raw.length - raw.trimStart().length);
  const tail = raw.slice(raw.trimEnd().length);
  return lead + hit + tail;
}

function doText(n: Text) {
  const parent = n.parentElement;
  if (!parent || skipped(parent)) return;
  const seen = textSeen.get(n);
  const current = n.nodeValue ?? '';
  if (seen && current === seen.shown) {                 // our own write: re-derive from the original (language may have changed)
    const next = lookup(seen.orig);
    if (next === null) { n.nodeValue = seen.orig; textSeen.delete(n); }
    else if (next !== current) { n.nodeValue = next; textSeen.set(n, { orig: seen.orig, shown: next }); }
    return;
  }
  const next = lookup(current);                         // new or re-rendered text: `current` is the English original
  if (next === null) { if (seen) textSeen.delete(n); return; }
  n.nodeValue = next;
  textSeen.set(n, { orig: current, shown: next });
}

function doAttrs(el: Element) {
  if (skipped(el)) return;
  const rec = attrSeen.get(el) ?? {};
  for (const a of ATTRS) {
    const cur = el.getAttribute(a);
    if (cur === null) continue;
    const seen = rec[a];
    const orig = seen && cur === seen.shown ? seen.orig : cur;
    const next = lookup(orig);
    if (next === null) { if (seen) { if (cur === seen.shown) el.setAttribute(a, orig); delete rec[a]; } continue; }
    if (next !== cur) el.setAttribute(a, next);
    rec[a] = { orig, shown: next };
  }
  attrSeen.set(el, rec);
}

function walk(root: Node) {
  if (root.nodeType === Node.TEXT_NODE) { doText(root as Text); return; }
  if (root.nodeType !== Node.ELEMENT_NODE) return;
  const el = root as Element;
  doAttrs(el);
  const tw = document.createTreeWalker(el, NodeFilter.SHOW_ELEMENT | NodeFilter.SHOW_TEXT);
  for (let n = tw.nextNode(); n; n = tw.nextNode()) {
    if (n.nodeType === Node.TEXT_NODE) doText(n as Text); else doAttrs(n as Element);
  }
}

function flush() {
  queued = false;
  observer?.disconnect();
  try {
    for (const n of pending) if (n.isConnected) walk(n);
    for (const e of pendingAttr) if (e.isConnected) doAttrs(e);
  } finally {
    pending.clear(); pendingAttr.clear();
    observer?.observe(document.body, OPTS);
  }
}

const OPTS: MutationObserverInit = { subtree: true, childList: true, characterData: true, attributes: true, attributeFilter: [...ATTRS] };

function schedule(n: Node, shallow = false) {
  if (shallow) pendingAttr.add(n as Element); else pending.add(n);
  if (!queued) { queued = true; queueMicrotask(flush); }
}

/** Switch the page to a language. `null` (English) restores every original string. */
export function applyTranslations(next: Record<string, string> | null) {
  dict = next && Object.keys(next).length ? next : null;
  if (typeof document === 'undefined' || !document.body) return;
  if (!observer) {
    observer = new MutationObserver((records) => {
      for (const r of records) {
        if (r.type === 'childList') r.addedNodes.forEach((n) => schedule(n));
        else if (r.type === 'characterData') schedule(r.target);
        else if (r.target.nodeType === Node.ELEMENT_NODE) schedule(r.target, true);
      }
    });
  }
  observer.disconnect();
  walk(document.body);          // re-derives every tracked node from its original (restores English when dict is null)
  observer.observe(document.body, OPTS);
}
