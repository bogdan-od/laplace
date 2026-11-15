import { NestExpressApplication } from '@nestjs/platform-express';
import { WsAdapter } from '@nestjs/platform-ws';
import cookieParser from 'cookie-parser';
import { SESSION_COOKIE } from './auth/auth.types';
import { SessionService } from './auth/session.service';
import { ApiExceptionFilter } from './common/api-exception.filter';
import { largeBodies } from './common/large-bodies';
import { requestLogger } from './common/request-logger';
import { createValidationPipe } from './common/validation';
import { useImageFiles } from './static-files';
import { useSwagger } from './swagger';
import { defaultWebDist, useWebApp } from './web-app';

/** Default JSON body limit; journal routes need their own larger parser. */
const JSON_LIMIT = '1mb';

/** `webDist` is the built front end to serve; tests pass their own directory. */
export function configureApp(
  app: NestExpressApplication,
  webDist: string = defaultWebDist(),
): void {
  app.use(requestLogger);
  app.use(cookieParser());
  const sessions = app.get(SessionService);
  app.use(
    largeBodies(
      (req) =>
        sessions.userFromToken(
          (req.cookies as Record<string, unknown> | undefined)?.[
            SESSION_COOKIE
          ],
        ) !== undefined,
    ),
  );
  app.useBodyParser('json', { limit: JSON_LIMIT });
  // RoomsGateway parses its own messages; the adapter's JSON parser would only repeat the work.
  app.useWebSocketAdapter(
    new WsAdapter(app, { messageParser: () => undefined }),
  );
  app.useGlobalPipes(createValidationPipe());
  app.useGlobalFilters(new ApiExceptionFilter());
  useImageFiles(app);
  useWebApp(app, webDist);
  useSwagger(app);
}
