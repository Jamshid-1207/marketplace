import type { Request, RequestHandler, Response } from 'express';
import { createProxyMiddleware } from 'http-proxy-middleware';
import type { ServerResponse } from 'node:http';
import type { Socket } from 'node:net';

export interface UpstreamOptions {
  target: string;
  timeoutMs: number;
  /** Префикс пути gateway, которого нет у сервиса: `/api/orders` → `/orders`. */
  stripPrefix?: string;
}

const isResponse = (res: ServerResponse | Socket): res is ServerResponse => 'writeHead' in res;

/**
 * Проксирование во внутренний сервис (SD-02, п. 3.1) поверх модуля `http`: его инструментирует
 * OpenTelemetry, и `traceparent` уходит дальше сам. `X-Request-Id` — от CorrelationMiddleware.
 * Тело не разбирается: оно идёт потоком как есть, поэтому подпись webhook остаётся верной.
 */
export function upstream({ target, timeoutMs, stripPrefix }: UpstreamOptions): RequestHandler {
  return createProxyMiddleware<Request, Response>({
    target,
    changeOrigin: true,
    proxyTimeout: timeoutMs,
    ...(stripPrefix ? { pathRewrite: { [`^${stripPrefix}`]: '' } } : {}),
    on: {
      proxyReq: (proxyReq, req) => {
        const id = (req as Request & { id?: unknown }).id;
        if (typeof id === 'string') proxyReq.setHeader('x-request-id', id);
      },
      error: (error, _req, res) => {
        if (!isResponse(res) || res.headersSent) return;
        const timeout = (error as NodeJS.ErrnoException).code === 'ECONNRESET';
        res.writeHead(timeout ? 504 : 502, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ statusCode: timeout ? 504 : 502, message: 'сервис недоступен' }));
      },
    },
  }) as unknown as RequestHandler;
}
