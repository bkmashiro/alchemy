// src/tunnel/manager.ts

import { spawn, ChildProcess } from 'node:child_process';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { createLogger } from '../core/logger.js';

const execFileAsync = promisify(execFile);

export class TunnelManager {
  private process: ChildProcess | null = null;
  private url: string | null = null;
  private logger = createLogger('TunnelManager');

  /**
   * Check which tunnel binaries are available in PATH.
   */
  async detect(): Promise<{ ngrok: boolean; cloudflared: boolean }> {
    const check = async (bin: string): Promise<boolean> => {
      try {
        await execFileAsync('which', [bin]);
        return true;
      } catch {
        return false;
      }
    };

    const [ngrok, cloudflared] = await Promise.all([check('ngrok'), check('cloudflared')]);
    return { ngrok, cloudflared };
  }

  /**
   * Try to start a tunnel (ngrok first, then cloudflared).
   * Returns the public URL or null if neither succeeds.
   */
  async start(port: number): Promise<string | null> {
    const available = await this.detect();

    if (available.ngrok) {
      const url = await this.startNgrok(port);
      if (url) return url;
    }

    if (available.cloudflared) {
      const url = await this.startCloudflared(port);
      if (url) return url;
    }

    return null;
  }

  private startNgrok(port: number): Promise<string | null> {
    return new Promise((resolve) => {
      const proc = spawn('ngrok', ['http', String(port), '--log', 'stdout', '--log-format', 'json'], {
        stdio: ['ignore', 'pipe', 'pipe'],
      });

      this.process = proc;

      const timer = setTimeout(() => {
        this.logger.warn('ngrok timed out waiting for tunnel URL');
        resolve(null);
      }, 8000);

      let resolved = false;

      const handleLine = (line: string) => {
        const trimmed = line.trim();
        if (!trimmed) return;
        try {
          const parsed = JSON.parse(trimmed) as Record<string, unknown>;
          if (
            parsed['lvl'] === 'info' &&
            parsed['msg'] === 'started tunnel' &&
            typeof parsed['url'] === 'string'
          ) {
            if (!resolved) {
              resolved = true;
              clearTimeout(timer);
              this.url = parsed['url'] as string;
              this.logger.info({ url: this.url }, 'ngrok tunnel started');
              resolve(this.url);
            }
          }
        } catch {
          // Not JSON, skip
        }
      };

      let buf = '';
      proc.stdout?.on('data', (chunk: Buffer) => {
        buf += chunk.toString();
        const lines = buf.split('\n');
        buf = lines.pop() ?? '';
        for (const line of lines) handleLine(line);
      });

      proc.on('error', (err) => {
        this.logger.error({ err }, 'ngrok process error');
        if (!resolved) {
          resolved = true;
          clearTimeout(timer);
          resolve(null);
        }
      });

      proc.on('exit', (code) => {
        if (!resolved) {
          resolved = true;
          clearTimeout(timer);
          this.logger.warn({ code }, 'ngrok exited before providing URL');
          resolve(null);
        }
      });
    });
  }

  private startCloudflared(port: number): Promise<string | null> {
    return new Promise((resolve) => {
      const proc = spawn(
        'cloudflared',
        ['tunnel', '--url', `http://localhost:${port}`, '--no-autoupdate'],
        { stdio: ['ignore', 'pipe', 'pipe'] },
      );

      this.process = proc;

      const timer = setTimeout(() => {
        this.logger.warn('cloudflared timed out waiting for tunnel URL');
        resolve(null);
      }, 10000);

      let resolved = false;
      const urlPattern = /https:\/\/[a-z0-9-]+\.trycloudflare\.com/;

      const handleLine = (line: string) => {
        const match = urlPattern.exec(line);
        if (match && !resolved) {
          resolved = true;
          clearTimeout(timer);
          this.url = match[0];
          this.logger.info({ url: this.url }, 'cloudflared tunnel started');
          resolve(this.url);
        }
      };

      // cloudflared writes its URL to stderr
      let stderrBuf = '';
      proc.stderr?.on('data', (chunk: Buffer) => {
        stderrBuf += chunk.toString();
        const lines = stderrBuf.split('\n');
        stderrBuf = lines.pop() ?? '';
        for (const line of lines) handleLine(line);
      });

      proc.on('error', (err) => {
        this.logger.error({ err }, 'cloudflared process error');
        if (!resolved) {
          resolved = true;
          clearTimeout(timer);
          resolve(null);
        }
      });

      proc.on('exit', (code) => {
        if (!resolved) {
          resolved = true;
          clearTimeout(timer);
          this.logger.warn({ code }, 'cloudflared exited before providing URL');
          resolve(null);
        }
      });
    });
  }

  /** Kill the tunnel process. */
  stop(): void {
    if (this.process) {
      this.process.kill();
      this.process = null;
      this.url = null;
      this.logger.info('Tunnel stopped');
    }
  }

  /** Return the current public URL, or null if no tunnel is active. */
  getUrl(): string | null {
    return this.url;
  }
}

export const tunnelManager = new TunnelManager();
