"use client";

import { useEffect, useRef, useState } from "react";
import { Storefront } from "./storefront";

interface AuthResponse {
  user: { firstName: string };
  partner?: { id: string; status: "ACTIVE" | "BLOCKED" } | null;
  partnerTermsReacceptRequired?: boolean;
  csrfToken: string;
  launchTarget?: string;
}

declare global {
  interface Window {
    Telegram?: { WebApp?: { initData: string; ready: () => void; expand: () => void } };
  }
}

export function MiniAppBootstrap() {
  const started = useRef(false);
  const [state, setState] = useState<{ auth?: AuthResponse; error?: string }>({});

  useEffect(() => {
    if (started.current) return;
    started.current = true;
    const webApp = window.Telegram?.WebApp;
    webApp?.ready();
    webApp?.expand();
    const initData = webApp?.initData;
    const reload = performance.getEntriesByType("navigation").some((entry) =>
      (entry as PerformanceNavigationTiming).type === "reload");
    const endpoint = initData ? "/api/v1/auth/telegram" : reload ? "/api/v1/auth/session" : null;
    if (!endpoint) {
      setState({ error: "Откройте приложение через Telegram." });
      return;
    }
    void fetch(endpoint, {
      method: initData ? "POST" : "GET", credentials: "same-origin",
      headers: initData ? { "content-type": "application/json" } : undefined,
      body: initData ? JSON.stringify({ initData }) : undefined, cache: "no-store"
    }).then(async (response) => {
      if (!response.ok) throw new Error("Authentication failed");
      return response.json() as Promise<AuthResponse>;
    }).then((result) => {
      if (result.launchTarget && (window.location.pathname === "/" || result.launchTarget.includes("?product="))) {
        window.history.replaceState(null, "", result.launchTarget);
      }
      setState({ auth: result });
    }).catch(() => setState({ error: "Не удалось войти. Откройте приложение заново через Telegram." }));
  }, []);

  if (state.auth) return <Storefront name={state.auth.user.firstName} csrfToken={state.auth.csrfToken}
    partner={state.auth.partner ?? null} partnerTermsReacceptRequired={state.auth.partnerTermsReacceptRequired ?? false} />;
  return <main className="flex min-h-screen items-center justify-center bg-slate-950 px-6 text-slate-100">
    <div className="text-center"><h1 className="text-2xl font-semibold">Watch</h1>
      <p className="mt-4">{state.error ?? "Вход через Telegram…"}</p></div>
  </main>;
}
