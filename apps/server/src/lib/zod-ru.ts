import { z } from 'zod';

/**
 * Сообщения проверки данных по-русски для случаев, где в схеме не задан свой текст.
 * Иначе пользователь увидел бы «Invalid uuid» или «Expected number, received string».
 */
const russianErrors: z.ZodErrorMap = (issue, ctx) => {
  switch (issue.code) {
    case z.ZodIssueCode.invalid_type:
      return { message: issue.received === 'undefined' || issue.received === 'null' ? 'Заполните обязательное поле' : 'Неверный формат данных' };
    case z.ZodIssueCode.invalid_string:
      if (issue.validation === 'uuid') return { message: 'Ссылка устарела или указана неверно' };
      if (issue.validation === 'url') return { message: 'Ссылка должна начинаться с https://' };
      if (issue.validation === 'email') return { message: 'Проверьте адрес почты' };
      return { message: 'Неверный формат' };
    case z.ZodIssueCode.too_small:
      if (issue.type === 'string') return { message: Number(issue.minimum) <= 1 ? 'Заполните поле' : `Слишком коротко: нужно от ${issue.minimum} символов` };
      if (issue.type === 'array') return { message: `Нужно выбрать хотя бы ${issue.minimum}` };
      return { message: `Значение не меньше ${issue.minimum}` };
    case z.ZodIssueCode.too_big:
      if (issue.type === 'string') return { message: `Слишком длинно: не больше ${issue.maximum} символов` };
      if (issue.type === 'array') return { message: `Не больше ${issue.maximum} элементов` };
      return { message: `Значение не больше ${issue.maximum}` };
    case z.ZodIssueCode.invalid_enum_value:
    case z.ZodIssueCode.invalid_literal:
    case z.ZodIssueCode.invalid_union_discriminator:
      return { message: 'Выберите один из предложенных вариантов' };
    case z.ZodIssueCode.unrecognized_keys:
      return { message: 'В запросе лишние поля' };
    case z.ZodIssueCode.invalid_date:
      return { message: 'Такой даты нет в календаре' };
    default:
      return { message: ctx.defaultError };
  }
};

z.setErrorMap(russianErrors);
