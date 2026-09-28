import type { DemoRole } from './types';
import type { IconName } from '../components/icons';

/** Роли демо: так жюри видит продукт глазами студента, редактора или деканата. */
export const DEMO_ROLES: Array<{ role: DemoRole; icon: IconName; title: string; text: string }> = [
  { role: 'student', icon: 'cap', title: 'Студент', text: 'Ищет ответы, отмечает чек-листы, задаёт вопросы дежурному' },
  { role: 'editor', icon: 'edit', title: 'Редактор', text: 'Студсовет: правит страницы, отправляет на проверку, отвечает на вопросы' },
  { role: 'dean', icon: 'books', title: 'Деканат', text: 'Публикует, делает объявления, собирает команду, создаёт справочники' },
];

export const demoRoleName = (role: DemoRole) => DEMO_ROLES.find((item) => item.role === role)?.title.toLowerCase() ?? role;
