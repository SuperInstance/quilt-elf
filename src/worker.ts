/**
 * The actual Cloudflare Worker that runs the elves.
 *
 * Deploy with wrangler:
 *   cd /workspace/quilt-elf
 *   wrangler deploy
 *
 * Set up cron in wrangler.toml:
 *   [triggers]
 *   crons = ["* /15 * * * *"]  // every 15 minutes
 */
import { Elf } from './index.js';

export interface Env {
  ZAI_TOKEN?: string;
  KIMI_TOKEN?: string;
  DEEPSEEK_TOKEN?: string;
  CLOUDFLARE_ACCOUNT_ID?: string;
  CLOUDFLARE_API_TOKEN?: string;
  // KV binding for usage storage
  USAGE_KV?: KVNamespace;
  // Durable Object for vibe state
  VIBE_STATE?: DurableObjectNamespace;
}

export default {
  /** Cron-triggered entry point. */
  async scheduled(event: ScheduledEvent, env: Env, ctx: ExecutionContext): Promise<void> {
    const elf = new Elf({
      providers: {
        zai: env.ZAI_TOKEN
          ? { apiKey: env.ZAI_TOKEN, tier: 'free', dailyFreeQuota: 100000, specialty: 'high-concurrency' }
          : undefined,
        kimi: env.KIMI_TOKEN
          ? { apiKey: env.KIMI_TOKEN, tier: 'free', dailyFreeQuota: 100000, specialty: 'math' }
          : undefined,
        deepseek: env.DEEPSEEK_TOKEN
          ? { apiKey: env.DEEPSEEK_TOKEN, tier: 'metered', specialty: 'niche' }
          : undefined,
        cloudflare: env.CLOUDFLARE_ACCOUNT_ID && env.CLOUDFLARE_API_TOKEN
          ? { apiKey: `${env.CLOUDFLARE_ACCOUNT_ID}:${env.CLOUDFLARE_API_TOKEN}`, tier: 'free' }
          : undefined,
      },
      storage: env.USAGE_KV ? kvStorage(env.USAGE_KV) : undefined,
      log: (msg) => console.log(`[elf] ${msg}`),
    });

    ctx.waitUntil(elf.run());
  },

  /** HTTP entry point for the dashboard. */
  async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    const url = new URL(request.url);
    if (url.pathname === '/api/usage') {
      const elf = new Elf({ providers: {} });
      const usage = await elf.getUsageReport();
      return new Response(JSON.stringify(usage, null, 2), {
        headers: { 'Content-Type': 'application/json' },
      });
    }
    if (url.pathname === '/api/run') {
      const elf = new Elf({
        providers: {
          zai: env.ZAI_TOKEN ? { apiKey: env.ZAI_TOKEN, tier: 'free' } : undefined,
        },
        log: (msg) => console.log(`[elf] ${msg}`),
      });
      const results = await elf.run();
      return new Response(JSON.stringify(results, null, 2), {
        headers: { 'Content-Type': 'application/json' },
      });
    }
    return new Response('Not found', { status: 404 });
  },
};

/** Adapter to use Cloudflare KV as a ResourceStorage. */
function kvStorage(kv: KVNamespace): {
  get: (key: string) => Promise<string | null>;
  put: (key: string, value: string) => Promise<void>;
  delete: (key: string) => Promise<void>;
} {
  return {
    async get(key) { return kv.get(key); },
    async put(key, value) { await kv.put(key, value); },
    async delete(key) { await kv.delete(key); },
  };
}
