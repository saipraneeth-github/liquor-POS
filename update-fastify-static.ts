import fs from 'fs';
import path from 'path';

const appPath = path.resolve('src/app.ts');
let content = fs.readFileSync(appPath, 'utf8');

if (!content.includes("import fastifyStatic")) {
  content = content.replace("import fastifyRateLimit from '@fastify/rate-limit';", "import fastifyRateLimit from '@fastify/rate-limit';\nimport fastifyStatic from '@fastify/static';");
}

if (!content.includes("fastify.register(fastifyStatic")) {
  content = content.replace(
    "fastify.register(fastifyJwt, {",
    `fastify.register(fastifyStatic, {
    root: path.join(process.cwd(), 'frontend/dist'),
    prefix: '/',
    wildcard: false, // disable wildcard to handle it manually for SPA
  });\n\n  fastify.register(fastifyJwt, {`
  );
}

// Modify the generic route to return the static index.html for unknown routes to support SPA
content = content.replace(
  "fastify.get('/favicon.ico', async (_request, reply) => {\n    return reply.code(204).send();\n  });",
  `fastify.get('/favicon.ico', async (_request, reply) => {\n    return reply.code(204).send();\n  });\n\n  fastify.setNotFoundHandler((request, reply) => {\n    if (request.url.startsWith('/api/')) {\n      return reply.code(404).send({ error: 'Not found' });\n    }\n    return reply.sendFile('index.html');\n  });`
);

fs.writeFileSync(appPath, content);
