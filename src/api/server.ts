import Fastify, { FastifyInstance } from 'fastify';
import { ZodError } from 'zod';
import { FfmpegError } from '../audio/ffmpeg.js';
import { TimelineError } from '../audio/timeline.js';
import { GeminiTtsError } from '../providers/gemini.js';
import { ScriptParseError } from '../script/parser.js';
import { StudioService } from '../studio/service.js';
import { StoreError } from '../studio/store.js';
import { registerRoutes } from './routes.js';

export interface BuildServerOptions {
  service: StudioService;
  logger?: boolean;
}

export function buildServer(options: BuildServerOptions): FastifyInstance {
  const app = Fastify({
    logger: options.logger ?? false,
    bodyLimit: 50 * 1024 * 1024, // 50 MB for audio asset uploads
  });

  // Accept raw binary audio uploads on PUT /assets/*
  app.addContentTypeParser(
    ['application/octet-stream', 'audio/wav', 'audio/x-wav', 'audio/ogg', 'audio/mpeg', 'audio/flac', 'audio/mp4'],
    { parseAs: 'buffer' },
    (_req, body, done) => {
      done(null, body);
    },
  );

  app.setErrorHandler((err, _req, reply) => {
    if (err instanceof ZodError) {
      return reply.code(400).send({
        error: 'ValidationError',
        message: 'Invalid request payload',
        issues: err.issues,
      });
    }

    if (
      err instanceof StoreError ||
      err instanceof ScriptParseError ||
      err instanceof TimelineError ||
      err instanceof GeminiTtsError
    ) {
      return reply.code(err.statusCode).send({
        error: err.name,
        message: err.message,
      });
    }

    if (err instanceof FfmpegError) {
      return reply.code(500).send({
        error: 'FfmpegError',
        message: err.message,
      });
    }

    const statusCode =
      typeof (err as { statusCode?: unknown }).statusCode === 'number'
        ? (err as { statusCode: number }).statusCode
        : 500;
    const message = err instanceof Error ? err.message : String(err);

    return reply.code(statusCode).send({
      error: statusCode >= 500 ? 'InternalServerError' : 'RequestError',
      message,
    });
  });

  registerRoutes(app, options.service);
  return app;
}
