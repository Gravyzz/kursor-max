import { useEffect, useState } from 'react';
import { Button } from '@maxhub/max-ui';
import QRCode from 'qrcode';
import { bridge } from '../../lib/bridge';
import { Sheet } from '../../components/ui';
import { useHandbook } from './context';

/**
 * QR-плакат: страница справочника «выходит» из телефона на дверь деканата, стенд в общежитии
 * или слайд на собрании первокурсников. Камера телефона или сканер MAX открывает ссылку
 * `max.ru/<бот>?startapp=hbp_<страница>` — и студент сразу попадает на нужную страницу в мини-приложении.
 */
export function QrPosterSheet({
  title,
  eyebrow,
  link,
  onClose,
}: {
  title: string;
  eyebrow?: string;
  link: string;
  onClose: () => void;
}) {
  const hb = useHandbook();
  const [svg, setSvg] = useState<string | null>(null);
  // Готовая картинка остаётся в листе: во встроенном окне (веб-версия MAX) скачивание может быть запрещено
  const [png, setPng] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    let alive = true;
    QRCode.toString(link, { type: 'svg', margin: 0, errorCorrectionLevel: 'M', color: { dark: '#111318', light: '#ffffff' } })
      .then((markup) => alive && setSvg(markup))
      .catch(() => alive && setSvg(null));
    // Плакат часто показывают с экрана телефона — пусть его будет видно и в светлой аудитории.
    // MAX держит максимальную яркость 30 секунд, поэтому продлеваем, пока лист открыт.
    void bridge.brightness(true);
    const keepBright = window.setInterval(() => void bridge.brightness(true), 25_000);
    return () => {
      alive = false;
      window.clearInterval(keepBright);
      void bridge.brightness(false);
    };
  }, [link]);

  const share = async () => {
    if (bridge.share(`${title} — справочник факультета в MAX`, link)) return;
    try {
      await navigator.clipboard.writeText(link);
      hb.toast('Ссылка скопирована');
    } catch {
      hb.toast('Выделите ссылку под QR-кодом и скопируйте', 'error');
    }
  };

  const savePng = async () => {
    setSaving(true);
    try {
      const url = await posterPng(title, eyebrow ?? '', link);
      setPng(url);
      const anchor = document.createElement('a');
      anchor.href = url;
      anchor.download = 'qr-spravochnik.png';
      anchor.click();
    } catch {
      hb.toast('Не получилось подготовить картинку — сделайте снимок экрана', 'error');
    } finally {
      setSaving(false);
    }
  };

  return (
    <Sheet title="QR-плакат" onClose={onClose}>
      <div className="qr-poster" role="img" aria-label={`QR-код: ${title}`}>
        {eyebrow ? <span className="qr-poster__eyebrow">{eyebrow}</span> : null}
        <span className="qr-poster__title">{title}</span>
        <div className="qr-poster__code" dangerouslySetInnerHTML={svg ? { __html: svg } : undefined} />
        <span className="qr-poster__caption">Наведите камеру телефона — страница откроется в MAX</span>
      </div>
      <code className="hb-code" style={{ wordBreak: 'break-all' }}>{link}</code>
      <span className="faint small">
        Повесьте у кабинета, в общежитии или покажите на собрании. Ответ всегда актуален: плакат ведёт на страницу, а не на её копию.
      </span>
      <Button variant="primary" size="large" onClick={share}>
        {bridge.inMax ? 'Отправить ссылку в MAX' : 'Скопировать ссылку'}
      </Button>
      {!bridge.isMobile ? (
        <Button variant="secondary" size="large" loading={saving} onClick={savePng}>
          Сохранить картинку для печати
        </Button>
      ) : null}
      {png ? (
        <figure className="qr-poster__png">
          <img src={png} alt={`Плакат для печати: ${title}`} width={600} height={750} />
          <figcaption className="faint small">
            Если файл не скачался, нажмите на картинку правой кнопкой мыши и выберите «Сохранить изображение».
          </figcaption>
        </figure>
      ) : null}
    </Sheet>
  );
}

/** Картинка для печати: заголовок, QR и подпись на белом листе. */
async function posterPng(title: string, eyebrow: string, link: string): Promise<string> {
  const width = 1200;
  const height = 1500;
  const canvas = document.createElement('canvas');
  canvas.width = width;
  canvas.height = height;
  const ctx = canvas.getContext('2d');
  if (!ctx) throw new Error('canvas');
  ctx.fillStyle = '#ffffff';
  ctx.fillRect(0, 0, width, height);
  ctx.fillStyle = '#5b6475';
  ctx.font = '600 40px system-ui, sans-serif';
  ctx.textAlign = 'center';
  if (eyebrow) ctx.fillText(eyebrow.toUpperCase(), width / 2, 130);
  ctx.fillStyle = '#111318';
  ctx.font = '700 72px system-ui, sans-serif';
  wrap(ctx, title, width / 2, 230, width - 160, 84, 2);
  const qr = await QRCode.toDataURL(link, { margin: 0, width: 760, errorCorrectionLevel: 'M' });
  const image = new Image();
  await new Promise<void>((resolve, reject) => {
    image.onload = () => resolve();
    image.onerror = () => reject(new Error('qr'));
    image.src = qr;
  });
  ctx.drawImage(image, (width - 760) / 2, 440, 760, 760);
  ctx.fillStyle = '#111318';
  ctx.font = '500 44px system-ui, sans-serif';
  ctx.fillText('Наведите камеру телефона —', width / 2, 1300);
  ctx.fillText('страница откроется в MAX', width / 2, 1360);
  return canvas.toDataURL('image/png');
}

function wrap(ctx: CanvasRenderingContext2D, text: string, x: number, y: number, maxWidth: number, lineHeight: number, maxLines: number) {
  const words = text.split(/\s+/);
  const lines: string[] = [];
  let line = '';
  for (const word of words) {
    const next = line ? `${line} ${word}` : word;
    if (ctx.measureText(next).width > maxWidth && line) {
      lines.push(line);
      line = word;
    } else {
      line = next;
    }
  }
  if (line) lines.push(line);
  lines.slice(0, maxLines).forEach((value, index) => {
    const last = index === maxLines - 1 && lines.length > maxLines;
    ctx.fillText(last ? `${value}…` : value, x, y + index * lineHeight);
  });
}
