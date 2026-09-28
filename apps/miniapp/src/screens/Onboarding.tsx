import { useState } from 'react';
import { Button } from '@maxhub/max-ui';
import { api, ApiError } from '../lib/api';
import { bridge } from '../lib/bridge';
import { SectionTitle } from '../components/ui';
import { Icon, type IconName } from '../components/icons';
import { HandbookPicker } from './handbook/HandbookList';
import { resolveScanned } from './handbook/links';
import { DEMO_ROLES } from '../lib/demo';
import type { DemoRole } from '../lib/types';

/** Код как на сервере (bot/guards.ts); из вставленной ссылки-приглашения код достаём сами */
const INVITE_CODE = /H-[A-Z2-9]{4}-[A-Z2-9]{4}/i;

const POINTS: Array<[IconName, string]> = [
  ['search', 'Ищите своими словами — «справка для военкомата», «физра» — прямо в чате с ботом'],
  ['clock', 'Бот напомнит о сроках: заселение, отработки, заявки на стипендию'],
  ['question', 'Не нашли ответ — спросите дежурного студсовета, ответ придёт в чат'],
];

/**
 * Первый запуск без диплинка и без прошлых визитов: отсканировать QR с плаката, выбрать справочник
 * своего факультета, посмотреть демо или войти в команду по приглашению.
 */
export function Onboarding({
  demoEnabled,
  onConnected,
  onOpenHandbook,
  onStartDemo,
}: {
  demoEnabled: boolean;
  onConnected: () => Promise<void>;
  onOpenHandbook: (handbookId: string, start?: string) => void;
  onStartDemo: (role: DemoRole) => Promise<void>;
}) {
  const [code, setCode] = useState('');
  const [busy, setBusy] = useState<null | 'demo' | 'code' | 'scan'>(null);
  const [demoRole, setDemoRole] = useState<DemoRole | null>(null);
  const [error, setError] = useState<{ kind: 'demo' | 'code' | 'scan'; text: string } | null>(null);
  const inviteCode = code.match(INVITE_CODE)?.[0]?.toUpperCase() ?? null;
  const codeValid = inviteCode !== null;

  const run = async (kind: 'demo' | 'code' | 'scan', action: () => Promise<unknown>) => {
    setBusy(kind);
    setError(null);
    try {
      await action();
    } catch (err) {
      const text = err instanceof ApiError ? err.message : kind === 'scan' ? bridge.scanError(err) : 'Не получилось. Попробуйте ещё раз';
      if (!text) return;
      setError({ kind, text });
      bridge.haptic('error');
    } finally {
      setBusy(null);
    }
  };

  const scan = () =>
    run('scan', async () => {
      const value = await bridge.scanQr();
      if (!value) return;
      const target = await resolveScanned(value);
      if (!target || target.kind !== 'handbook') throw new ApiError('bad_qr', 'Это не QR-код справочника', 400);
      bridge.haptic('success');
      onOpenHandbook(target.handbookId, target.start ?? undefined);
    });

  const errorFor = (kind: 'demo' | 'code' | 'scan') =>
    error?.kind === kind ? (
      <span role="alert" className="small hb-error">
        {error.text}
      </span>
    ) : null;

  return (
    <main className="screen">
      <section className="onb-hero">
        <span className="onb-hero__badge" aria-hidden="true"><Icon name="books" size={34} /></span>
        <h1 className="onb-hero__title">Курсор</h1>
        <p className="onb-hero__text">
          Справочник вашего факультета в MAX: справки, сессия, физкультура, общежитие, стипендии — всё, что нужно знать студенту.
        </p>
        <ul className="onb-points">
          {POINTS.map(([icon, text]) => (
            <li key={icon}>
              <span aria-hidden="true">
                <Icon name={icon} />
              </span>
              <span>{text}</span>
            </li>
          ))}
        </ul>
      </section>

      {bridge.canScan ? (
        <section className="card onb-card">
          <span style={{ fontWeight: 600 }}>Есть QR-код с плаката факультета?</span>
          <span className="muted small">Наведите камеру — откроется справочник вашего факультета.</span>
          <Button size="large" stretched loading={busy === 'scan'} onClick={scan}>
            Сканировать QR-код
          </Button>
          {errorFor('scan')}
        </section>
      ) : null}

      <HandbookPicker onOpen={onOpenHandbook} title="Справочники факультетов" hideEmpty />

      {demoEnabled ? (
        <section className="card onb-card onb-card--demo">
          <span style={{ fontWeight: 600 }}>Посмотреть, как это работает</span>
          <span className="muted small">
            Откроется «Модельный университет» с готовым справочником, данные вымышлены. Выберите, кем посмотреть, — роль можно сменить
            в любой момент.
          </span>
          <div className="stack" role="group" aria-label="Роль в демо">
            {DEMO_ROLES.map((item) => (
              <button
                key={item.role}
                type="button"
                className="role-card"
                disabled={busy === 'demo'}
                aria-busy={busy === 'demo' && demoRole === item.role}
                onClick={() => {
                  setDemoRole(item.role);
                  void run('demo', () => onStartDemo(item.role));
                }}
              >
                <span className="role-card__icon" aria-hidden="true">
                  <Icon name={item.icon} size={24} />
                </span>
                <span className="stack" style={{ gap: 2, flex: 1, textAlign: 'left' }}>
                  <span style={{ fontWeight: 600 }}>{item.title}</span>
                  <span className="small muted">{item.text}</span>
                </span>
                <span className="small hb-link__action">{busy === 'demo' && demoRole === item.role ? 'Открываю…' : '›'}</span>
              </button>
            ))}
          </div>
          {errorFor('demo')}
        </section>
      ) : null}

      <SectionTitle>Для редакторов и деканата</SectionTitle>
      <section className="card onb-card">
        <label className="field" htmlFor="invite-code">
          <span className="field__label">Код приглашения в команду справочника</span>
          <input
            id="invite-code"
            className="input"
            autoCapitalize="characters"
            autoComplete="off"
            spellCheck={false}
            placeholder="H-XXXX-XXXX"
            value={code}
            onChange={(e) => setCode(e.target.value.includes('/') ? e.target.value : e.target.value.toUpperCase())}
          />
        </label>
        <span className="faint small">Код или ссылку присылает администратор справочника. Студенту он не нужен — справочник открыт всем.</span>
        <Button
          size="large"
          variant={codeValid ? 'primary' : 'secondary'}
          stretched
          disabled={!codeValid}
          loading={busy === 'code'}
          onClick={() =>
            run('code', async () => {
              await api('/api/bind/invite', { method: 'POST', body: { code: inviteCode } });
              bridge.haptic('success');
              await onConnected();
            })
          }
        >
          Подключиться
        </Button>
        {errorFor('code')}
      </section>
    </main>
  );
}
