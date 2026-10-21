import type { ReactNode } from "react";
import { Link } from "react-router-dom";
import { Icon } from "./Icon";
import { ChannelDot } from "./TicketRow";
import { toast } from "./Toast";
import { formatDateTime, formatDay, formatMoney, formatNumber, formatStamp } from "../lib/format";
import {
  CHANNEL_LABEL,
  channelOf,
  displayName,
  STATUS_LABEL,
  usePastTickets,
  useTicketUser,
  type TicketDetail,
  type TicketListItem,
  type UserContext,
} from "../lib/tickets";

const cx = (...parts: Array<string | false | null | undefined>) => parts.filter(Boolean).join(" ");

export async function copyText(label: string, value: string): Promise<void> {
  try {
    await navigator.clipboard.writeText(value);
    toast(`Скопировано: ${label}`);
  } catch {
    toast("Не удалось скопировать. Выделите значение и скопируйте вручную.", { tone: "danger" });
  }
}

function CopyValue({ label, value }: { label: string; value: string }) {
  return (
    <button
      type="button"
      onClick={() => void copyText(label, value)}
      title={`Скопировать ${label}`}
      aria-label={`${value}. Скопировать ${label}`}
      className="press hover-surface group -mx-1 flex min-w-0 max-w-full items-center gap-1.5 rounded-xs px-1 text-left"
    >
      <span className="min-w-0 font-mono text-sm [overflow-wrap:anywhere]">{value}</span>
      <Icon name="copy" size={13} className="shrink-0 text-text-muted opacity-0 transition-opacity duration-fast group-hover:opacity-100 group-focus-visible:opacity-100" />
    </button>
  );
}

function Field({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="grid grid-cols-[6.5rem_minmax(0,1fr)] items-baseline gap-2 py-1">
      <dt className="text-sm text-text-muted">{label}</dt>
      <dd className="min-w-0">{children}</dd>
    </div>
  );
}

function Section({ title, children, aside }: { title: string; children: ReactNode; aside?: ReactNode }) {
  return (
    <section className="border-t border-border px-4 py-3 first:border-t-0">
      <div className="mb-1.5 flex items-center justify-between gap-2">
        <h3 className="text-sm font-semibold">{title}</h3>
        {aside}
      </div>
      {children}
    </section>
  );
}

const CARD_STATUS: Record<string, string> = {
  active: "активна",
  frozen: "заморожена",
  blocked: "заблокирована",
  closed: "закрыта",
  pending: "выпускается",
};

const MEMBER_ROLE: Record<string, string> = {
  owner: "Владелец",
  admin: "Администратор",
  employee: "Сотрудник",
  manager: "Менеджер",
};

const MEMBER_STATUS: Record<string, string> = {
  active: "Активен",
  provisioned: "Создан без входа",
  invited: "Приглашен",
  disabled: "Отключен",
  removed: "Удален",
};

const COMPANY_STATUS: Record<string, string> = { active: "Активна", suspended: "Приостановлена" };

const RAIL_LABEL: Record<string, string> = { xhub: "x-hub", bitbanker: "Bitbanker", antarctic: "Antarctic" };

const TOPUP_STATUS: Record<string, string> = {
  paid: "оплачено",
  completed: "зачислено",
  credited: "зачислено",
  pending: "в процессе",
  failed: "ошибка",
  expired: "истекло",
  cancelled: "отменено",
};

interface Props {
  detail: TicketDetail;
  view: string;
  /** Sheet mode below 1280 px: shows a close button. */
  onClose?: () => void;
}

export function UserPanel({ detail, view, onClose }: Props) {
  const { ticket } = detail;
  const account = useTicketUser(ticket.id);
  const user = account.data ?? null;
  const past = usePastTickets(ticket);
  const tgId = ticket.user_tg ?? user?.tg_id ?? null;
  const username = ticket.user_username ?? user?.tg_username ?? null;
  const email = ticket.email ?? user?.email ?? null;
  const others = (past.data ?? []).filter((t) => t.id !== ticket.id);

  return (
    <div className="flex h-full flex-col">
      <div className="flex h-14 shrink-0 items-center gap-2 border-b border-border px-4">
        <h2 className="min-w-0 flex-1 truncate text-md font-semibold">Клиент</h2>
        {onClose && (
          <button
            type="button"
            onClick={onClose}
            aria-label="Закрыть панель"
            className="press hover-surface grid size-8 place-items-center rounded-sm text-text-muted"
          >
            <Icon name="close" />
          </button>
        )}
      </div>
      <div className="min-h-0 flex-1 overflow-y-auto">
        <Section title={user?.found && user.name ? user.name : displayName(ticket)}>
          <dl>
            <Field label="Канал">
              <span className="flex items-center gap-2">
                <ChannelDot ticket={ticket} />
                {CHANNEL_LABEL[channelOf(ticket)]}
              </span>
            </Field>
            {tgId != null && (
              <Field label="TG id">
                <CopyValue label="TG id" value={String(tgId)} />
              </Field>
            )}
            {username && (
              <Field label="Username">
                <CopyValue label="username" value={`@${username}`} />
              </Field>
            )}
            {email && (
              <Field label="Email">
                <CopyValue label="email" value={email} />
                {user?.found && user.email_verified !== undefined && (
                  <span className="text-xs text-text-muted">{user.email_verified ? "подтверждён" : "не подтверждён"}</span>
                )}
              </Field>
            )}
            {ticket.device && <Field label="Устройство">{ticket.device}</Field>}
            {ticket.category && <Field label="Тема">{ticket.category}</Field>}
            <Field label="Создано">
              <span className="num">{formatDateTime(ticket.created_at)}</span>
            </Field>
          </dl>
        </Section>

        <Account user={user} loading={account.isPending} />

        <Section title="Прошлые обращения">
          {past.isLoading ? (
            <div aria-hidden="true" className="flex flex-col gap-2 py-1">
              <div className="h-4 w-4/5 rounded-xs bg-hover" />
              <div className="h-4 w-3/5 rounded-xs bg-hover" />
            </div>
          ) : others.length ? (
            <ul className="-mx-2 flex flex-col">
              {others.map((t) => (
                <PastTicket key={t.id} ticket={t} view={view} />
              ))}
            </ul>
          ) : (
            <p className="text-sm text-text-muted">{past.isError ? "Список не загрузился." : "Других обращений нет."}</p>
          )}
        </Section>
      </div>
    </div>
  );
}

function Account({ user, loading }: { user: UserContext | null; loading: boolean }) {
  if (loading) {
    return (
      <Section title="Аккаунт Turkarta">
        <p className="text-sm text-text-muted">Загружаем аккаунт…</p>
      </Section>
    );
  }
  if (!user) {
    return (
      <Section title="Аккаунт Turkarta">
        <p className="text-sm text-text-muted">Нет данных аккаунта</p>
      </Section>
    );
  }
  if (!user.found) {
    return (
      <Section title="Аккаунт Turkarta">
        <p className="text-sm">Нет аккаунта</p>
      </Section>
    );
  }
  // Cabinet and partner payloads carry no `cards` key: they have no app account.
  const hasApp = user.cards !== undefined;
  return (
    <>
      {hasApp && <AppAccount user={user} />}
      {user.company && <CompanySection company={user.company} />}
      {user.partner && <PartnerSection partner={user.partner} />}
    </>
  );
}

function AppAccount({ user }: { user: UserContext }) {
  const cards = user.cards ?? [];
  const topups = user.recent_topups ?? [];
  return (
    <>
      <Section
        title="Аккаунт Turkarta"
        aside={
          user.admin_url ? <AdminLink href={user.admin_url} /> : undefined
        }
      >
        <dl>
          {user.registered_at && (
            <Field label="Регистрация">
              <span className="num">{formatDay(user.registered_at)}</span>
            </Field>
          )}
          <Field label="KYC">
            <span className="num">{user.kyc_level != null ? `уровень ${formatNumber(user.kyc_level)}` : "не пройден"}</span>
          </Field>
          {user.user_id && (
            <Field label="ID">
              <CopyValue label="ID пользователя" value={user.user_id} />
            </Field>
          )}
          {user.csb_email && (
            <Field label="CSB email">
              <CopyValue label="CSB email" value={user.csb_email} />
            </Field>
          )}
          {user.antarctic_user_id && (
            <Field label="Antarctic ID">
              <CopyValue label="Antarctic ID" value={user.antarctic_user_id} />
            </Field>
          )}
        </dl>
      </Section>
      <Section title="Карты">
        {cards.length ? (
          <ul className="flex flex-col">
            {cards.map((c, i) => (
              <li key={`${c.last4}-${i}`} className="py-1">
                <div className="flex items-baseline gap-2">
                  <span className="num font-mono text-sm">•• {c.last4}</span>
                  <span className="min-w-0 flex-1 truncate text-sm text-text-muted">
                    {[c.plan, CARD_STATUS[c.status] ?? c.status].filter(Boolean).join(", ")}
                  </span>
                  <span className="num text-sm">{formatMoney(c.balance_usd, "USD")}</span>
                </div>
                {/* Which CSB product: tells an e-com card from the others. */}
                {c.product_id && (
                  <div className="truncate font-mono text-xs text-text-muted">product {c.product_id}</div>
                )}
              </li>
            ))}
          </ul>
        ) : (
          <p className="text-sm text-text-muted">Карт нет.</p>
        )}
      </Section>
      <Section title="Пополнения">
        {topups.length ? (
          <ul className="flex flex-col">
            {topups.map((t, i) => (
              <li key={`${t.created_at}-${i}`} className="py-1">
                {t.rail && <p className="text-xs font-semibold text-text-muted">{RAIL_LABEL[t.rail] ?? t.rail}</p>}
                <div className="flex items-baseline gap-2">
                  <span className="num w-14 shrink-0 text-sm text-text-muted">{formatStamp(t.created_at)}</span>
                  <span className="num min-w-0 flex-1 truncate text-sm">
                    {[formatMoney(t.amount_rub, "RUB"), formatMoney(t.amount_usd, "USD")].filter(Boolean).join(" → ")}
                  </span>
                  <span className={cx("shrink-0 text-xs", t.status === "failed" ? "text-danger" : "text-text-muted")}>
                    {TOPUP_STATUS[t.status] ?? t.status}
                  </span>
                </div>
                {/* What to quote to Antarctic when this top-up went wrong. */}
                {t.antarctic && (
                  <dl className="mt-0.5 grid grid-cols-[auto_minmax(0,1fr)] gap-x-2 text-xs text-text-muted">
                    <dt>order</dt>
                    <dd>
                      <CopyValue label="Antarctic order" value={t.antarctic.order_id} />
                    </dd>
                    {t.antarctic.payment_uuid && (
                      <>
                        <dt>uuid</dt>
                        <dd>
                          <CopyValue label="Antarctic uuid" value={t.antarctic.payment_uuid} />
                        </dd>
                      </>
                    )}
                  </dl>
                )}
              </li>
            ))}
          </ul>
        ) : (
          <p className="text-sm text-text-muted">Пополнений нет.</p>
        )}
      </Section>
    </>
  );
}

function AdminLink({ href }: { href: string }) {
  return (
    <a
      href={href}
      target="_blank"
      rel="noopener noreferrer"
      className="press hover-surface -mr-1 flex h-7 items-center gap-1 rounded-sm px-1.5 text-sm text-text-muted"
    >
      Открыть в админке
      <Icon name="external" size={13} />
    </a>
  );
}

export function CompanySection({ company }: { company: NonNullable<UserContext["company"]> }) {
  return (
    <Section title="Компания" aside={company.admin_url ? <AdminLink href={company.admin_url} /> : undefined}>
      <dl>
        <Field label="Название">{company.name}</Field>
        <Field label="Роль">{MEMBER_ROLE[company.role] ?? company.role}</Field>
        <Field label="Статус участника">{MEMBER_STATUS[company.member_status] ?? company.member_status}</Field>
        {company.company_status && (
          <Field label="Статус компании">{COMPANY_STATUS[company.company_status] ?? company.company_status}</Field>
        )}
        {company.active_members != null && (
          <Field label="Сотрудников">
            <span className="num">{formatNumber(company.active_members)}</span>
          </Field>
        )}
        {company.cards != null && (
          <Field label="Карт">
            <span className="num">{formatNumber(company.cards)}</span>
          </Field>
        )}
        {company.card_details_visible_to_admins != null && (
          <Field label="Реквизиты карт админам">{company.card_details_visible_to_admins ? "Да" : "Нет"}</Field>
        )}
      </dl>
    </Section>
  );
}

export function PartnerSection({ partner }: { partner: NonNullable<UserContext["partner"]> }) {
  return (
    <Section title="Партнер" aside={partner.admin_url ? <AdminLink href={partner.admin_url} /> : undefined}>
      <dl>
        <Field label="Название">{partner.name}</Field>
        <Field label="Код">
          <CopyValue label="код партнера" value={partner.code} />
        </Field>
        <Field label="Роль">{MEMBER_ROLE[partner.role] ?? partner.role}</Field>
      </dl>
    </Section>
  );
}

function PastTicket({ ticket: t, view }: { ticket: TicketListItem; view: string }) {
  return (
    <li>
      <Link
        to={`/t/${encodeURIComponent(t.id)}?v=${view}`}
        className="press hover-surface flex flex-col gap-0.5 rounded-sm px-2 py-1.5"
      >
        <span className="flex items-center gap-2 text-xs text-text-muted">
          <span className="num">{formatDay(t.created_at)}</span>
          <span>{STATUS_LABEL[t.status]}</span>
        </span>
        <span className="truncate text-sm">{t.last_message_preview || "Без сообщений"}</span>
      </Link>
    </li>
  );
}
