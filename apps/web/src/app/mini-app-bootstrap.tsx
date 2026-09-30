"use client";

import { useEffect, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { Storefront } from "./storefront";
import { CartScreen } from "./cart-client";

interface AuthResponse {
  user: { firstName: string };
  partner?: { id: string; status: "ACTIVE" | "BLOCKED" } | null;
  partnerTermsReacceptRequired?: boolean;
  csrfToken: string;
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

export function MiniAppBootstrap({ screen = "shop" }: { screen?: "shop" | "cart" }) {
  const router = useRouter();
  const started = useRef(false);
  const [state, setState] = useState<{ auth?: AuthResponse; error?: string }>({});

  useEffect(() => {
    if (started.current) return;
    started.current = true;
    const webApp = window.Telegram?.WebApp;
    webApp?.ready();
    webApp?.expand();
    const initData = webApp?.initData;
    const endpoint = initData ? "/api/v1/auth/telegram" : "/api/v1/auth/session";
    void fetch(endpoint, {
      method: initData ? "POST" : "GET", credentials: "same-origin",
      headers: initData ? { "content-type": "application/json" } : undefined,
      body: initData ? JSON.stringify({ initData }) : undefined, cache: "no-store"
    }).then(async (response) => {
      if (!response.ok) throw new Error("Authentication failed");
      return response.json() as Promise<AuthResponse>;
    }).then((result) => {
      if (!launchNavigationHandled && result.launchTarget && (window.location.pathname === "/" || result.launchTarget.includes("?product="))) {
        if (screen === "cart") router.replace(result.launchTarget);
        else window.history.replaceState(null, "", result.launchTarget);
      }
      launchNavigationHandled = true;
      setState({ auth: result });
    }).catch(() => setState({ error: "Не удалось войти. Откройте приложение заново через Telegram." }));
  }, []);

  if (state.auth && screen === "cart") return <CartScreen csrfToken={state.auth.csrfToken} />;
  if (state.auth) return <Storefront name={state.auth.user.firstName} csrfToken={state.auth.csrfToken}
    partner={state.auth.partner ?? null} partnerTermsReacceptRequired={state.auth.partnerTermsReacceptRequired ?? false} />;
  return <main className="flex min-h-screen items-center justify-center bg-slate-950 px-6 text-slate-100">
    <div className="text-center"><h1 className="text-2xl font-semibold">Watch</h1>
      <p className="mt-4">{state.error ?? "Вход через Telegram…"}</p></div>
  </main>;
}
