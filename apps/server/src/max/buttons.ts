import { config } from '../config.js';
import type { BotIdentity } from './bot.js';
import { deepLink } from './bot.js';

export type InlineButton =
  | { type: 'callback'; text: string; payload: string }
  | { type: 'link'; text: string; url: string }
  | { type: 'open_app'; text: string; web_app: string; contact_id?: number; payload?: string };

/** Кнопка запуска мини-приложения с параметром. Если данных бота нет — диплинк ?startapp. */
export function appButton(identity: BotIdentity, text: string, startParam?: string): InlineButton {
  if (config.MINIAPP_BUTTON === 'open_app' && identity.username) {
    return {
      type: 'open_app',
      text,
      web_app: identity.username,
      ...(identity.userId ? { contact_id: identity.userId } : {}),
      ...(startParam ? { payload: startParam } : {}),
    };
  }
  return { type: 'link', text, url: deepLink(identity, 'startapp', startParam) };
}

export const callbackButton = (text: string, payload: string): InlineButton => ({ type: 'callback', text, payload });

export function keyboard(rows: InlineButton[][]) {
  return { type: 'inline_keyboard' as const, payload: { buttons: rows.filter((row) => row.length > 0) } };
}
