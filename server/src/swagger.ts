import { NestExpressApplication } from '@nestjs/platform-express';
import { DocumentBuilder, SwaggerModule } from '@nestjs/swagger';

export const DOCS_PATH = 'api/docs';

/** Swagger UI on /api/docs; the JSON lives under /api/docs/json so the route set stays small. */
export function useSwagger(app: NestExpressApplication): void {
  const config = new DocumentBuilder()
    .setTitle('Laplace')
    .setDescription('HTTP API of the Laplace server')
    .setVersion('1')
    .addCookieAuth('sid')
    .build();
  const document = SwaggerModule.createDocument(app, config);
  SwaggerModule.setup(DOCS_PATH, app, document, {
    jsonDocumentUrl: `${DOCS_PATH}/json`,
    yamlDocumentUrl: `${DOCS_PATH}/yaml`,
  });
}
