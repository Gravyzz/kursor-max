import { useState } from 'react';
import { Button } from '@maxhub/max-ui';
import type { ShowToast } from '../../app/context';
import { api } from '../../lib/api';
import { bridge } from '../../lib/bridge';
import { useLoad } from '../../lib/useLoad';
import { dateOnly, plural } from '../../lib/format';
import { EmptyState, ErrorState, Pill, Sheet, Skeletons } from '../../components/ui';
import { Icon } from '../../components/icons';

interface PlatformData {
  timezones: string[];
  demoSandboxes7d: number;
  universities: Array<{
    id: string;
    name: string;
    shortName: string;
    timezone: string;
    createdAt: string;
    faculties: number;
    basePages: number;
    readers: number;
    admins: Array<{ personId: string; name: string; connected: boolean }>;
  }>;
}

/** Подписи часовых поясов: вуз выбирает свой город, а не идентификатор IANA. */
const ZONES: Record<string, string> = {
  'Europe/Kaliningrad': 'Калининград (МСК−1)', 'Europe/Moscow': 'Москва (МСК)', 'Europe/Samara': 'Самара (МСК+1)',
  'Asia/Yekaterinburg': 'Екатеринбург (МСК+2)', 'Asia/Omsk': 'Омск (МСК+3)', 'Asia/Novosibirsk': 'Новосибирск (МСК+4)',
  'Asia/Tomsk': 'Томск (МСК+4)', 'Asia/Krasnoyarsk': 'Красноярск (МСК+4)', 'Asia/Irkutsk': 'Иркутск (МСК+5)',
  'Asia/Yakutsk': 'Якутск (МСК+6)', 'Asia/Vladivostok': 'Владивосток (МСК+7)', 'Asia/Magadan': 'Магадан (МСК+8)',
  'Asia/Kamchatka': 'Камчатка (МСК+9)',
};
const word = (n: number, one: string, few: string, many: string) => `${n} ${plural(n, one, few, many)}`;
const initials = (name: string) => name.split(/\s+/).slice(0, 2).map((part) => part[0] ?? '').join('').toUpperCase();

/**
 * Кабинет платформы — для команды Курсора. Подключить вуз = создать организацию и выдать личную ссылку
 * администратору университета. Дальше вуз работает сам: факультеты подключает администратор университета.
 */
export function PlatformShell({ toast, onClose }: { toast: ShowToast; onClose?: () => void }) {
  const { data, error, loading, reload } = useLoad((signal) => api<PlatformData>('/api/platform', { signal }), [], 'platform');
  const [createAsk, setCreateAsk] = useState(false);
  const [adminFor, setAdminFor] = useState<{ id: string; name: string } | null>(null);
  const [link, setLink] = useState<{ title: string; text: string; link: string; for: string } | null>(null);

  const share = async (who: string, value: string) => {
    const text = `${who}, вы назначены администратором университета в «Курсоре». Откройте личную ссылку в MAX:`;
    if (bridge.share(text, value)) return;
    try {
      await navigator.clipboard.writeText(`${text} ${value}`);
      toast('Ссылка скопирована');
    } catch {
      toast('Скопируйте ссылку вручную', 'error');
    }
  };
  const resend = async (personId: string, who: string) => {
    try {
      const result = await api<{ link: string; renewed: boolean; expiresAt: string | null }>(`/api/platform/admins/${personId}/resend`, { method: 'POST', body: {} });
      setLink(result.renewed
        ? { title: 'Новая ссылка', text: 'Прежняя ссылка истекла — эта действует 30 дней.', link: result.link, for: who }
        : { title: 'Ссылка ещё действует', text: `Отправьте её ещё раз — она работает${result.expiresAt ? ` до ${dateOnly(result.expiresAt)}` : ''}, пока ей не воспользовались.`, link: result.link, for: who });
    } catch (err) { toast((err as Error).message, 'error'); }
  };

  return (
    <>
      <div className="uni-top">
        <span className="uni-space"><span className="uni-space__mark" aria-hidden="true"><Icon name="shield" size={18} /></span>Команда Курсора</span>
        {onClose ? <button type="button" className="hb-circle" aria-label="Закрыть кабинет платформы" onClick={onClose}><Icon name="close" /></button> : null}
      </div>
      <div className="hb-page__head hb-team-heading">
        <span className="stack" style={{ gap: 2 }}><span className="small uni-eyebrow">Кабинет платформы</span><h1 className="hb-page__title">Вузы</h1></span>
        <button type="button" className="hb-circle" aria-label="Подключить вуз" onClick={() => setCreateAsk(true)}><Icon name="plus" /></button>
      </div>
      <section className="card stack" style={{ gap: 6 }}>
        <span className="small">Подключите вуз — его администратор получит личную ссылку в MAX, заполнит общую базу и сам подключит факультеты.</span>
        {data ? <span className="small muted">{word(data.universities.length, 'вуз подключён', 'вуза подключено', 'вузов подключено')} · демо открыли {word(data.demoSandboxes7d, 'раз', 'раза', 'раз')} за 7 дней</span> : null}
      </section>

      {loading && !data ? <Skeletons count={3} /> : null}
      {error && !data ? <ErrorState error={error} onRetry={reload} /> : null}
      {data && data.universities.length === 0 ? <EmptyState icon="uni" title="Вузов пока нет">Подключите первый вуз — администратор получит ссылку и начнёт с общей базы.</EmptyState> : null}

      {data?.universities.map((u) => (
        <section key={u.id} className="card uni-faculty">
          <div className="row uni-faculty__head">
            <span className="uni-badge" aria-hidden="true">{u.shortName.slice(0, 6)}</span>
            <span className="stack" style={{ gap: 2, minWidth: 0 }}>
              <strong>{u.name}</strong>
              <span className="small muted">{ZONES[u.timezone] ?? u.timezone} · с {dateOnly(String(u.createdAt).slice(0, 10))}</span>
            </span>
          </div>
          <span className="hb-tags">
            <Pill tone={u.faculties ? 'ok' : 'neutral'}>{word(u.faculties, 'факультет', 'факультета', 'факультетов')}</Pill>
            <Pill tone={u.basePages ? 'ok' : 'warn'}>{u.basePages ? `общая база: ${word(u.basePages, 'страница', 'страницы', 'страниц')}` : 'общая база пустая'}</Pill>
            <Pill tone="neutral">{word(u.readers, 'читатель', 'читателя', 'читателей')}</Pill>
          </span>
          <div className="uni-admins">
            {u.admins.map((a) => (
              <div key={a.personId} className="row" style={{ gap: 10 }}>
                <span className={`uni-avatar ${a.connected ? '' : 'uni-avatar--pending'}`} aria-hidden="true">{initials(a.name)}</span>
                <span className="stack hb-reader-grow" style={{ gap: 0 }}>
                  <strong className="small">{a.name}</strong>
                  <span className={`small ${a.connected ? 'muted' : 'uni-pending'}`}>{a.connected ? 'Администратор университета' : 'Ещё не вошёл по ссылке'}</span>
                </span>
                {!a.connected ? <button type="button" className="linkbtn small" onClick={() => void resend(a.personId, a.name)}>Ссылка</button> : null}
              </div>
            ))}
          </div>
          <Button variant="secondary" size="medium" onClick={() => setAdminFor({ id: u.id, name: u.shortName })}><Icon name="plus" size={18} />Добавить администратора</Button>
        </section>
      ))}

      {createAsk ? <CreateUniversitySheet zones={data?.timezones ?? Object.keys(ZONES)} toast={toast} onClose={() => setCreateAsk(false)}
        onCreated={(result, who, name) => { setCreateAsk(false); setLink({ title: `${name} подключён`, text: 'Отправьте ссылку администратору университета. Он заполнит общую базу и подключит факультеты из своего кабинета.', link: result, for: who }); reload(); }} /> : null}
      {adminFor ? <AddAdminSheet university={adminFor} toast={toast} onClose={() => setAdminFor(null)}
        onAdded={(result, who) => { setAdminFor(null); setLink({ title: 'Администратор добавлен', text: 'Отправьте ему личную ссылку.', link: result, for: who }); reload(); }} /> : null}
      {link ? (
        <Sheet title={link.title} onClose={() => setLink(null)}>
          <span className="small">{link.text}</span>
          <label className="hb-field"><span className="hb-field__label">Личная ссылка для: {link.for}</span>
            <input className="hb-input" readOnly value={link.link} onFocus={(event) => event.currentTarget.select()} />
          </label>
          <span className="faint small">Ссылка личная: по ней человек станет администратором университета. Отправьте её только адресату.</span>
          <Button variant="primary" size="large" onClick={() => void share(link.for, link.link)}><Icon name="send" size={18} />Отправить</Button>
        </Sheet>
      ) : null}
    </>
  );
}

function CreateUniversitySheet({ zones, toast, onClose, onCreated }: {
  zones: string[];
  toast: ShowToast;
  onClose: () => void;
  onCreated: (link: string, who: string, name: string) => void;
}) {
  const [name, setName] = useState('');
  const [short, setShort] = useState('');
  const [timezone, setTimezone] = useState('Europe/Moscow');
  const [admin, setAdmin] = useState('');
  const [busy, setBusy] = useState(false);
  const ready = name.trim().length >= 3 && short.trim().length >= 2 && admin.trim().split(/\s+/).length >= 2;
  const create = async () => {
    if (!ready || busy) return;
    setBusy(true);
    try {
      const result = await api<{ link: string }>('/api/platform/universities', {
        method: 'POST', body: { name: name.trim(), shortName: short.trim(), timezone, adminFullName: admin.trim() },
      });
      onCreated(result.link, admin.trim(), short.trim());
    } catch (err) { toast((err as Error).message, 'error'); }
    finally { setBusy(false); }
  };
  return (
    <Sheet title="Подключить вуз" onClose={onClose} dirty={Boolean(name.trim() || short.trim() || admin.trim()) && !busy}>
      <label className="hb-field"><span className="hb-field__label">Полное название</span>
        <input className="hb-input" value={name} maxLength={200} autoFocus placeholder="Например: Томский государственный университет" onChange={(event) => setName(event.target.value)} />
      </label>
      <label className="hb-field"><span className="hb-field__label">Коротко</span>
        <input className="hb-input" value={short} maxLength={24} placeholder="Например: ТГУ" onChange={(event) => setShort(event.target.value)} />
      </label>
      <label className="hb-field"><span className="hb-field__label">Часовой пояс — по нему считаются сроки и напоминания</span>
        <select className="hb-input hb-select" value={timezone} onChange={(event) => setTimezone(event.target.value)}>
          {zones.map((zone) => <option key={zone} value={zone}>{ZONES[zone] ?? zone}</option>)}
        </select>
      </label>
      <label className="hb-field"><span className="hb-field__label">Администратор университета — фамилия, имя, отчество</span>
        <input className="hb-input" value={admin} maxLength={120} autoComplete="off" placeholder="Например: Орлова Марина Викторовна" onChange={(event) => setAdmin(event.target.value)} onKeyDown={(event) => { if (event.key === 'Enter') void create(); }} />
      </label>
      <Button variant="primary" size="large" loading={busy} disabled={!ready || busy} onClick={create}>Подключить и получить ссылку</Button>
      {!ready && (name || short || admin) ? <span className="faint small">{name.trim().length < 3 ? 'Название — от 3 символов' : short.trim().length < 2 ? 'Короткое название — от 2 символов' : 'Укажите фамилию и имя администратора'}</span> : null}
    </Sheet>
  );
}

function AddAdminSheet({ university, toast, onClose, onAdded }: {
  university: { id: string; name: string };
  toast: ShowToast;
  onClose: () => void;
  onAdded: (link: string, who: string) => void;
}) {
  const [fullName, setFullName] = useState('');
  const [busy, setBusy] = useState(false);
  const ready = fullName.trim().split(/\s+/).length >= 2;
  const add = async () => {
    if (!ready || busy) return;
    setBusy(true);
    try {
      const result = await api<{ link: string }>(`/api/platform/universities/${university.id}/admins`, { method: 'POST', body: { fullName: fullName.trim() } });
      onAdded(result.link, fullName.trim());
    } catch (err) { toast((err as Error).message, 'error'); }
    finally { setBusy(false); }
  };
  return (
    <Sheet title={`Администратор · ${university.name}`} onClose={onClose} dirty={Boolean(fullName.trim()) && !busy}>
      <label className="hb-field"><span className="hb-field__label">Фамилия, имя, отчество</span>
        <input className="hb-input" value={fullName} maxLength={120} autoFocus autoComplete="off" placeholder="Например: Ким Алексей Сергеевич" onChange={(event) => setFullName(event.target.value)} onKeyDown={(event) => { if (event.key === 'Enter') void add(); }} />
      </label>
      <span className="faint small">Например, замена на время отпуска. Права те же, что у первого администратора.</span>
      <Button variant="primary" size="large" loading={busy} disabled={!ready || busy} onClick={add}>Добавить и получить ссылку</Button>
    </Sheet>
  );
}
