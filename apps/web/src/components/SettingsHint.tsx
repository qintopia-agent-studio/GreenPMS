import { useEffect, useId, useLayoutEffect, useRef, useState, type CSSProperties } from "react";
import { createPortal } from "react-dom";
import { CircleHelp } from "lucide-react";
import "./settings-hint.css";

/** Settings-only help; operational warnings remain visible next to the action. */
export function SettingsHint({ text, label = "说明" }: { text: string; label?: string }) {
  const id = useId();
  const trigger = useRef<HTMLButtonElement>(null);
  const bubble = useRef<HTMLSpanElement>(null);
  const hideTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const [open, setOpen] = useState(false);
  const [position, setPosition] = useState<CSSProperties>({ visibility: "hidden" });
  function show() { clearTimeout(hideTimer.current); setOpen(true); }
  function leave() {
    hideTimer.current = setTimeout(() => {
      if (document.activeElement !== trigger.current) setOpen(false);
    }, 120);
  }
  useEffect(() => () => clearTimeout(hideTimer.current), []);
  useLayoutEffect(() => {
    if (!open || !trigger.current || !bubble.current) return;
    const element = bubble.current;
    element.showPopover();
    const anchor = trigger.current.getBoundingClientRect();
    const hint = element.getBoundingClientRect();
    setPosition({
      left: Math.max(12, Math.min(anchor.left, window.innerWidth - hint.width - 12)),
      top: anchor.bottom + hint.height + 20 <= window.innerHeight ? anchor.bottom + 8 : Math.max(12, anchor.top - hint.height - 8),
      visibility: "visible"
    });
    return () => { if (element.matches(":popover-open")) element.hidePopover(); };
  }, [open, text]);
  useEffect(() => {
    if (!open) return;
    const close = () => setOpen(false);
    const outside = (event: PointerEvent) => {
      if (!trigger.current?.contains(event.target as Node) && !bubble.current?.contains(event.target as Node)) close();
    };
    const escape = (event: KeyboardEvent) => {
      if (event.key === "Escape") { event.preventDefault(); event.stopPropagation(); close(); }
    };
    document.addEventListener("pointerdown", outside);
    document.addEventListener("keydown", escape, true);
    window.addEventListener("resize", close);
    window.addEventListener("scroll", close, true);
    return () => {
      document.removeEventListener("pointerdown", outside);
      document.removeEventListener("keydown", escape, true);
      window.removeEventListener("resize", close);
      window.removeEventListener("scroll", close, true);
    };
  }, [open]);
  return <>
    <button ref={trigger} className="settings-hint-trigger" type="button" aria-label={label}
      aria-expanded={open} aria-describedby={open ? id : undefined}
      onPointerEnter={event => { if (event.pointerType === "mouse") show(); }} onPointerLeave={leave}
      onFocus={show} onBlur={() => setOpen(false)} onClick={event => { event.preventDefault(); event.stopPropagation(); show(); }}>
      <CircleHelp aria-hidden="true" size={14} />
    </button>
    {open ? createPortal(<span ref={bubble} id={id} role="tooltip" popover="manual" className="settings-hint-bubble" style={position}
      onPointerEnter={() => clearTimeout(hideTimer.current)} onPointerLeave={leave}>{text}</span>, trigger.current?.closest("dialog") ?? document.body) : null}
  </>;
}
