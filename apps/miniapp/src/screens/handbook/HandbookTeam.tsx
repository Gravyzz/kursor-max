import { useState } from 'react';
import { Button } from '@maxhub/max-ui';
import { api } from '../../lib/api';
import { bridge } from '../../lib/bridge';
import { useLoad } from '../../lib/useLoad';
import type { HandbookMember } from '../../lib/types';
import { ConfirmSheet, EmptyState, ErrorState, SectionTitle, Sheet, Skeletons } from '../../components/ui';
import { useHandbook } from './context';
import { Icon } from '../../components/icons';
import { avatarTone } from './HandbookContents';

type Kind = 'student' | 'staff';
type MemberRole = 'editor' | 'admin';

const ROLE: Record<MemberRole, string> = { admin: 'Администратор', editor: 'Редактор' };

/**
 * Команда справочника: администратор приглашает студсовет и учебный офис по личной ссылке.
 * Человек открывает ссылку в MAX — и сразу становится редактором, без паролей и списков.
 */
export function HandbookTeam() {
  const hb = useHandbook();
  const { data, error, loading, reload } = useLoad(
    (signal) => api<{ members: HandbookMember[]; role: 'admin' | 'editor' }>(hb.url('/api/handbook-editor/members'), { signal }),
    [hb.handbookId],
    `team:${hb.handbookId}`,
  );
  const [open, setOpen] = useState(false);
  const [fullName, setFullName] = useState('');
  const [kind, setKind] = useState<Kind>('student');
  const [role, setRole] = useState<MemberRole>('editor');
  const [busy, setBusy] = useState(false);
  const [created, setCreated] = useState<{ personId: string; fullName: string; link: string } | null>(null);
  // Кого убрать из команды: подтверждение внутри экрана (confirm() в MAX не работает)
  const [removing, setRemoving] = useState<HandbookMember | null>(null);
  const [removeBusy, setRemoveBusy] = useState(false);
  const [expanded, setExpanded] = useState<string | null>(null);
  const [roleHint, setRoleHint] = useState(false);
  const [editingRole, setEditingRole] = useState<HandbookMember | null>(null);
  const [nextRole, setNextRole] = useState<MemberRole>('editor');
  const [roleBusy, setRoleBusy] = useState(false);

  const changeRole = async () => {
    if (!editingRole || roleBusy) return;
    setRoleBusy(true);
    try {
      await api(hb.url('/api/handbook-editor/members'), {
        method: 'POST', body: { personId: editingRole.personId, role: nextRole },
      });
      setEditingRole(null);
      hb.toast('Роль участника изменена');
      reload();
    } catch (err) { hb.toast((err as Error).message, 'error'); }
    finally { setRoleBusy(false); }
  };

  if (loading && !data) return <Skeletons count={3} />;
  if (error && !data) return <ErrorState error={error} onRetry={reload} />;
  const members = data?.members ?? [];
  // Деканат администрирует справочник по должности и может не числиться в списке — роль берём из ответа
  const isAdmin = data?.role === 'admin';

  const invite = async () => {
    if (fullName.trim().length < 3) {
      hb.toast('Укажите имя и фамилию', 'error');
      return;
    }
    setBusy(true);
    try {
      const result = await api<{ personId: string; code: string; link: string }>(hb.url('/api/handbook-editor/invites'), {
        method: 'POST',
        body: { fullName: fullName.trim(), kind, role },
      });
      setCreated({ personId: result.personId, fullName: fullName.trim(), link: result.link });
      setOpen(false);
      setFullName('');
      reload();
    } catch (err) {
      hb.toast((err as Error).message, 'error');
    } finally {
      setBusy(false);
    }
  };

  const share = async (name: string, link: string) => {
    const text = `${name}, приглашаю вести справочник факультета. Откройте ссылку в MAX:`;
    if (bridge.share(text, link)) return;
    try {
      await navigator.clipboard.writeText(`${text} ${link}`);
      hb.toast('Ссылка скопирована');
    } catch {
      hb.toast('Скопируйте ссылку вручную', 'error');
    }
  };

  const remove = async (member: HandbookMember) => {
    if (removeBusy) return;
    setRemoveBusy(true);
    try {
      await api(hb.url(`/api/handbook-editor/members/${member.personId}`), { method: 'DELETE' });
      hb.toast(`${member.fullName} больше не в команде`);
      // Ссылка-приглашение этого человека отозвана — карточку «Приглашение готово» убираем
      setCreated((current) => (current?.personId === member.personId ? null : current));
      setRemoving(null);
      reload();
    } catch (err) {
      hb.toast((err as Error).message, 'error');
    } finally {
      setRemoveBusy(false);
    }
  };

  return (
    <>
      {/* Кто что делает — подсказка по нажатию, а не постоянный абзац над списком */}
      <div className="hb-page__head">
        <div className="hb-title-row">
          <h1 className="hb-page__title">Команда</h1>
          <button type="button" className="hb-hint-toggle" aria-expanded={roleHint} aria-controls="team-roles-hint" onClick={() => setRoleHint(!roleHint)}>
            <Icon name="question" size={18} />Кто что делает
          </button>
        </div>
        {roleHint ? (
          <div className="hb-hint" id="team-roles-hint" role="note">
            <p><strong>Редактор</strong> готовит страницы и отвечает на вопросы студентов.</p>
            <p><strong>Администратор</strong> публикует страницы, делает объявления и собирает команду.</p>
          </div>
        ) : null}
      </div>

      {created ? (
        <div className="card hb-block" role="status">
          <span style={{ fontWeight: 600 }}>Приглашение готово: {created.fullName}</span>
          <code className="hb-code" style={{ wordBreak: 'break-all' }}>{created.link}</code>
          <span className="faint small">Ссылка личная и действует 30 дней. Откройте её в MAX — бот подключит человека к справочнику.</span>
          <Button variant="primary" size="medium" onClick={() => share(created.fullName, created.link)}>
            Отправить ссылку
          </Button>
        </div>
      ) : null}

      <SectionTitle>Участники · {members.length}</SectionTitle>
      {members.length === 0 ? (
        <EmptyState icon="team" title="Пока никого">Пригласите студсовет — вместе проще наполнять справочник и отвечать на вопросы.</EmptyState>
      ) : <div className="stack">
        {members.map((member) => <article key={member.personId} className="card hb-member">
          <span className={`hb-member-avatar ${avatarTone(member.fullName)}`} aria-hidden="true">{member.fullName.split(/\s+/).filter(Boolean).slice(0, 2).map((word) => word[0]).join('')}</span>
          <span className="stack hb-member-info" style={{ gap: 6 }}>
            <strong>{member.fullName}{member.you ? <span className="muted"> · вы</span> : null}</strong>
            <span className="small muted">{ROLE[member.role]} · {member.connected ? 'в MAX' : 'ждём входа'}</span>
          </span>
          {isAdmin && !member.you ? <button type="button" className="hb-circle hb-member-toggle"
            aria-label={`Действия участника ${member.fullName}`} aria-expanded={expanded === member.personId}
            aria-controls={`member-actions-${member.personId}`} onClick={() => setExpanded(expanded === member.personId ? null : member.personId)}><Icon name="settings" size={20} /></button> : null}
          {isAdmin && !member.you && expanded === member.personId ? <div className="hb-member-actions" id={`member-actions-${member.personId}`}>
            <button type="button" className="hb-chip" onClick={() => { setEditingRole(member); setNextRole(member.role); }}><Icon name="user" size={18} />Изменить роль</button>
            {member.link ? <button type="button" className="hb-chip" onClick={() => share(member.fullName, member.link!)}><Icon name="link" size={18} />Ссылка-приглашение</button> : null}
            <button type="button" className="hb-chip hb-member-remove" aria-label={`Убрать ${member.fullName} из команды`} onClick={() => setRemoving(member)}><Icon name="trash" size={18} />Убрать из команды</button>
          </div> : null}
        </article>)}
      </div>}

      {isAdmin ? (
        <Button variant="primary" size="large" onClick={() => { setCreated(null); setOpen(true); }}>
          Пригласить в команду
        </Button>
      ) : (
        <span className="faint small">Приглашать может администратор справочника.</span>
      )}

      {editingRole ? <Sheet title="Изменить роль" onClose={() => { if (!roleBusy) setEditingRole(null); }} dirty={nextRole !== editingRole.role && !roleBusy}>
        <p className="muted">{editingRole.fullName}</p>
        <div className="hb-field"><span className="hb-field__label">Роль участника</span>
          <div className="hb-chips" role="radiogroup" aria-label="Роль участника">
            {(['editor', 'admin'] as const).map((value) => <button key={value} type="button" role="radio" aria-checked={nextRole === value} disabled={roleBusy} className={`hb-chip ${nextRole === value ? 'hb-chip--on' : ''}`} onClick={() => setNextRole(value)}>{ROLE[value]}</button>)}
          </div>
          <span className="small muted">{nextRole === 'editor' ? 'Готовит страницы и отвечает на вопросы. Публикует администратор.' : 'Публикует страницы и объявления, отвечает на вопросы и управляет командой.'}</span>
        </div>
        <Button variant="primary" size="large" loading={roleBusy} disabled={roleBusy || nextRole === editingRole.role} onClick={changeRole}>Сохранить роль</Button>
      </Sheet> : null}

      {removing ? (
        <ConfirmSheet
          title="Убрать из команды?"
          text={`${removing.fullName} больше не сможет править справочник${removing.link ? ', а ссылка-приглашение перестанет работать' : ''}. Вернуть можно новым приглашением.`}
          confirmLabel="Убрать из команды"
          busy={removeBusy}
          onConfirm={() => void remove(removing)}
          onClose={() => setRemoving(null)}
        />
      ) : null}

      {open ? (
        <Sheet title="Приглашение" onClose={() => setOpen(false)} dirty={fullName.trim().length > 0 && !busy}>
          <label className="hb-field">
            <span className="hb-field__label">Имя и фамилия</span>
            <input className="hb-input" value={fullName} autoFocus maxLength={120} placeholder="Лебедева Ольга" onChange={(event) => setFullName(event.target.value)} />
          </label>
          <div className="hb-field">
            <span className="hb-field__label">Кто это</span>
            <div className="hb-chips" role="radiogroup" aria-label="Кто это">
              {([['student', 'Студсовет'], ['staff', 'Сотрудник']] as const).map(([value, label]) => (
                <button key={value} type="button" role="radio" aria-checked={kind === value} className={`hb-chip ${kind === value ? 'hb-chip--on' : ''}`} onClick={() => setKind(value)}>
                  {label}
                </button>
              ))}
            </div>
          </div>
          <div className="hb-field">
            <span className="hb-field__label">Права</span>
            <div className="hb-chips" role="radiogroup" aria-label="Права">
              {([['editor', 'Редактор'], ['admin', 'Администратор']] as const).map(([value, label]) => (
                <button key={value} type="button" role="radio" aria-checked={role === value} className={`hb-chip ${role === value ? 'hb-chip--on' : ''}`} onClick={() => setRole(value)}>
                  {label}
                </button>
              ))}
            </div>
            <span className="faint small">
              {role === 'editor' ? 'Готовит страницы и отвечает на вопросы; публикует администратор.' : 'Всё, что редактор, плюс публикация, объявления и команда.'}
            </span>
          </div>
          <Button variant="primary" size="large" loading={busy} disabled={busy || fullName.trim().length < 3} onClick={invite}>
            Создать ссылку
          </Button>
        </Sheet>
      ) : null}
    </>
  );
}
