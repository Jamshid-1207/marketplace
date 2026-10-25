import { fromResponse } from './action-state';

describe('ошибки API — понятным текстом (SD-08, п. 3.4)', () => {
  it('статус → ошибка формы, объяснение сервиса — рядом', () => {
    expect(fromResponse(409, { message: 'остаток ниже резерва' })).toEqual({
      status: 'error',
      error: 'conflict',
      detail: 'остаток ниже резерва',
    });
    expect(fromResponse(422, { message: 'выплата меньше минимальной' })).toMatchObject({
      error: 'unprocessable',
      detail: 'выплата меньше минимальной',
    });
    expect(fromResponse(403, { message: 'Forbidden' })).toEqual({
      status: 'error',
      error: 'forbidden',
    });
    expect(fromResponse(404, null)).toEqual({ status: 'error', error: 'notFound' });
    expect(fromResponse(502, { message: 'Bad Gateway' })).toEqual({
      status: 'error',
      error: 'failed',
    });
  });

  it('разбор zod не показывается', () => {
    expect(fromResponse(400, { message: '✖ Invalid input\n  → at title' })).toEqual({
      status: 'error',
      error: 'invalid',
    });
  });
});
