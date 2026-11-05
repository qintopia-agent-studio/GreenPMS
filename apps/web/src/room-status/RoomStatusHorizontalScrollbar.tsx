import { useLayoutEffect, useRef, type RefObject } from "react";

/** Keep the native horizontal control reachable while the grid's bottom is offscreen. */
export function RoomStatusHorizontalScrollbar({
  scrollRef
}: {
  scrollRef: RefObject<HTMLDivElement | null>;
}) {
  const barRef = useRef<HTMLDivElement>(null);
  const trackRef = useRef<HTMLDivElement>(null);

  useLayoutEffect(() => {
    const scroll = scrollRef.current;
    const bar = barRef.current;
    const track = trackRef.current;
    if (!scroll || !bar || !track) return;

    let frame: number | null = null;
    const syncFromGrid = () => {
      if (bar.scrollLeft !== scroll.scrollLeft) bar.scrollLeft = scroll.scrollLeft;
    };
    const update = () => {
      frame = null;
      const bounds = scroll.getBoundingClientRect();
      const viewportHeight = document.documentElement.clientHeight;
      // Leave the existing scrollbar and all vertical scrolling untouched.
      const visible = scroll.scrollWidth > scroll.clientWidth
        && bounds.top < viewportHeight
        && bounds.bottom > viewportHeight;
      bar.hidden = !visible;
      if (!visible) return;
      bar.style.left = `${bounds.left}px`;
      bar.style.width = `${bounds.width}px`;
      // Use the browser's existing scrollbar thickness, including overlay systems.
      bar.style.height = `${scroll.offsetHeight - scroll.clientHeight || 16}px`;
      track.style.width = `${scroll.scrollWidth}px`;
      syncFromGrid();
    };
    const scheduleUpdate = () => {
      if (frame === null) frame = requestAnimationFrame(update);
    };
    const syncToGrid = () => {
      if (!bar.hidden && scroll.scrollLeft !== bar.scrollLeft) scroll.scrollLeft = bar.scrollLeft;
    };
    const observer = new ResizeObserver(scheduleUpdate);
    observer.observe(scroll);
    if (scroll.firstElementChild) observer.observe(scroll.firstElementChild);
    scroll.addEventListener("scroll", syncFromGrid, { passive: true });
    bar.addEventListener("scroll", syncToGrid, { passive: true });
    window.addEventListener("scroll", scheduleUpdate, { passive: true });
    window.addEventListener("resize", scheduleUpdate);
    update();

    return () => {
      observer.disconnect();
      scroll.removeEventListener("scroll", syncFromGrid);
      bar.removeEventListener("scroll", syncToGrid);
      window.removeEventListener("scroll", scheduleUpdate);
      window.removeEventListener("resize", scheduleUpdate);
      if (frame !== null) cancelAnimationFrame(frame);
    };
  }, [scrollRef]);

  return (
    <div
      ref={barRef}
      className="room-status-horizontal-scrollbar"
      role="region"
      aria-label="横向滚动房态日期"
      tabIndex={0}
      hidden
    >
      <div ref={trackRef} className="room-status-horizontal-scrollbar-track" />
    </div>
  );
}
