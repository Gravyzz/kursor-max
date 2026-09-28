import type { Db } from '../db/pool.js';

interface UpdateLike {
  update_type?: string;
  timestamp?: number;
  user?: { user_id?: number } | null;
  callback?: { callback_id?: string } | null;
  message?: { body?: { mid?: string } | null } | null;
}

/** Ключ идемпотентности обновления MAX; null — обновление не требует защиты от повторов. */
export function updateKey(update: UpdateLike | undefined | null): string | null {
  switch (update?.update_type) {
    case 'message_callback':
      return update.callback?.callback_id ? `cb:${update.callback.callback_id}` : null;
    case 'message_created':
      return update.message?.body?.mid ? `msg:${update.message.body.mid}` : null;
    case 'bot_started':
      return update.user?.user_id && update.timestamp ? `start:${update.user.user_id}:${update.timestamp}` : null;
    default:
      return null;
  }
}

/** Отмечает обновление как принятое. true — встречается впервые и его нужно обработать. */
export async function markProcessed(db: Db, key: string): Promise<boolean> {
  const result = await db.query('INSERT INTO processed_updates(key) VALUES ($1) ON CONFLICT (key) DO NOTHING', [key]);
  return (result.rowCount ?? 0) > 0;
}
