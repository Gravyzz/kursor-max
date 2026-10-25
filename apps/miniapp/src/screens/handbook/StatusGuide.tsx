import { Pill, Sheet } from '../../components/ui';
import { Icon } from '../../components/icons';
import { dateOnly, plural, todayIso } from '../../lib/format';
import { SHARED_STATE, type SharedState } from './SharedCards';

/**
 * Статусы и отметки страниц — одни правила и одни слова для списка редакции, экрана страницы и справки.
 * У каждой отметки есть понятный выход: что сделать и кто это может, — иначе она только раздражает.
 */

type Tone = 'ok' | 'warn' | 'accent' | 'neutral';

/**
 * «Не помогла» требует внимания, только если это заметная доля оценок после последней публикации:
 * четверть из пяти и больше или много жалоб при доле от 20 %. Публикация исправленной страницы
 * обнуляет отсчёт — отметка снимается, пока студенты снова не начнут жаловаться.
 */
export function ratingAttention(helpful: number, notHelpful: number): boolean {
  const votes = helpful + notHelpful;
  const share = notHelpful / Math.max(1, votes);
  return votes >= 5 && (share >= 0.25 || (notHelpful >= 10 && share >= 0.2));
}

export const notHelpfulPercent = (helpful: number, notHelpful: number) => Math.round((notHelpful / Math.max(1, helpful + notHelpful)) * 100);

/** Пора перепроверить: подошёл срок проверки или страницу не подтверждали полгода. */
export function reviewDue(page: { status: string; checkedAt: string | null; reviewAt: string | null }): boolean {
  if (page.status !== 'published') return false;
  const today = todayIso();
  return !page.checkedAt || Date.parse(page.checkedAt) < Date.now() - 180 * 86_400_000 || Boolean(page.reviewAt && page.reviewAt.slice(0, 10) <= today);
}

export type PageStatus = 'draft' | 'review' | 'published' | 'archived';

/** Подпись статуса в карточке страницы: «есть правки» — отдельно, это частый вопрос «почему студенты не видят». */
export function statusPill(status: PageStatus, hasDraft: boolean): { label: string; tone: Tone } {
  if (status === 'published' && hasDraft) return { label: 'Опубликована · правки не опубликованы', tone: 'warn' };
  return {
    draft: { label: 'Черновик', tone: 'neutral' as const },
    review: { label: 'На проверке', tone: 'warn' as const },
    published: { label: 'Опубликована', tone: 'ok' as const },
    archived: { label: 'В архиве', tone: 'neutral' as const },
  }[status];
}

/** Что значит статус и что делать дальше — с учётом роли: редактор не публикует, а отправляет на проверку. */
export function statusHelp(input: { status: PageStatus; hasDraft: boolean; isAdmin: boolean; wasPublished: boolean; isBase?: boolean }): string {
  const { status, hasDraft, isAdmin, wasPublished, isBase } = input;
  const students = isBase ? 'Студенты факультетов' : 'Студенты';
  if (status === 'archived') {
    return isAdmin
      ? `${students} страницу не видят, в поиске её нет. Нужна снова — «Восстановить черновик», затем опубликуйте.`
      : `${students} страницу не видят. Вернуть её из архива может администратор справочника.`;
  }
  if (status === 'review') {
    const old = wasPublished ? ` ${students} пока видят прежнюю версию.` : '';
    return isAdmin
      ? `Страницу прислали на проверку.${old} Посмотрите текст ниже: всё верно — «Опубликовать», нужно поправить — «Вернуть на доработку» с комментарием.`
      : `Вы отправили страницу администратору: он опубликует её или вернёт с комментарием — сообщение придёт в чат.${old} Пока ждёте, можно продолжать править: правки попадут в ту же проверку.`;
  }
  if (status === 'published') {
    if (hasDraft) {
      return isAdmin
        ? `${students} видят прежнюю версию, ваши правки сохранены черновиком. Закончите и нажмите «Опубликовать правки».`
        : `${students} видят прежнюю версию. Ваши правки сохранены — нажмите «На проверку», и администратор их опубликует.`;
    }
    return `${students} видят эту версию и находят её поиском. Чтобы что-то поменять, правьте ниже: изменения сохранятся черновиком и не дойдут до студентов до публикации.`;
  }
  return isAdmin
    ? `${students} страницу не видят — только команда. Допишите и нажмите «Опубликовать».`
    : `${students} страницу не видят — только команда. Допишите и нажмите «На проверку»: администратор получит сообщение и опубликует.`;
}

export interface PageRating {
  helpful: number;
  notHelpful: number;
  recentHelpful: number;
  recentNotHelpful: number;
  since: string | null;
  complaints: Array<{ text: string; at: string }>;
}

/**
 * Почему страница помечена «Требует внимания» и как снять отметку. Показывается на экране страницы
 * сразу под статусом: отметку видно в списке, а здесь — причина, жалобы студентов и шаги.
 */
export function AttentionCard({ rating, due, reviewAt, isAdmin, canVerify, ownerName, isBase }: {
  rating: PageRating | null | undefined;
  due: boolean;
  reviewAt: string | null;
  isAdmin: boolean;
  canVerify: boolean;
  ownerName: string | null;
  isBase?: boolean;
}) {
  const low = Boolean(rating && ratingAttention(rating.recentHelpful, rating.recentNotHelpful));
  if (!low && !due) return null;
  const publishStep = isAdmin ? 'опубликуйте' : 'отправьте на проверку — после публикации';
  return (
    <section className="card hb-why" aria-label="Почему страница требует внимания">
      {low && rating ? (
        <div className="hb-why__item">
          <span className="hb-why__title"><Icon name="warn" size={18} />Студенты отмечают «Не помогла»</span>
          <span className="small">
            {rating.recentNotHelpful} из {rating.recentHelpful + rating.recentNotHelpful} {plural(rating.recentHelpful + rating.recentNotHelpful, 'оценки', 'оценок', 'оценок')}
            {rating.since ? ' после последней публикации' : ''} — {notHelpfulPercent(rating.recentHelpful, rating.recentNotHelpful)}%.
          </span>
          {rating.complaints.length ? (
            <div className="hb-why__quotes">
              <span className="small muted">Что писали студенты:</span>
              {rating.complaints.map((item, index) => <q key={index} className="small">{item.text}</q>)}
            </div>
          ) : <span className="small muted">Комментариев не оставили — посмотрите, что ищут и спрашивают в «Аналитике» и «Вопросах».</span>}
          <span className="small"><b>Как снять отметку:</b> исправьте то, на что жалуются, и {publishStep}. Оценки начнут считаться заново, и отметка уйдёт сама.</span>
        </div>
      ) : null}
      {due ? (
        <div className="hb-why__item">
          <span className="hb-why__title"><Icon name="calendar" size={18} />Пора перепроверить</span>
          <span className="small">
            {reviewAt ? `Срок проверки — ${dateOnly(reviewAt.slice(0, 10))}.` : 'Страницу давно не проверяли.'} Сверьте сроки, адреса, кабинеты и ссылки: студенты видят дату последней проверки.
          </span>
          <span className="small">
            <b>Как снять отметку:</b>{' '}
            {canVerify
              ? <>всё верно — нажмите «Проверено, всё верно» в блоке «Кто отвечает» ниже. Нашли ошибку — исправьте и {isAdmin ? 'опубликуйте' : 'отправьте на проверку'}: публикация тоже продлевает срок.</>
              : <>подтвердить проверку может {ownerName ? `ответственный (${ownerName})` : 'ответственный'}, его замена или администратор{isBase ? ' общей базы' : ''}. Нашли ошибку — исправьте и отправьте на проверку: после публикации срок обновится.</>}
          </span>
        </div>
      ) : null}
    </section>
  );
}

function Entry({ label, tone, what, todo, who }: { label: string; tone: Tone; what: string; todo: string; who?: string }) {
  return (
    <div className="hb-guide__state">
      <Pill tone={tone}>{label}</Pill>
      <span className="small">{what}</span>
      <span className="small"><b>Что сделать:</b> {todo}</span>
      {who ? <span className="small muted">{who}</span> : null}
    </div>
  );
}

/**
 * Справка «Статусы и как с ними работать»: для каждой подписи — что она значит, что сделать и кто может.
 * isBase — общая база университета (там свои слова: «На согласовании», «Пора проверить»).
 */
export function StatusGuide({ isBase = false, hasBase = false, isAdmin }: { isBase?: boolean; hasBase?: boolean; isAdmin: boolean }) {
  const publish = isAdmin ? '«Опубликовать»' : '«На проверку» — опубликует администратор';
  const shared: SharedState[] = ['inherit', 'supplement', 'override', 'behind', 'excluded'];
  return (
    <div className="hb-guide">
      <section className="hb-guide__part">
        <strong>Как это устроено</strong>
        <ol className="hb-guide__steps">
          <li>Правки сохраняются сами через секунду — кнопку «Сохранить» искать не нужно.</li>
          <li>Студенты видят только опубликованную версию. Пока вы правите, у них всё по-старому.</li>
          <li>{isAdmin ? 'Публикуете вы: «Опубликовать» — и студенты сразу видят изменения.' : 'Публикует администратор: вы нажимаете «На проверку», он получает сообщение в чате и публикует или возвращает с комментарием.'}</li>
        </ol>
      </section>

      <section className="hb-guide__part">
        <strong>Статус страницы</strong>
        <Entry label="Черновик" tone="neutral" what="Студенты страницу не видят — только команда." todo={`допишите и нажмите ${publish}.`} />
        <Entry label={isBase ? 'На согласовании' : 'На проверке'} tone="warn"
          what="Страницу прислали администратору. Если она уже была опубликована, студенты пока видят прежнюю версию."
          todo={isAdmin ? 'откройте и проверьте: всё верно — «Опубликовать», нужно поправить — «Вернуть на доработку» и напишите, что именно.' : 'ждите сообщения в чате. Пока ждёте, можно продолжать править — правки попадут в ту же проверку.'} />
        <Entry label="Вернули на доработку" tone="warn" what="Администратор попросил поправить страницу. Причина — в жёлтой плашке на странице."
          todo="исправьте и снова нажмите «На проверку»." />
        <Entry label="Опубликована" tone="ok" what="Студенты видят страницу и находят её поиском." todo="ничего. Чтобы поменять текст, просто правьте — до публикации студенты изменений не увидят." />
        <Entry label="Правки не опубликованы" tone="warn" what="Страница опубликована, но новые правки студенты не видят: у них прежняя версия. Такие страницы попадают в «Требует внимания», чтобы правки не забылись."
          todo={isAdmin ? 'нажмите «Опубликовать правки». Если правки не нужны — верните прежний текст.' : 'нажмите «На проверку» — администратор опубликует.'} />
        <Entry label="В архиве" tone="neutral" what="Страница скрыта от студентов и из поиска, напоминания о её сроках отключены."
          todo={isAdmin ? '«Восстановить черновик», затем опубликуйте.' : 'вернуть страницу может администратор справочника.'} />
      </section>

      <section className="hb-guide__part">
        <strong>Отметки «Требует внимания»</strong>
        <span className="small muted">Красная точка у страницы в списке. Откройте страницу — сверху будет написано, почему отметка стоит и как её снять.</span>
        <Entry label="Не помогла 25%" tone="warn"
          what="Каждый четвёртый студент после последней публикации нажал «Не помогла» (считаем от пяти оценок)."
          todo={`прочитайте комментарии студентов на странице, исправьте и ${isAdmin ? 'опубликуйте' : 'отправьте на проверку'}. После публикации оценки считаются заново — отметка уйдёт сама.`} />
        <Entry label={isBase ? 'Пора проверить' : 'Пора перепроверить'} tone="warn"
          what="Подошёл срок проверки или страницу не подтверждали полгода. Ответственному пришло сообщение в MAX."
          todo="сверьте сроки, кабинеты и ссылки. Всё верно — «Проверено, всё верно» в блоке «Кто отвечает». Нашли ошибку — исправьте и опубликуйте: публикация тоже продлевает срок."
          who="Нажать «Проверено, всё верно» может ответственный, его замена или администратор. Если это не вы — исправьте и отправьте на проверку." />
        {isAdmin ? <Entry label="На проверке" tone="warn" what="Страница ждёт вашей публикации." todo="откройте, проверьте и опубликуйте или верните на доработку." /> : null}
        {!isBase && hasBase ? <Entry label="Уточнение ждёт публикации" tone="warn" what="Редактор дописал уточнение к общей странице университета."
          todo={isAdmin ? '«Из общей базы» → откройте страницу → проверьте блоки → «Опубликовать».' : 'ждите: администратор факультета получил сообщение и опубликует.'} /> : null}
      </section>

      {isBase || hasBase ? (
        <section className="hb-guide__part">
          <strong>{isBase ? 'Как факультеты показывают общую страницу' : 'Общие страницы университета'}</strong>
          {!isBase ? <span className="small muted">Их ведёт университет: обновления приходят сами. Править общий текст факультет не может — только дописать своё или завести свою версию.</span> : null}
          {shared.map((state) => (
            <Entry key={state} label={SHARED_STATE[state].label} tone={SHARED_STATE[state].tone} what={SHARED_STATE[state].students} todo={SHARED_STATE[state].todo} />
          ))}
          {!isBase ? <Entry label="Проверка просрочена" tone="neutral" what="Университет вовремя не подтвердил, что общая страница актуальна."
            todo="факультету ничего делать не нужно — сообщение получил ответственный в университете. Знаете, что у вас иначе, — добавьте уточнение." /> : null}
        </section>
      ) : null}
    </div>
  );
}

export function StatusGuideSheet({ onClose, ...props }: { onClose: () => void; isBase?: boolean; hasBase?: boolean; isAdmin: boolean }) {
  return (
    <Sheet title="Статусы и как с ними работать" onClose={onClose}>
      <StatusGuide {...props} />
    </Sheet>
  );
}
