// @vitest-environment node
import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { WorkstationSSHExecutorConfig, WorkstationHost, JobSpec } from '../src/core/types.js';
import { JobStatus } from '../src/core/types.js';

// Mock node-ssh before importing the executor
vi.mock('node-ssh', () => {
  class MockNodeSSH {
    private _connected = false;
    private _execResults: Record<string, { stdout: string; stderr: string; code: number }> = {};

    async connect() {
      this._connected = true;
    }

    isConnected() {
      return this._connected;
    }

    async execCommand(command: string) {
      // Default responses based on command patterns
      if (command.includes('nvidia-smi')) {
        return { stdout: '3200, 11264\n', stderr: '', code: 0 };
      }
      if (command.includes('kill -0')) {
        return { stdout: 'RUNNING\n', stderr: '', code: 0 };
      }
      if (command.includes('nohup')) {
        return { stdout: '12345\n', stderr: '', code: 0 };
      }
      if (command.includes('mkdir -p')) {
        return { stdout: '', stderr: '', code: 0 };
      }
      if (command.includes('printf')) {
        return { stdout: '', stderr: '', code: 0 };
      }
      if (command.includes('echo')) {
        return { stdout: '', stderr: '', code: 0 };
      }
      if (command.includes('tail')) {
        return { stdout: 'epoch 10 loss=0.5\n', stderr: '', code: 0 };
      }
      if (command.includes('test -f')) {
        return { stdout: 'MISSING\n', stderr: '', code: 0 };
      }
      return { stdout: '', stderr: '', code: 0 };
    }

    get connection() {
      return {
        forwardOut: (
          _srcIP: string,
          _srcPort: number,
          _dstIP: string,
          _dstPort: number,
          cb: (err: Error | undefined, stream: unknown) => void,
        ) => {
          // Return a mock stream
          cb(undefined, { on: () => {}, emit: () => {} });
        },
      };
    }

    dispose() {
      this._connected = false;
    }
  }

  return { NodeSSH: MockNodeSSH };
});

// Mock pino
vi.mock('pino', () => {
  const mockLogger = {
    info: vi.fn(),
    warn: vi.fn(),
    debug: vi.fn(),
    error: vi.fn(),
  };
  const pino = () => mockLogger;
  pino.transport = () => undefined;
  return { default: pino };
});

const TEST_HOST: WorkstationHost = {
  name: 'gpu19',
  hostname: 'gpu19.doc.ic.ac.uk',
  gpuType: '2080Ti',
  gpuCount: 1,
  vram: 11,
};

const TEST_HOST_2: WorkstationHost = {
  name: 'gpu31',
  hostname: 'gpu31.doc.ic.ac.uk',
  gpuType: '4080',
  gpuCount: 1,
  vram: 16,
};

const TEST_CONFIG: WorkstationSSHExecutorConfig = {
  type: 'workstation_ssh',
  jumpHost: 'shell2',
  hosts: [TEST_HOST, TEST_HOST_2],
  user: 'ys25',
  projectRoot: '/vol/bitbucket/ys25/jema',
  condaEnvBin: '/vol/bitbucket/ys25/conda-envs/jema/bin',
};

const TEST_SPEC: JobSpec = {
  name: 'test-train',
  command: 'python train.py --lr 1e-4',
  resources: { partition: 't4', time: '01:00:00', mem: '16G', gpus: 1 },
};

describe('WorkstationSSHExecutor', () => {
  // Dynamic import to ensure mocks are applied
  let WorkstationSSHExecutor: typeof import('../src/executors/workstation-ssh.js').WorkstationSSHExecutor;

  beforeEach(async () => {
    const mod = await import('../src/executors/workstation-ssh.js');
    WorkstationSSHExecutor = mod.WorkstationSSHExecutor;
  });

  it('has correct type identifier', () => {
    const executor = new WorkstationSSHExecutor(TEST_CONFIG);
    expect(executor.type).toBe('workstation_ssh');
  });

  it('initializes SSH connection to jump host', async () => {
    const executor = new WorkstationSSHExecutor(TEST_CONFIG);
    await executor.initialize();
    // Should not throw
    await executor.destroy();
  });

  it('submits a job and returns ws:<host>:<pid> format', async () => {
    const executor = new WorkstationSSHExecutor(TEST_CONFIG);
    await executor.initialize();

    const specWithHost: JobSpec = {
      ...TEST_SPEC,
      metadata: { targetHost: 'gpu19' },
    };

    const result = await executor.submit('test-alchemy-id-001', specWithHost);
    expect(result.externalJobId).toMatch(/^ws:gpu19:\d+$/);
    expect(result.logPath).toContain('ws_test-train_test-alchemy-id-001.log');

    await executor.destroy();
  });

  it('checks status of a running job', async () => {
    const executor = new WorkstationSSHExecutor(TEST_CONFIG);
    await executor.initialize();

    const result = await executor.status('ws:gpu19:12345');
    expect(result.status).toBe(JobStatus.RUNNING);
    expect(result.node).toBe('gpu19');

    await executor.destroy();
  });

  it('returns completed status for skipped jobs', async () => {
    const executor = new WorkstationSSHExecutor(TEST_CONFIG);
    await executor.initialize();

    const result = await executor.status('ws:gpu19:skipped');
    expect(result.status).toBe(JobStatus.COMPLETED);
    expect(result.exitCode).toBe(0);

    await executor.destroy();
  });

  it('cancels a job without throwing', async () => {
    const executor = new WorkstationSSHExecutor(TEST_CONFIG);
    await executor.initialize();

    await expect(executor.cancel('ws:gpu19:12345')).resolves.not.toThrow();
    await executor.destroy();
  });

  it('skips cancel for skipped jobs', async () => {
    const executor = new WorkstationSSHExecutor(TEST_CONFIG);
    await executor.initialize();

    await expect(executor.cancel('ws:gpu19:skipped')).resolves.not.toThrow();
    await executor.destroy();
  });

  it('fetches logs from host', async () => {
    const executor = new WorkstationSSHExecutor(TEST_CONFIG);
    await executor.initialize();

    const logs = await executor.fetchLogsFromHost('gpu19', '/some/log/path.log', 50);
    expect(typeof logs).toBe('string');

    await executor.destroy();
  });

  it('queries GPU on a host', async () => {
    const executor = new WorkstationSSHExecutor(TEST_CONFIG);
    await executor.initialize();

    const gpus = await executor.queryGPU('gpu19');
    expect(gpus.length).toBeGreaterThan(0);
    expect(gpus[0]).toHaveProperty('usedMB');
    expect(gpus[0]).toHaveProperty('totalMB');

    await executor.destroy();
  });

  it('lists available hosts with GPU info', async () => {
    const executor = new WorkstationSSHExecutor(TEST_CONFIG);
    await executor.initialize();

    const hosts = await executor.listAvailableHosts();
    expect(hosts.length).toBe(2);
    for (const h of hosts) {
      expect(h).toHaveProperty('host');
      expect(h).toHaveProperty('memoryUsedMB');
      expect(h).toHaveProperty('memoryTotalMB');
      expect(h).toHaveProperty('available');
    }

    await executor.destroy();
  });

  it('parses external job ID correctly', async () => {
    const executor = new WorkstationSSHExecutor(TEST_CONFIG);
    // Access private method via any
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const parsed = (executor as any).parseExternalJobId('ws:gpu19:12345');
    expect(parsed).toEqual({ hostname: 'gpu19', pid: '12345' });
  });

  it('throws on invalid external job ID format', async () => {
    const executor = new WorkstationSSHExecutor(TEST_CONFIG);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    expect(() => (executor as any).parseExternalJobId('invalid')).toThrow('Invalid workstation job ID format');
  });

  it('generates wrapper script with correct structure', () => {
    const executor = new WorkstationSSHExecutor(TEST_CONFIG);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const script = (executor as any).generateWrapperScript('job-123', TEST_SPEC, '/tmp/test.log');
    expect(script).toContain('#!/bin/bash');
    expect(script).toContain('ALCHEMY_JOB_ID');
    expect(script).toContain('python train.py --lr 1e-4');
    expect(script).toContain(TEST_CONFIG.condaEnvBin);
  });

  it('sets webhook URL', () => {
    const executor = new WorkstationSSHExecutor(TEST_CONFIG);
    executor.setWebhookPublicUrl('https://example.com');
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    expect((executor as any).webhookPublicUrl).toBe('https://example.com');
  });
});

describe('WorkstationSSHExecutorConfig schema', () => {
  it('validates correct config', async () => {
    const { z } = await import('zod');
    // Just verify the types compile — the Zod schema is tested implicitly via loadConfig
    const config: WorkstationSSHExecutorConfig = {
      type: 'workstation_ssh',
      jumpHost: 'shell2',
      hosts: [TEST_HOST],
      user: 'ys25',
      projectRoot: '/vol/bitbucket/ys25/jema',
      condaEnvBin: '/vol/bitbucket/ys25/conda-envs/jema/bin',
    };
    expect(config.type).toBe('workstation_ssh');
    expect(config.hosts).toHaveLength(1);
  });
});

describe('JobSpec checkpoint field', () => {
  it('accepts checkpoint in JobSpec', () => {
    const spec: JobSpec = {
      ...TEST_SPEC,
      checkpoint: {
        path: 'runs/${name}/final.pt',
        skipIfExists: true,
      },
    };
    expect(spec.checkpoint?.skipIfExists).toBe(true);
    expect(spec.checkpoint?.path).toContain('final.pt');
  });
});
