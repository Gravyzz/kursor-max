import type { DemoRole } from './types';
import type { IconName } from '../components/icons';

/** Роли демо: так жюри видит продукт глазами студента, редактора или деканата. */
export const DEMO_ROLES: Array<{ role: DemoRole; icon: IconName; title: string; name: string; text: string }> = [
  { role: 'student', icon: 'cap', title: 'Студент', name: 'студент', text: 'Ищет ответы, отмечает чек-листы, задаёт вопросы дежурному' },
  { role: 'editor', icon: 'edit', title: 'Редактор', name: 'редактор', text: 'Студсовет: правит страницы, отправляет на проверку, отвечает на вопросы' },
  { role: 'dean', icon: 'books', title: 'Деканат', name: 'деканат', text: 'Публикует, делает объявления, собирает команду, создаёт справочники' },
  { role: 'university', icon: 'uni', title: 'Университет', name: 'администратор университета', text: 'Ведёт общую базу для всех факультетов, подключает факультеты, следит за актуальностью' },
];

export const demoRoleName = (role: DemoRole) => DEMO_ROLES.find((item) => item.role === role)?.name ?? role;
