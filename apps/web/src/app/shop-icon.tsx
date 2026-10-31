import type { CSSProperties } from "react";

export function ShopIcon({ name, size = 24, style }: { name: "watch" | "search" | "filters" | "bag" | "orders" | "back" | "check"; size?: number; style?: CSSProperties }) {
  return <svg aria-hidden="true" width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round" style={style}>
    {name === "back" ? <path d="m14 5-7 7 7 7" />
      : name === "bag" ? <><path d="M5 7h14l1 14H4L5 7Z" /><path d="M9 8V6a3 3 0 0 1 6 0v2" /></>
      : name === "orders" ? <><rect x="5" y="3" width="14" height="18" rx="3" /><path d="M9 8h6M9 12h6M9 16h4" /></>
      : name === "check" ? <><circle cx="12" cy="12" r="9" /><path d="m8 12 3 3 5-6" /></>
      : name === "watch" ? <><circle cx="12" cy="12" r="6.5" /><path d="m8 6 1-4h6l1 4M8 18l1 4h6l1-4M12 8v4l2.5 1.5" /></>
      : name === "search" ? <><circle cx="10.5" cy="10.5" r="6.5" /><path d="m16 16 5 5" /></>
      : <><path d="M4 7h7m4 0h5M4 17h3m4 0h9" /><circle cx="13" cy="7" r="2" /><circle cx="9" cy="17" r="2" /></>}
  </svg>;
}
