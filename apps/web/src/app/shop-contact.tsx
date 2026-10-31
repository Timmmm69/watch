"use client";

import { useState } from "react";

// Only public username links support an addressed draft. Never use a share picker.
export function contactUrl(contact: string, draft?: string): string | undefined {
  const value = contact.trim();
  if (/^@[a-zA-Z0-9_]+$/.test(value)) {
    const url = new URL(`https://t.me/${value.slice(1)}`);
    if (draft) url.searchParams.set("text", draft);
    return url.href;
  }
  try {
    const url = new URL(value);
    if (["https:", "http:", "mailto:", "tel:"].includes(url.protocol) && !url.username && !url.password) return url.href;
  } catch { /* Display non-link contacts verbatim. */ }
  return undefined;
}

export function ShopContact({ contact = "", draft, label = "Связаться с магазином", primary = false, compact = false }: { contact?: string; draft?: string; label?: string; primary?: boolean; compact?: boolean }) {
  const [copyState, setCopyState] = useState("");
  const url = contactUrl(contact, draft);
  const copy = async () => {
    try { await navigator.clipboard.writeText(draft!); setCopyState("Запрос скопирован. Отправьте его в магазин самостоятельно."); }
    catch { setCopyState("Не удалось скопировать. Выделите и скопируйте текст запроса вручную."); }
  };
  return <section aria-label="Связь с магазином" className="space-y-3 break-words">
    {draft && compact && <details className="buyer-contact-draft"><summary>Текст обращения</summary><p className="whitespace-pre-wrap select-text">{draft}</p><button type="button" className="buyer-text-action" onClick={() => void copy()}>Скопировать запрос</button></details>}
    {draft && !compact && <><p className="whitespace-pre-wrap select-text">{draft}</p>
      <button type="button" className="app-button" onClick={() => void copy()}>Скопировать запрос</button>
      <p className="text-sm text-muted">Запрос отправляете вы. При обращении согласуйте итоговую стоимость и доставку.</p></>}
    {url ? <a className={`app-button${primary ? " app-button-primary" : ""}`} href={url} target="_blank" rel="noopener noreferrer">{label}</a>
      : contact.trim() ? <p>Контакт магазина: <span className="select-text">{contact}</span></p>
      : <p>Контакт магазина пока недоступен. Обратитесь через раздел помощи в Telegram-боте.</p>}
    {copyState && <p role="status">{copyState}</p>}
  </section>;
}
