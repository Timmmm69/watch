import type { CSSProperties } from "react";

export function ShopIcon({ name, size = 24, style }: { name: "watch" | "search" | "filters"; size?: number; style?: CSSProperties }) {
  return <svg aria-hidden="true" width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round" style={style}>
    {name === "watch" ? <><circle cx="12" cy="12" r="6.5" /><path d="m8 6 1-4h6l1 4M8 18l1 4h6l1-4M12 8v4l2.5 1.5" /></>
      : name === "search" ? <><circle cx="10.5" cy="10.5" r="6.5" /><path d="m16 16 5 5" /></>
      : <><path d="M4 7h7m4 0h5M4 17h3m4 0h9" /><circle cx="13" cy="7" r="2" /><circle cx="9" cy="17" r="2" /></>}
  </svg>;
}
