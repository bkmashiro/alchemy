// src/strategies/conditional.ts

import { BaseChainStrategy, NextSteps } from './base.js';
import {
  ChainSpec,
  ChainStepSpec,
  JobRecord,
  AnalysisResult,
  JobStatus,
  MetricsMap,
} from '../core/types.js';
import { ConditionParseError } from '../core/errors.js';
import { createLogger } from '../core/logger.js';

const logger = createLogger('ConditionalStrategy');

// ─── Tokenizer ────────────────────────────────────────────────

type TokenType = 'NUMBER' | 'STRING' | 'IDENT' | 'OP' | 'LOGIC';

interface Token {
  type: TokenType;
  value: string;
}

function tokenize(expr: string): Token[] {
  const tokens: Token[] = [];
  let i = 0;

  while (i < expr.length) {
    const ch = expr[i]!;

    // Skip whitespace
    if (/\s/.test(ch)) { i++; continue; }

    // Logic operators: &&, ||
    if (expr.slice(i, i + 2) === '&&' || expr.slice(i, i + 2) === '||') {
      tokens.push({ type: 'LOGIC', value: expr.slice(i, i + 2) });
      i += 2;
      continue;
    }

    // Comparison operators: >=, <=, ==, !=, >, <
    if (expr.slice(i, i + 2) === '>=' || expr.slice(i, i + 2) === '<=' ||
        expr.slice(i, i + 2) === '==' || expr.slice(i, i + 2) === '!=') {
      tokens.push({ type: 'OP', value: expr.slice(i, i + 2) });
      i += 2;
      continue;
    }
    if (ch === '>' || ch === '<') {
      tokens.push({ type: 'OP', value: ch });
      i++;
      continue;
    }

    // Number literal (including scientific notation)
    if (/[0-9]/.test(ch) || (ch === '-' && /[0-9]/.test(expr[i + 1] ?? ''))) {
      let num = '';
      if (ch === '-') { num += '-'; i++; }
      while (i < expr.length && /[0-9.eE+\-]/.test(expr[i]!)) {
        num += expr[i];
        i++;
      }
      tokens.push({ type: 'NUMBER', value: num });
      continue;
    }

    // String literal: 'value'
    if (ch === "'") {
      i++;
      let str = '';
      while (i < expr.length && expr[i] !== "'") {
        str += expr[i];
        i++;
      }
      i++; // consume closing quote
      tokens.push({ type: 'STRING', value: str });
      continue;
    }

    // Identifier: metrics.xxx, steps.sid.metrics.xxx, status
    if (/[a-zA-Z_]/.test(ch)) {
      let ident = '';
      while (i < expr.length && /[a-zA-Z0-9_.']/.test(expr[i]!)) {
        ident += expr[i];
        i++;
      }
      tokens.push({ type: 'IDENT', value: ident });
      continue;
    }

    // Unknown — skip
    i++;
  }

  return tokens;
}

// ─── Parser ───────────────────────────────────────────────────

interface EvalContext {
  metrics: MetricsMap;
  status: string;
  stepMetrics?: Map<string, MetricsMap>; // for steps.<sid>.metrics.<key>
}

function resolveValue(
  token: Token,
  ctx: EvalContext,
  expr: string,
): number | string {
  if (token.type === 'NUMBER') {
    return parseFloat(token.value);
  }
  if (token.type === 'STRING') {
    return token.value;
  }
  if (token.type === 'IDENT') {
    if (token.value === 'status') {
      return ctx.status;
    }
    if (token.value.startsWith('metrics.')) {
      const key = token.value.slice('metrics.'.length);
      return ctx.metrics[key] ?? NaN;
    }
    // steps.<stepId>.metrics.<key>
    if (token.value.startsWith('steps.') && ctx.stepMetrics) {
      const parts = token.value.split('.');
      // steps.<stepId>.metrics.<key>
      if (parts.length >= 4 && parts[2] === 'metrics') {
        const stepId = parts[1]!;
        const metricKey = parts.slice(3).join('.');
        const stepMets = ctx.stepMetrics.get(stepId);
        return stepMets?.[metricKey] ?? NaN;
      }
    }
    throw new ConditionParseError(expr, `Unknown identifier: ${token.value}`);
  }
  throw new ConditionParseError(expr, `Unexpected token type: ${token.type}`);
}

function compareValues(left: number | string, op: string, right: number | string): boolean {
  switch (op) {
    case '>':  return Number(left) > Number(right);
    case '<':  return Number(left) < Number(right);
    case '>=': return Number(left) >= Number(right);
    case '<=': return Number(left) <= Number(right);
    case '==': return left === right || Number(left) === Number(right);
    case '!=': return left !== right && Number(left) !== Number(right);
    default:   return false;
  }
}

function evaluateCondition(condition: string, ctx: EvalContext): boolean {
  const tokens = tokenize(condition);
  let pos = 0;

  function parseExpr(): boolean {
    let result = parseCompare();
    while (pos < tokens.length && tokens[pos]?.type === 'LOGIC') {
      const logic = tokens[pos]!.value;
      pos++;
      const right = parseCompare();
      if (logic === '&&') {
        result = result && right;
      } else {
        result = result || right;
      }
    }
    return result;
  }

  function parseCompare(): boolean {
    if (pos >= tokens.length) {
      throw new ConditionParseError(condition, 'Unexpected end of expression');
    }
    const leftToken = tokens[pos]!;
    pos++;
    const left = resolveValue(leftToken, ctx, condition);

    if (pos < tokens.length && tokens[pos]?.type === 'OP') {
      const op = tokens[pos]!.value;
      pos++;
      if (pos >= tokens.length) {
        throw new ConditionParseError(condition, 'Expected value after operator');
      }
      const rightToken = tokens[pos]!;
      pos++;
      const right = resolveValue(rightToken, ctx, condition);
      return compareValues(left, op, right);
    }

    // Truthy check on the value alone
    if (typeof left === 'number') return !isNaN(left) && left !== 0;
    return !!left;
  }

  try {
    return parseExpr();
  } catch (err) {
    if (err instanceof ConditionParseError) throw err;
    throw new ConditionParseError(condition, String(err));
  }
}

// ─── Strategy ─────────────────────────────────────────────────

/**
 * ConditionalStrategy — runs next job only if condition passes.
 *
 * Like SequentialStrategy but evaluates `condition` expressions
 * against the parent job's metrics before deciding to submit the next step.
 *
 * Supports conditions like:
 *   "metrics.val_acc > 0.85"
 *   "status == 'completed'"
 *   "metrics.val_acc > 0.85 && metrics.train_loss < 0.1"
 *   "steps.train.metrics.val_acc > 0.85"
 */
export class ConditionalStrategy extends BaseChainStrategy {
  readonly type = 'conditional';

  getNextSteps(
    chain: ChainSpec,
    jobsByStepId: Map<string, JobRecord>,
    analysisResults: Map<string, AnalysisResult>,
  ): NextSteps {
    const steps = chain.steps;
    const failFast = chain.failFast ?? true;

    if (steps.length === 0) {
      return { ready: [], isChainComplete: true, isChainFailed: false };
    }

    // Build step metrics map for cross-step condition evaluation
    const stepMetrics = new Map<string, MetricsMap>();
    for (const [stepId, result] of analysisResults) {
      stepMetrics.set(stepId, result.metrics);
    }

    // Find the next unsubmitted step in sequence
    let lastFinishedIndex = -1;
    let lastFinishedJob: JobRecord | null = null;
    let hasFailed = false;

    for (let i = 0; i < steps.length; i++) {
      const step = steps[i]!;
      const job = jobsByStepId.get(step.stepId);

      if (!job) {
        break; // This step not yet submitted
      }

      if (job.status === JobStatus.RUNNING || job.status === JobStatus.SUBMITTED || job.status === JobStatus.PENDING) {
        // Currently running — wait
        return { ready: [], isChainComplete: false, isChainFailed: false };
      }

      if (job.status === JobStatus.COMPLETED) {
        lastFinishedIndex = i;
        lastFinishedJob = job;
      } else {
        // Failed/cancelled/timeout
        hasFailed = true;
        lastFinishedIndex = i;
        lastFinishedJob = job;

        if (failFast) {
          return {
            ready: [],
            isChainComplete: false,
            isChainFailed: true,
            failureReason: `Step "${step.stepId}" failed with status ${job.status}`,
          };
        }
      }
    }

    const nextIndex = lastFinishedIndex + 1;

    if (nextIndex >= steps.length) {
      return {
        ready: [],
        isChainComplete: true,
        isChainFailed: hasFailed,
      };
    }

    const nextStep = steps[nextIndex]!;

    // Already submitted
    if (jobsByStepId.has(nextStep.stepId)) {
      return { ready: [], isChainComplete: false, isChainFailed: false };
    }

    // Check dependsOn (all deps must be completed)
    if (nextStep.dependsOn && nextStep.dependsOn.length > 0) {
      for (const depStepId of nextStep.dependsOn) {
        const depJob = jobsByStepId.get(depStepId);
        if (!depJob || depJob.status !== JobStatus.COMPLETED) {
          return { ready: [], isChainComplete: false, isChainFailed: false };
        }
      }
    }

    // Evaluate condition if present
    if (nextStep.condition && lastFinishedJob) {
      const parentMetrics = lastFinishedJob.metrics ?? {};
      const parentStatus = lastFinishedJob.status;
      const ctx: EvalContext = {
        metrics: parentMetrics,
        status: parentStatus,
        stepMetrics,
      };

      try {
        const conditionMet = evaluateCondition(nextStep.condition, ctx);
        if (!conditionMet) {
          logger.info(
            { stepId: nextStep.stepId, condition: nextStep.condition },
            'Condition not met — skipping step'
          );
          // Skip this step and check if that means the chain is done
          // For simplicity: if condition is not met, chain stops (no more steps to run)
          return {
            ready: [],
            isChainComplete: nextIndex === steps.length - 1,
            isChainFailed: false,
          };
        }
      } catch (err) {
        logger.error({ stepId: nextStep.stepId, condition: nextStep.condition, err }, 'Condition evaluation failed');
        return {
          ready: [],
          isChainComplete: false,
          isChainFailed: true,
          failureReason: `Condition evaluation failed for step "${nextStep.stepId}": ${String(err)}`,
        };
      }
    }

    return {
      ready: [nextStep],
      isChainComplete: false,
      isChainFailed: false,
    };
  }
}

// Export the evaluator for use by ChainPlanner (Agent A)
export { evaluateCondition, tokenize };
export type { EvalContext, Token };
