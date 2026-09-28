/** Роли записей вуза. Права на справочник даёт не роль, а членство в нём (handbook_members). */
export type Role = 'student' | 'staff' | 'dean';

export const ROLE_LABEL: Record<Role, string> = {
  student: 'Студент',
  staff: 'Сотрудник',
  dean: 'Деканат',
};
