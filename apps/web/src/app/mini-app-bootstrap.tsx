"use client";

import { useEffect, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { Storefront } from "./storefront";
import { CartScreen } from "./cart-client";
import { CheckoutScreen } from "./checkout-client";
import { AdminOrdersScreen } from "./admin-orders-client";
import { AdminReturnsScreen } from "./admin-returns-client";
import { AdminAnalyticsScreen } from "./admin-analytics-client";
import { EarningsScreen } from "./earnings-client";
import { AdminPayoutsScreen, PartnerPayoutsScreen } from "./payouts-client";
import { PartnerDashboard, PartnerOnboarding } from "./partner-client";
import { OrdersScreen } from "./orders-client";
import { AdminInventoryScreen } from "./admin-inventory-client";
import { AdminPartnersScreen } from "./admin-partners-client";
import { AdminCatalogScreen } from "./admin-catalog-client";
import { AdminProductScreen } from "./admin-product-client";

interface AuthResponse {
  user: { firstName: string };
  partner?: { id: string; status: "ACTIVE" | "BLOCKED" } | null;
  partnerTermsReacceptRequired?: boolean;
  csrfToken: string;
  isAdmin?: boolean;
  launchTarget?: string;
}

// A retained Telegram start_param must not override later in-app Cart navigation.
let launchNavigationHandled = false;

declare global {
  interface Window {
    Telegram?: { WebApp?: { initData: string; ready: () => void; expand: () => void;
      BackButton?: { show: () => void; hide: () => void; onClick: (handler: () => void) => void; offClick: (handler: () => void) => void } } };
  }
}

export function MiniAppBootstrap({ screen = "shop", orderId, returnId, payoutId, publicNumber, partnerId, productId }: { screen?: "shop" | "partner" | "onboarding" | "cart" | "checkout" | "orders" | "partnerOrders" | "adminCatalog" | "adminProduct" | "adminPartners" | "adminInventory" | "adminOrders" | "adminReturns" | "adminPayouts" | "adminDashboard" | "adminAnalytics" | "earnings" | "payouts"; orderId?: string; returnId?: string; payoutId?: string; publicNumber?: string; partnerId?: string; productId?: string }) {
  const router = useRouter();
  const started = useRef(false);
  const [state, setState] = useState<{ auth?: AuthResponse; error?: string }>({});

  useEffect(() => {
    if (started.current) return;
    started.current = true;
    const webApp = window.Telegram?.WebApp;
    webApp?.ready();
    webApp?.expand();
    const navigation = performance.getEntriesByType("navigation")[0] as PerformanceNavigationTiming | undefined;
    const initData = !launchNavigationHandled && navigation?.type !== "reload" ? webApp?.initData : undefined;
    const endpoint = initData ? "/api/v1/auth/telegram" : "/api/v1/auth/session";
    void fetch(endpoint, {
      method: initData ? "POST" : "GET", credentials: "same-origin",
      headers: initData ? { "content-type": "application/json" } : undefined,
      body: initData ? JSON.stringify({ initData }) : undefined, cache: "no-store"
    }).then(async (response) => {
      if (!response.ok) throw new Error("Authentication failed");
      return response.json() as Promise<AuthResponse>;
    }).then((result) => {
      const target = result.launchTarget?.includes("?product=") ? result.launchTarget : result.partner ? "/partner" : "/shop";
      if ((!launchNavigationHandled && target.includes("?product=")) || window.location.pathname === "/") {
        launchNavigationHandled = true;
        if (target.startsWith("/shop") && screen === "shop") window.history.replaceState(null, "", target);
        else { router.replace(target); return; }
      }
      launchNavigationHandled = true;
      setState({ auth: result });
    }).catch(() => setState({ error: "Не удалось войти. Откройте приложение заново через Telegram." }));
  }, []);

  const accepted = (auth: AuthResponse) => {
    setState({ auth });
    if (screen === "onboarding") {
      const requested = new URLSearchParams(window.location.search).get("returnTo");
      const destination = requested && /^\/(?:shop|partner)(?:[/?#]|$)/.test(requested) && !requested.startsWith("/partner/onboarding") ? requested : "/partner";
      router.replace(destination);
    } else if (!state.auth?.partner) router.replace("/partner");
  };
  if (state.auth && screen === "partner") return <PartnerDashboard auth={state.auth} onAccepted={accepted} />;
  if (state.auth && screen === "onboarding") return <main className="min-h-screen bg-slate-950 px-5 py-8 text-slate-100"><div className="mx-auto max-w-3xl"><PartnerOnboarding auth={state.auth} onAccepted={accepted} /></div></main>;
  if (state.auth && screen === "orders") return <OrdersScreen key={publicNumber ?? "list"} publicNumber={publicNumber} />;
  if (state.auth && screen === "partnerOrders") return state.auth.partner
    ? <OrdersScreen key={publicNumber ?? "list"} partner blocked={state.auth.partner.status === "BLOCKED"} publicNumber={publicNumber} />
    : <main className="min-h-screen bg-slate-950 p-8 text-slate-100"><p role="alert">Заказы доступны участникам партнёрской программы.</p><a href="/shop">В каталог</a></main>;
  if (state.auth && screen === "adminPartners") return state.auth.isAdmin
    ? <AdminPartnersScreen key={partnerId ?? "list"} csrfToken={state.auth.csrfToken} partnerId={partnerId} />
    : <main className="min-h-screen bg-slate-950 p-8 text-slate-100"><p role="alert">Доступ разрешён только администратору.</p><a href="/shop">В каталог</a></main>;
  if (state.auth && screen === "adminInventory") return state.auth.isAdmin
    ? <AdminInventoryScreen csrfToken={state.auth.csrfToken} />
    : <main className="min-h-screen bg-slate-950 p-8 text-slate-100"><p role="alert">Доступ разрешён только администратору.</p><a href="/shop">В каталог</a></main>;
  if (state.auth && (screen === "adminCatalog" || screen === "adminProduct")) return state.auth.isAdmin
    ? screen === "adminProduct" && productId ? <AdminProductScreen key={productId} csrfToken={state.auth.csrfToken} productId={productId} /> : <AdminCatalogScreen csrfToken={state.auth.csrfToken} />
    : <main className="min-h-screen bg-slate-950 p-8 text-slate-100"><p role="alert">Доступ разрешён только администратору.</p><a href="/shop">В каталог</a></main>;

  if (state.auth && (screen === "adminDashboard" || screen === "adminAnalytics")) return state.auth.isAdmin
    ? <AdminAnalyticsScreen dashboard={screen === "adminDashboard"} />
    : <main className="min-h-screen bg-slate-950 p-8 text-slate-100"><p role="alert">Доступ разрешён только администратору.</p><a href="/shop">В каталог</a></main>;
  if (state.auth && screen === "earnings") return state.auth.partner
    ? <EarningsScreen blocked={state.auth.partner.status === "BLOCKED"} />
    : <main className="min-h-screen bg-slate-950 p-8 text-slate-100"><p role="alert">Доходы доступны участникам партнёрской программы.</p><a href="/shop">В каталог</a></main>;
  if (state.auth && screen === "payouts") return state.auth.partner
    ? <PartnerPayoutsScreen csrfToken={state.auth.csrfToken} blocked={state.auth.partner.status === "BLOCKED"} termsReacceptRequired={state.auth.partnerTermsReacceptRequired ?? false} />
    : <main className="min-h-screen bg-slate-950 p-8 text-slate-100"><p role="alert">Выплаты доступны участникам партнёрской программы.</p><a href="/shop">В каталог</a></main>;
  if (state.auth && screen === "adminOrders") return state.auth.isAdmin
    ? <AdminOrdersScreen key={orderId ?? "list"} csrfToken={state.auth.csrfToken} orderId={orderId} />
    : <main className="min-h-screen bg-slate-950 p-8 text-slate-100"><p role="alert">Доступ к заказам разрешён только администратору.</p><a href="/shop">В каталог</a></main>;
  if (state.auth && screen === "adminReturns") return state.auth.isAdmin
    ? <AdminReturnsScreen key={returnId ?? "list"} csrfToken={state.auth.csrfToken} returnId={returnId} />
    : <main className="min-h-screen bg-slate-950 p-8 text-slate-100"><p role="alert">Доступ к возвратам разрешён только администратору.</p><a href="/shop">В каталог</a></main>;
  if (state.auth && screen === "adminPayouts") return state.auth.isAdmin
    ? <AdminPayoutsScreen key={payoutId ?? partnerId ?? "list"} csrfToken={state.auth.csrfToken} payoutId={payoutId} partnerId={partnerId} />
    : <main className="min-h-screen bg-slate-950 p-8 text-slate-100"><p role="alert">Доступ к выплатам разрешён только администратору.</p><a href="/shop">В каталог</a></main>;
  if (state.auth && screen === "cart") return <CartScreen csrfToken={state.auth.csrfToken} />;
  if (state.auth && screen === "checkout") return <CheckoutScreen csrfToken={state.auth.csrfToken} />;
  if (state.auth) return <Storefront name={state.auth.user.firstName} csrfToken={state.auth.csrfToken}
    partner={state.auth.partner ?? null} partnerTermsReacceptRequired={state.auth.partnerTermsReacceptRequired ?? false} />;
  return <main className="flex min-h-screen items-center justify-center bg-slate-950 px-6 text-slate-100">
    <div className="text-center"><h1 className="text-2xl font-semibold">Watch</h1>
      <p className="mt-4">{state.error ?? "Вход через Telegram…"}</p></div>
  </main>;
}
