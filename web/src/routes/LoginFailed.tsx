import { useEffect } from "react";
import { useSearchParams } from "react-router-dom";
import { Icon } from "../components/Icon";
import { NEXT_PATH_RE } from "../lib/api";

/** The only way into the CRM: the Turkarta admin issues a fresh SSO link. */
export const ADMIN_SUPPORT_URL = "https://api.turkarta.me/admin/support-crm";

export const LOGIN_FAILED_COPY: Record<string, string> = {
  malformed: "Ссылка для входа повреждена.",
  signature: "Ссылка для входа не прошла проверку.",
  expired: "Ссылка для входа устарела, она действует 60 секунд.",
  role: "Нет доступа: нужна роль администратора или поддержки.",
  replay: "Эта ссылка для входа уже использована.",
  disabled: "Вход в CRM не настроен. Напишите администратору.",
  session: "Сессия закончилась.",
  logout: "Вы вышли.",
};
const FALLBACK = "Не удалось войти.";

export function loginFailedMessage(reason: string | null): string {
  return (reason && Object.hasOwn(LOGIN_FAILED_COPY, reason) ? LOGIN_FAILED_COPY[reason] : undefined) ?? FALLBACK;
}

/** The admin SSO link, carrying the CRM path to return to when it is one the issuer accepts. */
export function adminLoginHref(next: string | null): string {
  return next && NEXT_PATH_RE.test(next) ? `${ADMIN_SUPPORT_URL}?next=${encodeURIComponent(next)}` : ADMIN_SUPPORT_URL;
}

export function LoginFailed() {
  const [params] = useSearchParams();
  const message = loginFailedMessage(params.get("reason"));
  const href = adminLoginHref(params.get("next"));

  useEffect(() => {
    document.title = "Вход в поддержку";
  }, []);

  return (
    <main className="grid min-h-dvh place-items-center bg-bg px-4 py-10 text-text">
      <div className="w-full max-w-sm rounded-md border border-border bg-surface p-6">
        <span
          aria-hidden="true"
          className="mb-5 grid size-8 place-items-center rounded-sm bg-accent text-base font-semibold text-accent-fg"
        >
          П
        </span>
        <h1 className="text-lg font-semibold">{message}</h1>
        <p className="mt-1 text-text-muted">Откройте поддержку заново из админки.</p>
        <a
          href={href}
          className="press mt-5 inline-flex h-9 items-center gap-2 rounded-sm bg-accent px-3.5 font-semibold text-accent-fg no-underline hover:bg-accent-hover"
        >
          <Icon name="login" />
          Войти через админку
        </a>
      </div>
    </main>
  );
}
