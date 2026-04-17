// src/core/errors.ts

export class AlchemyError extends Error {
  public readonly code: string;
  constructor(message: string, code: string) {
    super(message);
    this.name = 'AlchemyError';
    this.code = code;
  }
}

export class SSHConnectionError extends AlchemyError {
  constructor(message: string, public readonly host: string) {
    super(message, 'SSH_CONNECTION_ERROR');
    this.name = 'SSHConnectionError';
  }
}

export class SubmissionError extends AlchemyError {
  constructor(message: string, public readonly stderr: string) {
    super(message, 'SUBMISSION_ERROR');
    this.name = 'SubmissionError';
  }
}

export class JobNotFoundError extends AlchemyError {
  constructor(jobId: string) {
    super(`Job not found: ${jobId}`, 'JOB_NOT_FOUND');
    this.name = 'JobNotFoundError';
  }
}

export class ChainNotFoundError extends AlchemyError {
  constructor(chainId: string) {
    super(`Chain not found: ${chainId}`, 'CHAIN_NOT_FOUND');
    this.name = 'ChainNotFoundError';
  }
}

export class ConfigError extends AlchemyError {
  constructor(message: string) {
    super(message, 'CONFIG_ERROR');
    this.name = 'ConfigError';
  }
}

export class ConditionParseError extends AlchemyError {
  constructor(expression: string, reason: string) {
    super(`Invalid condition "${expression}": ${reason}`, 'CONDITION_PARSE_ERROR');
    this.name = 'ConditionParseError';
  }
}

export class WebhookAuthError extends AlchemyError {
  constructor() {
    super('Webhook signature verification failed', 'WEBHOOK_AUTH_ERROR');
    this.name = 'WebhookAuthError';
  }
}

export class CyclicDependencyError extends AlchemyError {
  constructor(chainName: string) {
    super(`Cyclic dependency detected in chain "${chainName}"`, 'CYCLIC_DEPENDENCY');
    this.name = 'CyclicDependencyError';
  }
}
