import { useEffect, useId, useLayoutEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { CircleHelp } from "lucide-react";
/** Existing info-hint vocabulary, portalled so scrollable tables do not clip the explanation. */
export function DashboardHint({text,label="说明"}:{text:string;label?:string}) {
  const [open,setOpen]=useState(false);const [position,setPosition]=useState({left:8,top:8});const id=useId();
  const trigger=useRef<HTMLButtonElement>(null),bubble=useRef<HTMLSpanElement>(null),timer=useRef<ReturnType<typeof setTimeout>|null>(null);
  const cancel=()=>{if(timer.current)clearTimeout(timer.current);};
  const show=()=>{cancel();setOpen(true);};
  const delayHide=()=>{cancel();timer.current=setTimeout(()=>setOpen(false),160);};
  useEffect(()=>()=>cancel(),[]);
  useLayoutEffect(()=>{
    if(!open)return;
    const place=()=>{const r=trigger.current?.getBoundingClientRect(),b=bubble.current?.getBoundingClientRect();if(!r||!b)return;setPosition({left:Math.max(8,Math.min(r.right-b.width,window.innerWidth-b.width-8)),top:r.bottom+b.height+8<window.innerHeight?r.bottom+6:Math.max(8,r.top-b.height-6)});};
    place();window.addEventListener("resize",place);window.addEventListener("scroll",place,true);
    const escape=(e:KeyboardEvent)=>{if(e.key==="Escape"){cancel();setOpen(false)}};
    const outside=(e:PointerEvent)=>{if(!trigger.current?.contains(e.target as Node)&&!bubble.current?.contains(e.target as Node)){cancel();setOpen(false)}};
    document.addEventListener("keydown",escape);document.addEventListener("pointerdown",outside);
    return()=>{window.removeEventListener("resize",place);window.removeEventListener("scroll",place,true);document.removeEventListener("keydown",escape);document.removeEventListener("pointerdown",outside)};
  },[open,text]);
  return <span className="dashboard-hint" onMouseEnter={show} onMouseLeave={delayHide}>
    <button ref={trigger} type="button" aria-label={label} aria-expanded={open} aria-describedby={open?id:undefined} onFocus={show} onBlur={e=>{if(!bubble.current?.contains(e.relatedTarget))delayHide()}} onClick={show}><CircleHelp size={14} aria-hidden="true" /></button>
    {open?createPortal(<span ref={bubble} role="tooltip" id={id} className="dashboard-hint-bubble" style={position} onMouseEnter={cancel} onMouseLeave={delayHide} onFocus={cancel} onBlur={e=>{if(!bubble.current?.contains(e.relatedTarget)&&e.relatedTarget!==trigger.current)delayHide()}}>{text}<button type="button" className="button button-secondary" onClick={()=>{cancel();setOpen(false)}} aria-label="关闭说明">关闭</button></span>,document.body):null}
  </span>;
}
