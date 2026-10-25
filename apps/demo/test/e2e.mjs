/**
 * Сквозной сценарий из README в настоящем браузере: собранная страница демо (dist/demo.html),
 * где бот, API и PostgreSQL работают на том же коде, что и в MAX.
 *
 * Проверяет то, что видит человек, — по текстам и доступным именам кнопок, а не по классам вёрстки:
 * тест переживает редизайн, но заметит, если сценарий сломался.
 *
 * Запуск: npm run build && npm run e2e   (скриншоты шагов — в test/e2e-output/)
 */
import { chromium } from 'playwright';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const out = path.join(here, 'e2e-output');
await mkdir(out, { recursive: true });

// Страница демо собирается без <html>/<head> — их добавляет хостинг артефактов. Оборачиваем сами.
const body = await readFile(path.join(here, '..', 'dist', 'demo.html'), 'utf8');
const pagePath = path.join(tmpdir(), `handbook-demo-e2e-${process.pid}.html`);
await writeFile(pagePath, `<!doctype html><html lang="ru"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"></head><body>${body}</body></html>`);

const failures = [];
let step = 0;
const check = (name, ok, detail) => {
  console.log(`${ok ? '✔' : '✖'} ${name}${!ok && detail !== undefined ? ` — ${String(detail).slice(0, 300)}` : ''}`);
  if (!ok) failures.push(name);
};

const browser = await chromium.launch();
const context = await browser.newContext({ viewport: { width: 1360, height: 900 } });
const page = await context.newPage();
const pageErrors = [];
page.on('pageerror', (error) => pageErrors.push(String(error)));
// Внешние шрифты в CI могут быть недоступны — не ждём их
await page.route(/fonts\.(googleapis|gstatic)\.com/, (route) => route.abort());

const app = () => page.frameLocator('.phone__screen iframe');
const dock = () => app().getByRole('navigation', { name: 'Навигация справочника' });
const lastBot = () => page.locator('.msg--bot').last();
const shot = async (name) => {
  step += 1;
  await page.screenshot({ path: path.join(out, `${String(step).padStart(2, '0')}-${name}.png`) });
};
const visible = async (locator, timeout = 8000) => {
  try {
    await locator.first().waitFor({ state: 'visible', timeout });
    return true;
  } catch {
    return false;
  }
};
const say = async (text) => {
  await page.locator('#chat-text').fill(text);
  await page.keyboard.press('Enter');
};
const openTab = async (name) => {
  await page.locator('.phone__reload', { hasText: name }).click();
  await page.waitForTimeout(600);
};
const go = async (name) => {
  await dock().getByRole('button', { name, exact: true }).click();
  await dock().getByRole('button', { name, exact: true }).and(app().locator('[aria-current="page"]')).waitFor();
};
// Документ мини-приложения во фрейме — чтобы подменить сеть, как на медленном мобильном интернете
const appFrame = async () => (await page.locator('.phone__screen iframe').elementHandle()).contentFrame();

// Меняем ширину самого мини-приложения, сохраняя рядом чат MAX и его тестовые кнопки.
const setAppWidth = async (width) => {
  await page.evaluate((value) => {
    let style = document.getElementById('e2e-viewport');
    if (!style) {
      style = document.createElement('style');
      style.id = 'e2e-viewport';
      document.head.append(style);
    }
    style.textContent = `.stage { grid-template-columns: minmax(0, 1fr) ${value + 20}px !important; } .phone { max-width: none !important; min-width: 0 !important; } .phone__screen, .phone__screen iframe { width: ${value}px !important; min-width: 0 !important; }`;
  }, width);
  await (await appFrame()).waitForFunction((value) => window.innerWidth === value, width);
};

const checkLayout = async (name, width) => {
  const layout = await (await appFrame()).evaluate(() => {
    const maxWidth = document.documentElement.clientWidth;
    const outside = Array.from(document.querySelectorAll('button, input, textarea, select, [role="tablist"], [role="navigation"]'))
      .filter((element) => {
        const box = element.getBoundingClientRect();
        const css = getComputedStyle(element);
        // Горизонтальная лента (например, «Часто ищут») прокручивается сама — её пункты за краем экрана не ошибка
        const inScroller = (() => { for (let node = element.parentElement; node; node = node.parentElement) { const x = getComputedStyle(node).overflowX; if (x === 'auto' || x === 'scroll') return true; } return false; })();
        return box.width > 0 && box.height > 0 && css.visibility !== 'hidden' && !inScroller && (box.left < -1 || box.right > maxWidth + 1);
      })
      .map((element) => element.getAttribute('aria-label') || element.textContent?.trim().slice(0, 70) || element.tagName);
    const nav = document.querySelector('nav[aria-label^="Навигация"]');
    const navBox = nav?.getBoundingClientRect();
    const smallTargets = Array.from(nav?.querySelectorAll('button') ?? [])
      .filter((element) => {
        const box = element.getBoundingClientRect();
        return box.width < 40 || box.height < 40;
      })
      .map((element) => element.getAttribute('aria-label') || element.textContent?.trim());
    return {
      width: window.innerWidth, scrollWidth: document.documentElement.scrollWidth, outside, smallTargets,
      hasDock: Boolean(nav), dockVisible: Boolean(navBox && navBox.top >= 0 && navBox.bottom <= window.innerHeight + 1),
    };
  });
  check(`${name}: нет горизонтального выхода на ${width} px`, layout.width === width && layout.scrollWidth <= width + 1 && layout.outside.length === 0, JSON.stringify(layout));
  if (layout.hasDock) {
    check(`${name}: док виден, кнопки не меньше 40 px на ${width} px`, layout.dockVisible && layout.smallTargets.length === 0, JSON.stringify(layout));
  }
};

// Контраст реальных токенов на обоих концах градиента и вторичной кнопки.
const checkContrast = async (theme) => {
  const ratios = await (await appFrame()).evaluate(() => {
    const root = document.querySelector('.pd-app');
    const style = getComputedStyle(root);
    const canvas = document.createElement('canvas');
    canvas.width = canvas.height = 1;
    const ctx = canvas.getContext('2d', { willReadFrequently: true });
    const rgb = (color) => { ctx.clearRect(0, 0, 1, 1); ctx.fillStyle = color; ctx.fillRect(0, 0, 1, 1); return [...ctx.getImageData(0, 0, 1, 1).data].slice(0, 3); };
    const lum = (color) => rgb(color).map((v) => v / 255).map((v) => v <= .04045 ? v / 12.92 : ((v + .055) / 1.055) ** 2.4).reduce((sum, v, i) => sum + v * [.2126, .7152, .0722][i], 0);
    const ratio = (a, b) => (Math.max(lum(a), lum(b)) + .05) / (Math.min(lum(a), lum(b)) + .05);
    const backgrounds = (root.dataset.theme === 'dark' ? ['--pd-night', '--pd-night-end'] : ['--pd-day', '--pd-day-end']).map((key) => style.getPropertyValue(key));
    const values = ['--pd-text', '--pd-muted', '--pd-faint', '--pd-accent'].flatMap((key) => backgrounds.map((bg) => ({ name: key, ratio: ratio(style.getPropertyValue(key), bg) })));
    const secondary = [...root.querySelectorAll('button')].find((button) => button.textContent.trim() === 'Все разделы');
    const button = getComputedStyle(secondary);
    values.push({ name: 'Вторичная кнопка', ratio: ratio(button.color, button.backgroundColor) });
    return values;
  });
  check(`${theme}: контраст текста не ниже 4.5:1`, ratios.every((item) => item.ratio >= 4.5), JSON.stringify(ratios));
};

// «Команда» живёт внутри вкладки «Редакция» — рядом с предпросмотром и списком справочников
const openTeam = async () => {
  await go('Редакция');
  await app().getByRole('button', { name: 'Команда', exact: true }).click();
  await app().getByRole('heading', { name: 'Команда', exact: true }).waitFor();
};
let teamHintChecked = false;
const checkTeamHint = async () => {
  if (teamHintChecked) return;
  teamHintChecked = true;
  const hint = app().getByText('публикует страницы и объявления, приглашает редакторов.', { exact: false });
  check('подсказка «Кто что делает» скрыта до нажатия', (await hint.count()) === 0);
  const toggle = app().getByRole('button', { name: /Кто что делает/ });
  await toggle.click();
  check('подсказка «Кто что делает» открывается по нажатию', await visible(hint) && (await toggle.getAttribute('aria-expanded')) === 'true');
  await toggle.click();
};

const changeRole = async (role) => {
  await page.locator('.kbtn', { hasText: 'Сменить роль' }).last().click();
  await visible(page.locator('.kbtn', { hasText: role }));
  await page.locator('.kbtn', { hasText: role }).last().click();
  await page.locator('.msg--bot').last().filter({ hasText: 'Вы —' }).waitFor();
  await openTab('Справочник');
  await dock().getByRole('button').first().waitFor();
};

const checkResponsiveTabs = async (tabs, role) => {
  for (const width of [320, 375, 430]) {
    await setAppWidth(width);
    for (const name of tabs) {
      await go(name);
      await app().getByRole('heading', { level: 1 }).first().waitFor();
      if (['Главная', 'Разделы', 'Поиск', 'Просмотр'].includes(name)) {
        const preview = await app().getByText('Предпросмотр со стороны студента', { exact: true }).count();
        check(`${role}, ${name}: пометка предпросмотра соответствует роли`, role === 'Студент' ? preview === 0 : preview === 1);
      }
      check(`${role}, ${name}: один заголовок и нет возврата с корневой вкладки`, await app().getByRole('heading', { level: 1 }).count() === 1 && await app().getByRole('button', { name: 'Назад', exact: true }).count() === 0);
      check(`${role}, ${name}: подписи дока видимы`, await dock().getByRole('button').evaluateAll((buttons) => buttons.every((button) => button.innerText.trim().length > 0)));
      await checkLayout(`${role}, ${name}`, width);
    }
  }
};

try {
  await page.goto(`file://${pagePath}`);
  await page.waitForSelector('.boot', { state: 'detached', timeout: 120_000 });

  // 1. Демо открылось в роли деканата: карточка справочника с кнопками по роли
  check('бот прислал карточку демо', await visible(page.locator('.msg--bot', { hasText: 'Демо «Модельного университета»' })));
  check('в чате есть «Сменить роль»', await visible(page.locator('.kbtn', { hasText: 'Сменить роль' })));
  await shot('start');

  // 2. Вопрос в чате → выдержка → страница в мини-приложении
  await say('физра отработки');
  check('бот нашёл «Как получить зачёт»', await visible(page.locator('.msg--bot', { hasText: 'Как получить зачёт' })));
  await lastBot().locator('.kbtn', { hasText: 'Открыть страницу' }).click();
  check('страница открылась в мини-приложении', await visible(app().getByRole('heading', { name: 'Как получить зачёт' })));
  await shot('page');

  // 2а. Команда открывает приложение в «Редакции»: читательские экраны у неё — «Предпросмотр», без дублей в меню
  await openTab('Справочник');
  const staffTabs = ['Редакция', 'Вопросы', 'Просмотр', 'Профиль'];
  check('деканат открывает приложение в «Редакции»', await visible(app().getByRole('heading', { name: 'Редакция', exact: true })));
  check('у деканата меню без главной, разделов и поиска', JSON.stringify(await dock().getByRole('button').evaluateAll((buttons) => buttons.map((button) => button.getAttribute('aria-label') || button.textContent?.trim()))) === JSON.stringify(staffTabs));
  check('в карточке редакции нет второй кнопки «Предпросмотр»', (await app().locator('.hb-editor-identity').getByRole('button', { name: 'Предпросмотр', exact: true }).count()) === 0);
  check('в редакции нет вкладки «Вопросы» — она в меню', (await app().getByRole('tab', { name: 'Вопросы', exact: true }).count()) === 0);
  const pageSearch = app().getByRole('searchbox', { name: 'Найти страницу по названию' });
  await pageSearch.fill('словарь');
  check('поиск по названиям страниц в редакции', await visible(app().getByText('Словарь терминов').first()) && (await app().getByText('Как получить зачёт').count()) === 0);
  await pageSearch.fill('');
  await go('Просмотр');
  check('предпросмотр — главная глазами студента', await visible(app().getByRole('heading', { name: 'Справочник ИИТ' })) && await visible(app().getByText('Предпросмотр со стороны студента').first()));
  await app().getByRole('button', { name: 'Задать вопрос', exact: true }).click();
  check('в предпросмотре вопрос не отправить: задают только студенты', await visible(app().getByText(/Вопросы задают только студенты/)) && await app().getByRole('textbox', { name: 'Текст вопроса' }).isDisabled());
  await shot('dean-preview-ask');

  // 3. Читательская часть — глазами студента: объявление → «Прочитано» → архив
  await changeRole('Студент');
  check('главная справочника', await visible(app().getByRole('heading', { name: 'Справочник ИИТ' })));
  check('до первого пункта предлагается начало, а не продолжение', await visible(app().getByText('С чего начать', { exact: true })) && await app().getByText('Продолжить', { exact: true }).count() === 0);
  check('нулевые полосы прогресса на главной скрыты', await app().locator('.hb-home-tile__bar').count() === 0);
  const announcements = await app().locator('section[aria-label="Объявления"] .hb-announce__main .stack > span:first-child').allTextContents();
  check('объявления показаны один раз', announcements.length > 0 && await app().getByText(announcements[0], { exact: true }).count() === 1);
  await app().getByRole('button', { name: /Прочитано/ }).first().click();
  check('прочитанное уходит в архив', await visible(app().getByRole('button', { name: /Архив объявлений/ })));
  await app().getByRole('button', { name: /Архив объявлений/ }).click();
  await app().getByRole('tab', { name: /^Архив/ }).click();
  check('экран «Объявления» с архивом', await visible(app().getByText('Вернуть на главную')));
  await app().getByRole('button', { name: /Вернуть на главную/ }).first().click();
  await page.waitForTimeout(500);
  await shot('announcements');

  // 3а. Сброс демо — только после подтверждения
  await openTab('Справочник');
  await app().getByRole('button', { name: 'Сбросить' }).click();
  check('сброс демо спрашивает подтверждение', await visible(app().getByRole('heading', { name: 'Сбросить демо?' }), 3000));
  await app().getByRole('button', { name: 'Отмена' }).click();

  // 3б. Поиск: уточнили запрос → страница → оценка → соседняя страница → «Назад» к последнему запросу
  await go('Поиск');
  const searchField = app().getByRole('searchbox', { name: 'Поиск по справочнику' });
  await searchField.fill('справка');
  await searchField.press('Enter');
  await visible(app().getByRole('button', { name: /Справка/ }));
  await searchField.fill('общага оплата');
  await searchField.press('Enter');
  const hit = app().getByRole('button', { name: /Оплата и правила/ }).first();
  check('уточнённый запрос нашёл страницу', await visible(hit));
  await hit.click();
  check('страница из поиска', await visible(app().getByRole('heading', { name: 'Оплата и правила' })));
  await app().getByRole('button', { name: 'Да', exact: true }).click();
  check('оценка страницы принята', await visible(app().getByText('Вы отметили страницу полезной')));
  check('у выбранной оценки явное состояние', await app().getByRole('button', { name: 'Да', exact: true }).getAttribute('aria-pressed') === 'true');
  await app().getByRole('button', { name: 'Спросить дежурного', exact: true }).scrollIntoViewIfNeeded();
  await setAppWidth(320);
  const unclipped = await app().locator('.hb-feedback-actions button').evaluateAll((buttons) => buttons.every((button) => {
    const content = button.querySelector('[class*="Button__content"]');
    const outer = button.getBoundingClientRect(); const inner = content.getBoundingClientRect();
    return inner.left >= outer.left && inner.right <= outer.right && content.scrollWidth <= content.clientWidth + 1;
  }));
  check('подписи оценок не обрезаются на 320 px', unclipped);
  await shot('page-actions');
  await setAppWidth(375);
  const sibling = app().getByRole('heading', { name: 'Рядом в разделе' }).locator('xpath=following-sibling::*[1]//button').first();
  const siblingTitle = ((await sibling.textContent()) ?? '').replace('›', '').trim();
  await sibling.click();
  check('соседнюю страницу можно оценить', await visible(app().getByText('Страница помогла?')), siblingTitle);
  await app().getByRole('button', { name: /Назад/ }).first().click();
  check(
    '«Назад» возвращает к последнему запросу',
    (await visible(searchField)) && (await searchField.inputValue()) === 'общага оплата',
    await searchField.inputValue().catch(() => ''),
  );

  await go('Поиск');
  check('история поиска доступна на пустом экране', await visible(app().getByRole('heading', { name: 'Недавние запросы', exact: true })) && await visible(app().getByRole('button', { name: 'общага оплата', exact: true })));

  // 3в. Новый экран вопроса работает с настоящим API демо и показывает отправленный вопрос.
  await searchField.fill('обсерватория e2e');
  await searchField.press('Enter');
  await app().getByRole('button', { name: 'Спросить дежурного', exact: true }).click();
  const readerQuestion = 'Как записаться в университетскую обсерваторию? Проверка e2e.';
  await app().getByRole('textbox', { name: 'Текст вопроса', exact: true }).fill(readerQuestion);
  await app().getByRole('button', { name: 'Отправить', exact: true }).click();
  check('вопрос из мини-приложения появляется в истории', await visible(app().getByText(readerQuestion, { exact: true })));

  // 4. Чек-лист первой недели: отметка пункта
  await openTab('Справочник');
  await app().getByRole('button', { name: /Чек-лист первой недели/ }).first().click();
  const firstItem = app().locator('label').filter({ has: app().locator('input[type="checkbox"]') }).first();
  check('чек-лист открылся', await visible(firstItem));
  await firstItem.click();
  check('пункт отмечен', await firstItem.locator('input[type="checkbox"]').isChecked());

  await go('Разделы');
  const firstSection = app().getByRole('button').and(app().locator('[aria-expanded][aria-controls]')).first();
  check('разделы открылись аккордеоном', await visible(firstSection));
  if ((await firstSection.getAttribute('aria-expanded')) === 'true') await firstSection.click();
  await firstSection.click();
  const sectionBody = app().locator(`[id="${await firstSection.getAttribute('aria-controls')}"]`);
  check('раздел раскрывается со ссылками на страницы', (await firstSection.getAttribute('aria-expanded')) === 'true' && (await sectionBody.getByRole('button').count()) > 0);
  await firstSection.click();
  check('раздел сворачивается', (await firstSection.getAttribute('aria-expanded')) === 'false' && !(await sectionBody.isVisible()));

  await go('Главная');
  await app().getByRole('button', { name: 'Ближайшие сроки', exact: true }).click();
  check('отдельный экран ближайших сроков', await visible(app().getByRole('heading', { name: 'Ближайшие сроки', exact: true })));

  // 5. По умолчанию системная светлая тема; переключатель темы — в профиле, шапка главной для важного.
  await openTab('Справочник');
  check('системная тема учитывает светлое окружение', await app().locator('html').getAttribute('data-theme') === 'light');
  check('на главной нет переключателя темы', (await app().getByRole('button', { name: /Включить (тёмную|светлую) тему/ }).count()) === 0);
  check('на главной нет ленты быстрых запросов под поиском', (await app().getByRole('region', { name: 'Часто ищут' }).count()) === 0 && (await app().locator('.hb-chips--scroll').count()) === 0);
  check('на главной фото кампуса во весь верх', await (await appFrame()).evaluate(() => { const cover = document.querySelector('.hb-reader-hero .hb-cover'); return Boolean(cover) && getComputedStyle(cover).position === 'absolute' && cover.getBoundingClientRect().width >= window.innerWidth - 1; }));
  await checkContrast('Светлая тема');
  await shot('light');
  const pickTheme = async (name) => {
    await go('Профиль');
    await app().getByRole('radiogroup', { name: 'Тема оформления' }).getByRole('radio', { name, exact: true }).click();
    await go('Главная');
  };
  await pickTheme('Тёмная');
  check('тёмная тема включается', await app().locator('html').getAttribute('data-theme') === 'dark');
  check('в тёмной теме тёмные поверхности', await (await appFrame()).evaluate(() => {
    // Цвет через canvas: color-mix() в computed style приходит как color(srgb …), а не rgb()
    const ctx = Object.assign(document.createElement('canvas'), { width: 1, height: 1 }).getContext('2d');
    return [...document.querySelectorAll('.pd-app .card')].every((card) => {
      ctx.clearRect(0, 0, 1, 1); ctx.fillStyle = getComputedStyle(card).backgroundColor; ctx.fillRect(0, 0, 1, 1);
      const [r, g, b, a] = ctx.getImageData(0, 0, 1, 1).data;
      return a === 0 || r + g + b < 300;
    });
  }));
  await checkContrast('Тёмная тема');
  await shot('dark');
  await pickTheme('Светлая');
  check('светлая тема включается', await app().locator('html').getAttribute('data-theme') === 'light');

  // 6. Нет ответа → вопрос дежурному → ответ из редактора приходит в чат
  await say('есть ли военная кафедра');
  await visible(lastBot().locator('.kbtn', { hasText: 'Спросить дежурного' }));
  await lastBot().locator('.kbtn', { hasText: 'Спросить дежурного' }).click();
  check('бот просит написать вопрос', await visible(page.locator('.msg--bot', { hasText: 'Напишите вопрос одним сообщением' })));
  await say('Есть ли в вузе военный учебный центр и как туда поступить?');
  check('вопрос передан дежурному', await visible(page.locator('.msg--bot', { hasText: 'Передал дежурному' })));

  await changeRole('Деканат');
  await go('Вопросы');
  // Ближайший к тексту вопроса блок, в котором есть кнопка «Ответить» — без привязки к классам вёрстки
  const question = app().getByText('военный учебный центр').first();
  check('вопрос виден в бэклоге редактора', await visible(question));
  await question.locator('xpath=ancestor::*[.//button[contains(., "Ответить")]][1]').getByRole('button', { name: /Ответить/ }).first().click();
  check('ответ можно добавить в «Вопросы и ответы»', await visible(app().getByText('Добавить в «Вопросы и ответы»')));
  await app().locator('textarea').last().fill('Военного учебного центра в ИИТ нет, в университете есть — запись весной.');
  await app().getByRole('button', { name: /Отправить/ }).last().click();
  check('ответ дежурного пришёл в чат', await visible(page.locator('.msg--bot', { hasText: 'Ответ на ваш вопрос' }), 15_000));
  await shot('answer');

  // 7. Объявление со ссылкой на страницу → в чат с кнопкой «Подробнее»
  await go('Редакция');
  await app().getByRole('tab', { name: 'Объявления', exact: true }).click();
  await app().getByRole('button', { name: 'Новое объявление', exact: true }).click();
  check('серая кнопка объясняет, чего не хватает', await visible(app().getByText(/^Чтобы опубликовать: напишите заголовок/)));
  await app().getByRole('textbox', { name: 'Заголовок', exact: true }).fill('Проверка e2e: сессия');
  await app().getByRole('textbox', { name: 'Текст объявления' }).fill('Опубликовано расписание зимней сессии — подробности на странице.');
  check('у листа есть кнопка «Закрыть»', (await app().getByRole('dialog').getByRole('button', { name: 'Закрыть' }).count()) > 0);
  check('у объявления поля «Показывать с» и «до»', (await app().getByRole('dialog').locator('input[type="date"]').count()) === 2);
  await page.keyboard.press('Escape');
  check('лист с набранным текстом не закрывается молча', await visible(app().getByText('Закрыть без сохранения?'), 3000));
  await app().getByRole('button', { name: 'Продолжить' }).click();
  const pageSelect = app().locator('select').first();
  const options = await pageSelect.locator('option').allTextContents();
  const target = options.find((text) => /Сессия/.test(text)) ?? options[1];
  await pageSelect.selectOption({ label: target });
  await app().getByRole('button', { name: /Опубликовать/ }).last().click();
  check('объявление со ссылкой пришло в чат', await visible(page.locator('.msg--bot', { hasText: 'Проверка e2e: сессия' }), 15_000));
  const announcement = page.locator('.msg--bot', { hasText: 'Проверка e2e: сессия' }).last();
  check('у объявления кнопка «Подробнее»', await visible(announcement.locator('.kbtn', { hasText: 'Подробнее' })));

  // 7а. Объявление удалили в приложении — бот убирает его и из чата
  await app().getByRole('button', { name: /Проверка e2e: сессия/ }).click();
  await app().getByRole('button', { name: 'Удалить объявление', exact: true }).click();
  await app().getByRole('button', { name: 'Точно удалить? Нажмите ещё раз', exact: true }).click();
  check('удалённое объявление исчезло и из чата', await page.locator('.msg--bot', { hasText: 'Проверка e2e: сессия' }).first().waitFor({ state: 'detached', timeout: 15_000 }).then(() => true, () => false));

  // 8. QR-плакат опубликованной страницы
  await go('Редакция');
  await app().getByRole('tab', { name: 'Страницы', exact: true }).click();
  await app().getByText('Чек-лист первой недели').first().click();
  const qr = app().getByRole('button', { name: 'QR-плакат' });
  check('у страницы есть QR-плакат', await visible(qr));
  await qr.click();
  check('плакат с QR-кодом', await visible(app().getByRole('dialog').getByRole('img', { name: /^QR-код:/ })));
  await shot('poster');
  await app().getByRole('dialog').getByRole('button', { name: 'Закрыть', exact: true }).click();
  await app().getByRole('button', { name: /Назад/ }).first().click();

  // 8а. Автосохранение на медленной сети: правка, сделанная во время сохранения, не теряется
  await go('Редакция');
  await app().getByText('Словарь терминов').first().click();
  const summaryField = app().getByLabel('Коротко о чём');
  check('конструктор страницы', await visible(summaryField));
  await (await appFrame()).evaluate(() => {
    const original = window.fetch;
    window.fetch = (url, init) =>
      init?.method === 'PATCH' ? new Promise((resolve) => setTimeout(resolve, 700)).then(() => original(url, init)) : original(url, init);
  });
  await app().getByLabel('Заголовок', { exact: true }).fill('Словарь терминов (e2e)');
  await visible(app().getByText('Сохраняю…'), 5000);
  await summaryField.fill('Правка, сделанная во время сохранения');
  await page.waitForTimeout(3500);
  check('все правки сохранены', await visible(app().getByText(/Правки сохранены/), 8000));
  await app().getByRole('button', { name: /Назад/ }).first().click();
  await app().getByText('Словарь терминов').first().click();
  await visible(summaryField);
  await page.waitForTimeout(500);
  check('правка во время сохранения не потерялась', (await summaryField.inputValue()) === 'Правка, сделанная во время сохранения', await summaryField.inputValue());
  await summaryField.fill('');
  await app().getByText('Есть правки', { exact: true }).waitFor();
  check('пустое описание сохранено', await visible(app().getByText(/Правки сохранены/), 8000));
  await app().getByRole('button', { name: /Назад/ }).first().click();
  await app().getByText('Словарь терминов').first().click();
  await visible(summaryField);
  check('очищенное описание остаётся пустым после повторного открытия', (await summaryField.inputValue()) === '', await summaryField.inputValue());

  // 8б. Пошаговая инструкция без заголовка не мешает публикации
  await app().getByRole('button', { name: /Добавить блок/ }).click();
  await app().getByRole('button', { name: /Пошаговая инструкция/ }).click();
  await app().getByLabel('Шаг 1: что сделать').fill('Зайти в деканат');
  const stepBlock = app().getByRole('button', { name: /Пошаговая инструкция/ }).and(app().locator('[aria-expanded]'));
  await stepBlock.click();
  check('блок конструктора сворачивается', (await stepBlock.getAttribute('aria-expanded')) === 'false' && !(await app().getByLabel('Шаг 1: что сделать').isVisible()));
  await stepBlock.click();
  check('блок раскрывается с сохранённым текстом', (await stepBlock.getAttribute('aria-expanded')) === 'true' && (await app().getByLabel('Шаг 1: что сделать').inputValue()) === 'Зайти в деканат');
  await page.waitForTimeout(2500);
  check('инструкция без заголовка сохранена', await visible(app().getByText(/Правки сохранены/), 8000));
  check('инструкция без заголовка готова к публикации', await app().getByRole('button', { name: 'Опубликовать правки' }).isEnabled());
  await shot('editor-page');
  await app().getByRole('button', { name: 'На проверку', exact: true }).click();
  await app().getByRole('dialog').getByRole('button', { name: 'Отправить на проверку', exact: true }).click();
  check('деканат может отправить свои правки на проверку', await visible(app().getByRole('heading', { name: 'Страница ждёт проверки', exact: true })));
  await app().getByRole('button', { name: 'Вернуть на доработку', exact: true }).click();
  await app().getByRole('dialog').getByRole('button', { name: 'Вернуть на доработку', exact: true }).click();
  check('деканат возвращает правки с проверки', await visible(app().getByText('Вернули на доработку.', { exact: true })));
  await app().getByRole('button', { name: 'Опубликовать правки', exact: true }).click();
  check('деканат публикует правки', await visible(app().getByText('Опубликовано, правок нет', { exact: true })));
  await app().getByRole('heading', { name: 'Статус страницы', exact: true }).scrollIntoViewIfNeeded();
  await shot('page-status');
  await app().getByRole('button', { name: 'Убрать страницу в архив', exact: true }).click();
  await app().getByRole('dialog').getByRole('button', { name: 'Убрать в архив', exact: true }).click();
  await app().getByText('Словарь терминов (e2e)', { exact: true }).first().click();
  await app().getByRole('button', { name: 'Восстановить черновик', exact: true }).click();
  check('архивную страницу можно вернуть в черновики', await visible(app().locator('.hb-page-status').getByText('Черновик', { exact: true })));
  await app().getByRole('button', { name: 'Опубликовать', exact: true }).click();
  await visible(app().getByText('Опубликовано, правок нет', { exact: true }));

  // 8в. Настоящая ширина экрана MAX: все вкладки и раскрытый конструктор на узком телефоне.
  for (const width of [320, 375, 430]) {
    await setAppWidth(width);
    await checkLayout('Конструктор с раскрытым блоком', width);
  }
  await app().getByRole('button', { name: /Назад/ }).first().click();

  await app().getByRole('group', { name: 'Статус страниц' }).getByRole('button', { name: /^Требует внимания/ }).click();
  check('у фильтров видно, сколько в них страниц', /Требует внимания\s*\d+/.test(await app().getByRole('group', { name: 'Статус страниц' }).getByRole('button', { name: /^Требует внимания/ }).textContent()));
  check('проблемная страница выделена и поднята первой', (await app().locator('.hb-editor-page-row').first().textContent()).includes('Как получить зачёт'));
  const collapse = app().locator('.hb-section-toggle').first();
  await collapse.click();
  check('раздел редактора сворачивается', await collapse.getAttribute('aria-expanded') === 'false');
  await collapse.click();
  await shot('editor-attention');

  // Фильтры редактора и аналитика используют данные сервера после всех предыдущих действий.
  await app().getByRole('group', { name: 'Статус страниц', exact: true }).getByRole('button', { name: /^Опубликованы/ }).click();
  check('фильтр опубликованных страниц исключает черновики', (await app().getByRole('button', { name: /Опубликована/ }).count()) > 0 && (await app().getByRole('button', { name: /Черновик/ }).count()) === 0);
  await app().getByRole('group', { name: 'Статус страниц', exact: true }).getByRole('button', { name: /^Все\s*\d*$/ }).click();
  await app().getByRole('button', { name: 'Аналитика', exact: true }).click();
  check('экран аналитики открыт', await visible(app().getByRole('heading', { name: 'Аналитика', exact: true })));
  check('аналитика показывает реальные показатели и цели', await visible(app().getByText('Нашли ответ сами', { exact: true })) && await visible(app().getByText('Проверено за полгода', { exact: true })));

  // Смена роли проверяется на тестовом приглашении: исходный редактор демо сохраняет свои права.
  await openTeam();
  await checkTeamHint();
  await app().getByRole('button', { name: 'Пригласить в команду', exact: true }).click();
  check('у «Кто это» есть пояснение, чем студсовет отличается от сотрудника', await visible(app().getByText(/права задаются ниже/)));
  const testMember = 'Тестовая Участница E2E';
  await app().getByLabel('Имя и фамилия', { exact: true }).fill(testMember);
  await app().getByRole('button', { name: 'Создать ссылку', exact: true }).click();
  const memberActions = app().getByRole('button', { name: `Действия участника ${testMember}`, exact: true });
  await memberActions.click();
  const memberCard = memberActions.locator('xpath=ancestor::article[1]');
  check('карточка участника раскрывается', (await memberActions.getAttribute('aria-expanded')) === 'true');
  await memberCard.getByRole('button', { name: 'Изменить роль', exact: true }).click();
  await app().getByRole('dialog').getByRole('radio', { name: 'Администратор', exact: true }).click();
  await app().getByRole('button', { name: 'Сохранить роль', exact: true }).click();
  check('роль участника меняется через API', await visible(memberCard.getByText(/^Администратор ·/)));
  await go('Профиль');
  check('профиль деканата показывает аналитику и роль', await visible(app().getByRole('button', { name: 'Аналитика справочника', exact: true })) && await visible(app().getByText('Деканат', { exact: true })));
  check('профиль не повторяет док и не требует завершения', await app().getByRole('button', { name: /^(Управление командой|Страницы и вопросы студентов|Готово)$/ }).count() === 0);
  check('студенческие поля скрыты в профиле деканата', (await app().getByRole('heading', { name: 'Курс', exact: true }).count()) === 0);
  check('лишний текст профиля удалён', (await app().getByText(/От этого зависит, что вы увидите/).count()) === 0);
  await app().getByRole('button', { name: /Справочники факультета/ }).click();
  check('деканат управляет справочниками факультета', await visible(app().getByRole('heading', { name: 'Справочники факультета', exact: true })));
  check('единственный справочник факультета закрыть нельзя', await visible(app().getByText(/Единственный справочник факультета/).first()));
  check('при создании — выбор, подключать ли общие страницы', await visible(app().getByRole('radio', { name: /Без общих страниц/ })));
  await go('Профиль');
  await shot('dean-profile');
  await openTeam();
  check('новая роль сохраняется после повторного открытия команды', await visible(memberCard.getByText(/^Администратор ·/)));
  await memberActions.click();
  await memberCard.getByRole('button', { name: `Убрать ${testMember} из команды`, exact: true }).click();
  await app().getByRole('dialog').getByRole('button', { name: 'Убрать из команды', exact: true }).click();
  await memberActions.waitFor({ state: 'hidden' });
  check('тестовый участник удалён с подтверждением', (await memberActions.count()) === 0);

  await checkResponsiveTabs(staffTabs, 'Деканат');

  // 8г. Сроки для студентов: список и новый срок прямо на странице; файл загружается в блок «Файл», а не ссылкой
  await go('Редакция');
  await app().getByRole('button', { name: 'Сроки для студентов', exact: true }).click();
  check('у команды есть экран сроков', await visible(app().getByRole('heading', { name: 'Сроки для студентов', exact: true })));
  check('видно сроки, которые уже видят студенты', await visible(app().getByRole('heading', { name: /^Видят студенты/ })));
  await shot('team-deadlines');
  await app().getByRole('button', { name: /Новый срок/ }).click();
  const deadlinePage = app().getByRole('dialog').locator('select');
  const deadlineOptions = await deadlinePage.locator('option').allTextContents();
  const publishedPage = deadlineOptions.find((text, index) => index > 0 && !/черновик/.test(text));
  await deadlinePage.selectOption({ label: publishedPage });
  await app().getByRole('dialog').getByRole('button', { name: 'Добавить срок на страницу', exact: true }).click();
  check('страница открылась сразу с блоком «Срок»', await visible(app().getByLabel('Что нужно успеть')));
  await app().getByLabel('Что нужно успеть').fill('Сдать заявление — E2E');
  await app().getByRole('button', { name: /Добавить блок/ }).click();
  await app().getByRole('dialog').getByRole('button', { name: /^Файл/ }).click();
  check('в блоке «Файл» нет поля для ссылки', (await app().getByRole('textbox', { name: 'Ссылка' }).count()) === 0);
  await app().locator('input[type="file"]').setInputFiles({ name: 'Заявление.pdf', mimeType: 'application/pdf', buffer: Buffer.from('%PDF-1.4\n% e2e\n') });
  check('файл загружен прямо в блок', await visible(app().locator('.hb-file-chosen').getByText('Заявление.pdf', { exact: true })));
  check('название блока подставилось из имени файла', await app().locator('.hb-editblock--open').last().locator('input.hb-input').first().inputValue() === 'Заявление');
  await shot('file-block');
  check('правки со сроком и файлом сохранены', await visible(app().getByText(/Правки сохранены/), 8000));
  await app().getByRole('button', { name: /Назад/ }).first().click();
  check('новый срок виден как ещё не опубликованный', await visible(app().getByText('Сдать заявление — E2E', { exact: true })) && await visible(app().getByRole('heading', { name: /^Ещё не видят студенты/ })));
  await app().getByRole('button', { name: /Назад/ }).first().click();
  check('неопубликованные правки подсвечены в редакции', await visible(app().locator('.hb-unpublished').first()));
  await shot('editor-unpublished');

  // 9. Редактор работает со страницами и вопросами, но не получает административные действия.
  await changeRole('Редактор');
  check('редактор открывает приложение в «Редакции»', await visible(app().getByRole('heading', { name: 'Редакция', exact: true })));
  await go('Просмотр');
  check('главная редактора помечена как предпросмотр', await visible(app().getByText('Предпросмотр со стороны студента', { exact: true })));
  await go('Профиль');
  check('профиль редактора показывает рабочие действия', await visible(app().getByRole('button', { name: 'Аналитика справочника', exact: true })));
  check('редактор не видит управление командой в профиле', (await app().getByRole('button', { name: 'Управление командой', exact: true }).count()) === 0);
  await app().getByRole('button', { name: /^Предпросмотр студента/ }).click();
  check('параметры предпросмотра можно раскрыть', await visible(app().getByRole('heading', { name: 'Курс', exact: true })));
  await go('Редакция');
  await app().getByRole('searchbox', { name: 'Найти страницу по названию' }).waitFor();
  check('редактор видит вопросы студентов в меню', await visible(dock().getByRole('button', { name: 'Вопросы', exact: true })));
  check('редактор не видит вкладку объявлений', (await app().getByRole('tab', { name: 'Объявления', exact: true }).count()) === 0);
  await app().getByText('Словарь терминов').first().click();
  await visible(app().getByLabel('Коротко о чём'));
  check('редактор отправляет на проверку', await visible(app().getByRole('button', { name: 'На проверку', exact: true })));
  check('редактор не может публиковать страницу', (await app().getByRole('button', { name: /Опубликовать/ }).count()) === 0);
  await app().getByLabel('Коротко о чём').fill('Правки редактора для проверки статуса');
  await app().getByRole('button', { name: 'На проверку', exact: true }).click();
  await app().getByRole('dialog').getByRole('button', { name: 'Отправить на проверку', exact: true }).click();
  check('редактор действительно отправляет страницу на проверку', await visible(app().getByText(/^Вы отправили страницу администратору/)));
  check('у страницы есть справка по статусам', await visible(app().getByRole('button', { name: 'Что значат статусы и как их снять' })));
  await shot('editor-review');
  await app().getByRole('button', { name: /Назад/ }).first().click();
  check('у редактора «на проверке» не считается «требует внимания»', (await app().getByText('На проверке · ждёт вашей публикации').count()) === 0);

  // Редактор дописывает уточнение к общей странице и отправляет его деканату — раньше оно молча оставалось черновиком
  await app().getByRole('button', { name: /^Из общей базы/ }).click();
  check('справка по статусам — одна кнопка, без дубля в общих страницах', (await app().getByRole('button', { name: /Что значат статусы/ }).count()) === 1);
  await app().locator('.hb-editor-page-row').filter({ hasNotText: /С уточнением|Своя версия|Черновик|ждёт/ }).first().click();
  await app().getByRole('button', { name: 'Добавить уточнение' }).click();
  await app().getByRole('dialog').getByText('Текст', { exact: true }).click();
  await app().locator('.hb-local-editor textarea').first().fill('В ИИТ справку выдают в каб. 214 — E2E');
  check('редактор отправляет уточнение на проверку', await visible(app().getByRole('button', { name: 'На проверку', exact: true })));
  await app().getByRole('button', { name: 'На проверку', exact: true }).click();
  await app().getByRole('dialog').getByRole('button', { name: 'Отправить на проверку', exact: true }).click();
  check('уточнение ждёт публикации администратором', await visible(app().getByText('Отправлено на публикацию', { exact: true })));
  await app().getByRole('button', { name: /Назад/ }).first().click();
  await app().getByRole('button', { name: /^Все\s*\d*$/ }).click();
  await openTeam();
  await app().getByRole('heading', { name: 'Команда', exact: true }).waitFor();
  check('редактор не приглашает участников', (await app().getByRole('button', { name: /Пригласить/ }).count()) === 0);
  check('редактор не меняет роли и не удаляет участников', (await app().getByRole('button', { name: /Изменить роль|Убрать .* из команды|Действия участника/ }).count()) === 0);

  // Редактор не управляет чужим справочником как администратор, но может пройти
  // весь путь создания нового справочника в личной демо-песочнице.
  await go('Редакция');
  check('в редакции нет второй кнопки «Справочники»', (await app().getByRole('button', { name: 'Справочники', exact: true }).count()) === 0);
  await go('Профиль');
  await app().getByRole('button', { name: /Другие справочники/ }).click();
  check('выбор справочников подписан как только демо', await visible(app().getByText(/Только для демонстрации/)));
  check('редактору доступно создание справочника в демо', await visible(app().getByRole('button', { name: 'Новый справочник' })));
  await app().getByRole('button', { name: 'Новый справочник' }).click();
  await app().getByRole('textbox', { name: 'Название', exact: true }).fill('Справочник стажировок E2E');
  await app().getByRole('button', { name: 'Создать ещё один' }).click();
  check('новый справочник открыт после создания', await visible(app().getByRole('heading', { name: 'Справочник стажировок E2E' })));
  await go('Редакция');
  await app().getByRole('button', { name: 'Новый раздел' }).click();
  await app().getByRole('textbox', { name: 'Название раздела' }).fill('Стажировки и практика');
  await app().getByRole('button', { name: 'Создать раздел' }).click();
  check('новый раздел виден в редакторе', await visible(app().getByText('Стажировки и практика', { exact: true })));
  await app().getByRole('button', { name: 'Настроить раздел «Стажировки и практика»' }).click();
  await app().getByRole('radio', { name: 'Возможности', exact: true }).click();
  await app().getByRole('button', { name: 'Сохранить раздел', exact: true }).click();
  await app().getByRole('dialog').waitFor({ state: 'hidden' });
  await app().getByRole('button', { name: 'Настроить раздел «Стажировки и практика»' }).click();
  check('значок раздела сохраняется через API', await app().getByRole('radio', { name: 'Возможности', exact: true }).getAttribute('aria-checked') === 'true');
  await app().getByRole('button', { name: 'Сохранить раздел', exact: true }).click();
  await app().getByRole('dialog').waitFor({ state: 'hidden' });
  check('редактирование не создаёт дубликат раздела', await app().getByText('Стажировки и практика', { exact: true }).count() === 1);
  await shot('new-handbook');

  // Ненужный справочник деканат закрывает и возвращает: студенты не видят его, пока он закрыт
  await changeRole('Деканат');
  const openManage = async () => {
    await go('Профиль');
    await app().getByRole('button', { name: /Справочники факультета/ }).click();
    await app().getByRole('heading', { name: 'Справочники факультета', exact: true }).waitFor();
  };
  await openManage();
  const stagings = app().locator('.hb-handbook-manage', { hasText: 'Справочник стажировок E2E' });
  check('второй справочник факультета можно закрыть', await visible(stagings.getByRole('button', { name: 'Закрыть справочник', exact: true })));
  await stagings.getByRole('button', { name: 'Закрыть справочник', exact: true }).click();
  await app().getByRole('dialog').getByRole('button', { name: 'Закрыть справочник', exact: true }).click();
  // Закрыли открытый сейчас справочник — приложение переходит в другой справочник факультета
  await page.waitForTimeout(1000);
  if (!(await visible(app().locator('.hb-handbook-manage--closed'), 2000))) await openManage();
  check('закрытый справочник — в «Закрытых» с датой возврата', await visible(app().locator('.hb-handbook-manage--closed', { hasText: 'Справочник стажировок E2E' })));
  await shot('dean-closed-handbook');
  await app().locator('.hb-handbook-manage--closed', { hasText: 'Справочник стажировок E2E' }).getByRole('button', { name: 'Вернуть справочник' }).click();
  check('закрытый справочник возвращается', await visible(app().locator('.hb-handbook-manage:not(.hb-handbook-manage--closed)', { hasText: 'Справочник стажировок E2E' })));

  // 10. Роль «Студент»: редактор закрыт, данные на месте.
  await changeRole('Студент');
  check('бот подтвердил роль студента', await visible(page.locator('.msg--bot', { hasText: 'Вы — студент' })));
  check('главная у студента', await visible(app().getByRole('heading', { name: 'Справочник ИИТ' })));
  const readerTabs = ['Главная', 'Разделы', 'Поиск', 'Профиль'];
  check('студенту доступны только четыре читательские вкладки', JSON.stringify(await dock().getByRole('button').evaluateAll((buttons) => buttons.map((button) => button.getAttribute('aria-label') || button.textContent?.trim()))) === JSON.stringify(readerTabs));
  check('у студента нет кнопки редактора', (await app().getByRole('button', { name: /Редактор/ }).count()) === 0);
  check('у студента нет кнопки команды', (await dock().getByRole('button', { name: 'Команда', exact: true }).count()) === 0);
  await checkResponsiveTabs(readerTabs, 'Студент');
  await go('Профиль');
  check('студент видит свой курс', await visible(app().getByRole('heading', { name: 'Курс', exact: true })) && await visible(app().getByRole('slider', { name: 'Курс' })));
  check('в общежитии только «Да» и «Нет»', JSON.stringify(await app().getByRole('radiogroup', { name: 'Живу в общежитии' }).getByRole('radio').allTextContents()) === JSON.stringify(['Да', 'Нет']));
  check('студент не видит рабочие действия команды', (await app().getByRole('heading', { name: 'Работа со справочником', exact: true }).count()) === 0);
  check('студенту не нужно вводить направление: факультет уже известен', (await app().getByRole('textbox', { name: 'Направление или программа' }).count()) === 0);
  // Курс — шкала: двигаем ползунок и отпускаем (сохранение — по отпусканию, а не на каждом делении)
  const course = app().getByRole('slider', { name: 'Курс' });
  await course.fill('2');
  await course.blur();
  await app().getByRole('radiogroup', { name: 'Живу в общежитии' }).getByRole('radio', { name: 'Нет', exact: true }).click();
  await app().getByText('Сохранено — справочник уже показывает ваше', { exact: true }).waitFor();
  await openTab('Справочник');
  await go('Профиль');
  check('курс и общежитие сохраняются', await app().getByRole('slider', { name: 'Курс' }).inputValue() === '2' && await app().getByRole('radiogroup', { name: 'Живу в общежитии' }).getByRole('radio', { name: 'Нет', exact: true }).getAttribute('aria-checked') === 'true');
  await app().getByRole('radiogroup', { name: 'Тема оформления' }).scrollIntoViewIfNeeded();
  const tops = await app().getByRole('radiogroup', { name: 'Тема оформления' }).getByRole('radio').evaluateAll((buttons) => buttons.map((button) => button.getBoundingClientRect().top));
  check('три темы находятся в одной строке', Math.max(...tops) - Math.min(...tops) < 2);
  await shot('student-profile');
  await openTab('Редактор');
  check('редактор закрыт для студента', await visible(app().getByText('Раздел для команды справочника')));
  await shot('student');

  // 11. Студент ИИТ видит общую справку вместе с уточнением своего факультета
  await say('справка об обучении');
  await lastBot().locator('.kbtn', { hasText: 'Открыть страницу' }).click();
  check('студент: общая страница открылась', await visible(app().getByRole('heading', { name: 'Справка об обучении' })));
  check('студент: уточнение «В ИИТ» с кабинетом 214 внутри общей страницы', await visible(app().locator('.hb-local', { hasText: '214' })) && await visible(app().getByText('В ИИТ', { exact: true })));
  check('студент: подпись источника — общая инструкция университета', await visible(app().getByText(/общая инструкция университета/)));
  await shot('student-shared-page');

  // 12. Роль «Университет»: кабинет, общая база, влияние правки, подключение факультета
  await page.locator('.kbtn', { hasText: 'Сменить роль' }).last().click();
  await visible(page.locator('.kbtn', { hasText: 'Университет' }));
  await page.locator('.kbtn', { hasText: 'Университет' }).last().click();
  check('бот подтвердил роль университета', await visible(page.locator('.msg--bot', { hasText: 'администратор университета' })));
  check('в чате есть кнопка «Кабинет университета»', await visible(lastBot().locator('.kbtn', { hasText: 'Кабинет университета' })));
  const uniDock = () => app().getByRole('navigation', { name: 'Навигация кабинета университета' });
  check('кабинет открылся на обзоре', await visible(app().getByRole('heading', { name: 'Обзор', exact: true }), 15_000));
  const uniTabs = ['Обзор', 'База', 'Факультеты', 'Профиль'];
  check('у университета четыре вкладки дока', JSON.stringify(await uniDock().getByRole('button').evaluateAll((buttons) => buttons.map((button) => button.getAttribute('aria-label')))) === JSON.stringify(uniTabs));
  check('обзор: блок «Требует внимания»', await visible(app().getByRole('region', { name: 'Требует внимания' })));
  check('обзор: подключено два факультета', await visible(app().getByText('факультета подключено', { exact: true })));
  await setAppWidth(375);
  await shot('university-overview');
  for (const width of [320, 375, 430]) {
    await setAppWidth(width);
    for (const name of uniTabs) {
      await uniDock().getByRole('button', { name, exact: true }).click();
      await app().getByRole('heading', { level: 1 }).first().waitFor();
      await app().locator('.skeleton').first().waitFor({ state: 'detached', timeout: 8000 }).catch(() => undefined);
      await checkLayout(`Университет, ${name}`, width);
    }
  }
  await setAppWidth(375);
  await uniDock().getByRole('button', { name: 'База', exact: true }).click();
  check('база: единые инструкции вуза', await visible(app().getByRole('heading', { name: 'Единые инструкции вуза' })));
  await shot('university-base');
  await app().locator('.hb-editor-page-row', { hasText: 'Справка об обучении' }).first().click();
  check('общая страница: видно, какие факультеты её используют', await visible(app().getByText('Страницу видят студенты 2 факультетов', { exact: true })));
  check('общая страница: уточнения ИИТ и ЭФ перечислены', await visible(app().locator('.hb-impact__list li', { hasText: '214' })) && await visible(app().locator('.hb-impact__list li', { hasText: '305' })));
  check('общая страница: карточка ответственного', await visible(app().getByRole('region', { name: /Кто отвечает/ }).or(app().getByText('Кто отвечает', { exact: false }))));
  check('у общей страницы выбор факультетов: по умолчанию все', await app().getByRole('button', { name: 'Все факультеты' }).getAttribute('aria-pressed') === 'true');
  await app().getByRole('button', { name: 'Что значат эти статусы' }).click();
  check('справка по статусам открывается', await visible(app().getByRole('dialog').getByText('Своя версия · нужно сверить')));
  await app().getByRole('dialog').getByRole('button', { name: 'Закрыть' }).first().click();
  await app().getByRole('region', { name: 'Кто видит страницу' }).scrollIntoViewIfNeeded();
  await shot('university-impact');
  check('у общей страницы нет QR-плаката: студенты читают её в справочнике факультета', (await app().getByRole('button', { name: 'QR-плакат' }).count()) === 0);
  await app().getByRole('button', { name: 'Назад: Общая база' }).first().click();
  check('из страницы базы — назад к списку, док кабинета на месте', await visible(uniDock()));
  await uniDock().getByRole('button', { name: 'Факультеты', exact: true }).click();
  check('факультеты: ИИТ и ЭФ', await visible(app().getByText('Институт информационных технологий', { exact: false })) && await visible(app().getByText(/Экономическ/).first()));
  // Предпросмотр «глазами студента»: заголовок главной лежит на фото, а не съезжает с него
  await app().getByRole('button', { name: 'Открыть как студент' }).first().click();
  await app().getByRole('button', { name: 'Кабинет университета' }).waitFor();
  const heroFit = await (await appFrame()).evaluate(() => {
    const cover = document.querySelector('.hb-reader-hero .hb-cover')?.getBoundingClientRect();
    const sub = document.querySelector('.hb-reader-hero .hb-hero__sub')?.getBoundingClientRect();
    return cover && sub ? { cover: Math.round(cover.bottom), sub: Math.round(sub.bottom) } : null;
  });
  check('глазами студента: заголовок и подпись на фото', Boolean(heroFit && heroFit.sub <= heroFit.cover), JSON.stringify(heroFit));
  await app().getByRole('button', { name: 'Кабинет университета' }).click();
  await uniDock().getByRole('button', { name: 'Факультеты', exact: true }).click();
  await app().getByRole('button', { name: 'Подключить факультет' }).first().click();
  const examples = await app().getByRole('dialog').locator('input.hb-input').evaluateAll((inputs) => inputs.map((input) => input.getAttribute('placeholder') ?? ''));
  check('подсказки в форме факультета — примеры, а не значения', examples.length === 3 && examples.every((text) => text.startsWith('Например:')), examples.join(' | '));
  check('пустую форму факультета нельзя отправить', await app().getByRole('button', { name: 'Создать и получить ссылку' }).isDisabled());
  await app().getByRole('textbox', { name: 'Название' }).fill('Юридический институт');
  await app().getByRole('textbox', { name: /Коротко/ }).fill('ЮИ');
  await app().getByRole('textbox', { name: /Администратор факультета/ }).fill('Морозова Ирина Олеговна');
  await app().getByRole('button', { name: 'Создать и получить ссылку' }).click();
  check('подключение факультета: личная ссылка администратору', await visible(app().getByRole('textbox', { name: /Личная ссылка для/ })));
  await shot('university-new-faculty');
  await app().getByRole('dialog').getByRole('button', { name: 'Закрыть' }).first().click();
  check('ЮИ появился в списке', await visible(app().getByText('Юридический институт', { exact: true })));
  const ui = app().locator('.uni-faculty', { hasText: 'Юридический институт' });
  await ui.getByRole('button', { name: 'Отключить факультет' }).click();
  const disable = app().getByRole('dialog').getByRole('button', { name: 'Отключить факультет' });
  check('отключение факультета требует вписать название', await disable.isDisabled());
  await app().getByRole('dialog').getByRole('textbox').fill('ЮИ');
  await disable.click();
  check('отключённый факультет — в «Отключённых»', await visible(app().locator('.uni-faculty--closed', { hasText: 'Юридический институт' })));
  await shot('university-closed-faculty');
  await app().locator('.uni-faculty--closed', { hasText: 'Юридический институт' }).getByRole('button', { name: 'Восстановить факультет' }).click();
  check('факультет восстанавливается одним нажатием', await visible(app().locator('.uni-faculty:not(.uni-faculty--closed)', { hasText: 'Юридический институт' })));
  await uniDock().getByRole('button', { name: 'Профиль', exact: true }).click();
  check('в профиле кабинета есть выбор темы', await visible(app().getByRole('radiogroup', { name: 'Тема оформления' })));
  check('в профиле кабинета — справка по общей базе и нет плашки предпросмотра', await visible(app().getByRole('button', { name: /Как работает общая база/ })) && (await app().getByText('Как его видят студенты').count()) === 0);
} catch (error) {
  check('сценарий прошёл без исключений', false, error?.stack ?? error);
  await shot('failure').catch(() => undefined);
}

check('в консоли нет ошибок страницы', pageErrors.length === 0, pageErrors.join(' | '));
await browser.close();
console.log(failures.length ? `\nПРОВАЛЕНО: ${failures.length}\n- ${failures.join('\n- ')}` : '\nСЦЕНАРИЙ ПРОЙДЕН');
process.exit(failures.length ? 1 : 0);
