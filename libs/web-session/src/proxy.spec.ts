import { NextRequest } from 'next/server';
import { createSessionProxy } from './proxy';
import { RefreshCoordinator } from './refresh';

const names = { access: 'x_access', refresh: 'x_refresh' };
const token = (expSeconds: number) =>
  ['h', Buffer.from(JSON.stringify({ exp: expSeconds })).toString('base64url'), 's'].join('.');
const pair = { accessToken: 'new-access', refreshToken: 'new-refresh', expiresIn: 900 };

function request(cookies: Record<string, string>) {
  const cookie = Object.entries(cookies)
    .map(([k, v]) => `${k}=${v}`)
    .join('; ');
  return new NextRequest('http://front.test/orders', {
    headers: { cookie, 'x-forwarded-for': '203.0.113.9' },
  });
}

const setCookies = (response: Response) => response.headers.getSetCookie().join('\n');

describe('middleware сессии (SD-07, п. 3.1)', () => {
  const log = { warn: jest.fn() };
  let fetchMock: jest.Mock;
  const proxy = () =>
    createSessionProxy({
      gatewayUrl: 'http://gateway.test',
      cookies: names,
      secure: false,
      log,
      coordinator: new RefreshCoordinator(),
    });

  beforeEach(() => {
    fetchMock = jest.fn();
    global.fetch = fetchMock;
    log.warn.mockClear();
  });

  it('свежий токен — запрос дальше без обновления, с X-Request-Id', async () => {
    const response = await proxy()(
      request({ x_access: token(Date.now() / 1000 + 600), x_refresh: 'r' }),
    );
    expect(fetchMock).not.toHaveBeenCalled();
    expect(response.headers.get('x-middleware-request-x-request-id')).toBeTruthy();
  });

  it('истекает — одно обновление: новые HttpOnly cookie в ответе и в запросе, IP клиента — в gateway', async () => {
    fetchMock.mockResolvedValue(new Response(JSON.stringify(pair), { status: 200 }));
    const response = await proxy()(
      request({ x_access: token(Date.now() / 1000 + 10), x_refresh: 'r' }),
    );
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0] as [URL, RequestInit];
    expect(String(url)).toBe('http://gateway.test/api/auth/refresh');
    expect(JSON.parse(init.body as string)).toEqual({ refreshToken: 'r' });
    expect((init.headers as Record<string, string>)['x-forwarded-for']).toBe('203.0.113.9');
    expect(setCookies(response)).toMatch(/x_access=new-access;.*HttpOnly/i);
    expect(setCookies(response)).toMatch(/x_refresh=new-refresh;.*SameSite=lax/i);
    expect(response.headers.get('x-middleware-request-cookie')).toContain('x_access=new-access');
  });

  it('auth отказал — cookie сессии удаляются', async () => {
    fetchMock.mockResolvedValue(new Response('{}', { status: 401 }));
    const response = await proxy()(request({ x_refresh: 'revoked' }));
    expect(setCookies(response)).toMatch(/x_access=;/);
    expect(setCookies(response)).toMatch(/x_refresh=;/);
  });

  it('gateway недоступен — сессию не трогаем, пишем в лог', async () => {
    fetchMock.mockRejectedValue(new Error('ECONNREFUSED'));
    const response = await proxy()(request({ x_refresh: 'r' }));
    expect(setCookies(response)).toBe('');
    expect(log.warn).toHaveBeenCalledTimes(1);
  });
});
