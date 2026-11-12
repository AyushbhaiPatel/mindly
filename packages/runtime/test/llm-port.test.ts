import { createServer, type Server } from 'node:http';
import { describe, expect, it } from 'vitest';
import { defaultUserConfig } from '@mindly/core';
import { createLlmPort } from '../src/index.js';

describe('llm port', () => {
  it('says why a configured provider cannot be used', () => {
    const llm = {
      ...defaultUserConfig().llm,
      provider: 'ollama' as const,
      baseUrl: 'http://10.0.0.5:11434',
    };
    const port = createLlmPort(llm, {});
    expect(port.available).toBe(false);
    expect(port.unavailableReason).toMatch(/localhost/);
    expect(createLlmPort(defaultUserConfig().llm, {}).unavailableReason).toBeNull();
  });

  it('applies the per-call redaction patterns to what is sent', async () => {
    const bodies: string[] = [];
    const server = await new Promise<Server>((resolve) => {
      const s = createServer((req, res) => {
        let body = '';
        req.on('data', (c: Buffer) => (body += c.toString()));
        req.on('end', () => {
          bodies.push(body);
          res.setHeader('content-type', 'application/json');
          res.end(
            JSON.stringify({
              message: { content: '{"isRule":false,"rule":"","scopeGlobs":[],"confidence":0}' },
            }),
          );
        });
      });
      s.listen(0, '127.0.0.1', () => resolve(s));
    });
    try {
      const address = server.address();
      const port = typeof address === 'object' && address ? address.port : 0;
      const llm = createLlmPort(
        { ...defaultUserConfig().llm, provider: 'ollama', baseUrl: `http://127.0.0.1:${port}` },
        {},
      );
      await llm.classifyCorrection('No, use ACME-INTERNAL-424242 instead of npm.', {
        redactPatterns: ['ACME-INTERNAL-[0-9]+'],
      });
      expect(bodies).toHaveLength(1);
      expect(bodies[0]).not.toContain('ACME-INTERNAL-424242');
    } finally {
      server.close();
    }
  });
});
