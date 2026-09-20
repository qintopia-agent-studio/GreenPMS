import { useEffect, useRef } from "react";

export const ROOM_STATUS_HOVER_OPEN_MS = 250;
export const ROOM_STATUS_HOVER_CLOSE_MS = 220;

// Keep the trigger and its portal in one hover region, including the gap between them.
export class RoomStatusHoverIntent<T> {
  private openTimer: ReturnType<typeof setTimeout> | undefined;
  private closeTimer: ReturnType<typeof setTimeout> | undefined;
  private target: T | undefined;
  constructor(private open: (target: T) => void, private close: () => void) {}
  enter(target: T) {
    this.cancel();
    this.target = target;
    this.openTimer = setTimeout(() => { this.openTimer = undefined; this.open(target); }, ROOM_STATUS_HOVER_OPEN_MS);
  }
  keepOpen() {
    clearTimeout(this.closeTimer);
    this.closeTimer = undefined;
  }
  leave() {
    this.cancel();
    this.closeTimer = setTimeout(() => { this.closeTimer = undefined; this.close(); }, ROOM_STATUS_HOVER_CLOSE_MS);
  }
  cancel() {
    this.target = undefined;
    this.suspend();
  }
  suspend() {
    clearTimeout(this.openTimer);
    clearTimeout(this.closeTimer);
    this.openTimer = this.closeTimer = undefined;
  }
  resume(isStillHovered: (target: T) => boolean) {
    if (this.target !== undefined && isStillHovered(this.target)) this.enter(this.target);
  }
}

export function useRoomStatusHover<T>(options: {
  enabled: boolean;
  contextKey: string;
  isStillHovered: (target: T) => boolean;
  onOpen: (target: T) => void;
  onClose: () => void;
}) {
  const latest = useRef(options);
  latest.current = options;
  const intent = useRef<RoomStatusHoverIntent<T> | null>(null);
  const previousContext = useRef(options.contextKey);
  if (!intent.current) intent.current = new RoomStatusHoverIntent<T>(
    (target) => { if (latest.current.enabled) latest.current.onOpen(target); },
    () => latest.current.onClose()
  );
  useEffect(() => {
    if (previousContext.current !== options.contextKey) intent.current!.cancel();
    else intent.current!.suspend();
    previousContext.current = options.contextKey;
    latest.current.onClose();
    if (options.enabled) intent.current!.resume(latest.current.isStillHovered);
    return () => intent.current!.suspend();
  }, [options.enabled, options.contextKey]);
  useEffect(() => {
    const cancel = () => intent.current!.cancel();
    document.addEventListener("pointerdown", cancel, true);
    document.addEventListener("keydown", cancel, true);
    window.addEventListener("wheel", cancel, { capture: true, passive: true });
    window.addEventListener("blur", cancel);
    return () => {
      document.removeEventListener("pointerdown", cancel, true);
      document.removeEventListener("keydown", cancel, true);
      window.removeEventListener("wheel", cancel, true);
      window.removeEventListener("blur", cancel);
    };
  }, []);
  return intent.current;
}
