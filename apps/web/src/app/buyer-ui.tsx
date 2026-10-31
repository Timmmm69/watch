"use client";

import Link from "next/link";
import { useLayoutEffect, useRef, type ReactNode } from "react";
import { ShopIcon } from "./shop-icon";

export function BuyerHeader({ title, backHref, backLabel, subtitle, action }: {
  title: string; backHref: string; backLabel: string; subtitle?: string; action?: ReactNode;
}) {
  return <header className="buyer-header">
    <div className="buyer-topline"><Link className="buyer-back" href={backHref}><ShopIcon name="back" size={20} />{backLabel}</Link>
      <span className="buyer-brand"><ShopIcon name="watch" size={20} />Watch</span></div>
    <div className="buyer-title-row"><h1>{title}</h1>{action}</div>
    {subtitle && <p className="buyer-subtitle">{subtitle}</p>}
  </header>;
}

export function BuyerEmpty({ title, description, children }: { title: string; description: string; children?: ReactNode }) {
  return <section className="buyer-empty"><span className="buyer-empty-icon"><ShopIcon name="bag" size={32} /></span>
    <h2>{title}</h2><p>{description}</p>{children}</section>;
}

export function BuyerNav({ active }: { active: "shop" | "orders" }) {
  return <nav className="buyer-nav" aria-label="Навигация покупателя">
    <Link href="/shop" aria-current={active === "shop" ? "page" : undefined}><ShopIcon name="search" size={22} /><span>Каталог</span></Link>
    <Link href="/cart"><ShopIcon name="bag" size={22} /><span>Корзина</span></Link>
    <Link href="/orders" aria-current={active === "orders" ? "page" : undefined}><ShopIcon name="orders" size={22} /><span>Заказы</span></Link>
  </nav>;
}

// Reserve the actual height, including wrapped feedback and Telegram safe areas.
export function BuyerActionBar({ children, label, inlineOnDesktop = false }: { children: ReactNode; label?: string; inlineOnDesktop?: boolean }) {
  const element = useRef<HTMLElement>(null);
  useLayoutEffect(() => {
    const bar = element.current;
    const shell = bar?.closest<HTMLElement>(".buyer-shell");
    if (!bar || !shell) return;
    const update = () => shell.style.setProperty("--buyer-action-height", getComputedStyle(bar).position === "fixed" ? `${bar.getBoundingClientRect().height}px` : "0px");
    const observer = new ResizeObserver(update);
    observer.observe(bar); update();
    window.addEventListener("resize", update);
    return () => { observer.disconnect(); window.removeEventListener("resize", update); shell.style.removeProperty("--buyer-action-height"); };
  }, []);
  return <section ref={element} role={label ? "group" : undefined} aria-label={label}
    className={`buyer-actionbar${inlineOnDesktop ? " buyer-actionbar-inline" : ""}`}>{children}</section>;
}
