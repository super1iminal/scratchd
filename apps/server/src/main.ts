import { ensureDevResources } from './aws.ts';
import { buildApp } from './app.ts';

if (process.env.DYNAMO_ENDPOINT) await ensureDevResources();
await buildApp().listen({ host: '0.0.0.0', port: Number(process.env.PORT ?? 3000) });
