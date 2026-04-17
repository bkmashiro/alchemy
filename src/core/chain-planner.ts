// src/core/chain-planner.ts

import {
  ChainSpec,
  ChainStepSpec,
  JobRecord,
  AnalysisResult,
  MetricsMap,
  JobStatus,
} from './types.js';
import { CyclicDependencyError, ConditionParseError } from './errors.js';

interface Token {
  type: 'NUMBER' | 'STRING' | 'IDENT' | 'OP' | 'LOGIC';
  value: string;
}

export class ChainPlanner {
  /**
   * Validate a chain spec before execution.
   * @throws CyclicDependencyError if cycles detected
   */
  validateChain(chain: ChainSpec): void {
    const stepIds = new Set(chain.steps.map((s) => s.stepId));

    // Check for duplicate step IDs
    if (stepIds.size !== chain.steps.length) {
      throw new Error(`Chain "${chain.name}" has duplicate step IDs`);
    }

    // Check all dependsOn references point to valid step IDs
    for (const step of chain.steps) {
      for (const dep of step.dependsOn ?? []) {
        if (!stepIds.has(dep)) {
          throw new Error(
            `Step "${step.stepId}" depends on unknown step "${dep}" in chain "${chain.name}"`,
          );
        }
      }
    }

    // Check for cycles
    this.getTopologicalOrder(chain);
  }

  /**
   * Get the topological order of steps (for display/planning).
   * Returns step IDs in valid execution order.
   * @throws CyclicDependencyError if cycles exist
   */
  getTopologicalOrder(chain: ChainSpec): string[] {
    // Kahn's algorithm
    const inDegree = new Map<string, number>();
    const adjacency = new Map<string, string[]>(); // stepId → dependents

    for (const step of chain.steps) {
      inDegree.set(step.stepId, inDegree.get(step.stepId) ?? 0);
      if (!adjacency.has(step.stepId)) adjacency.set(step.stepId, []);

      for (const dep of step.dependsOn ?? []) {
        inDegree.set(step.stepId, (inDegree.get(step.stepId) ?? 0) + 1);
        if (!adjacency.has(dep)) adjacency.set(dep, []);
        adjacency.get(dep)!.push(step.stepId);
      }
    }

    // Start with zero in-degree nodes
    const queue: string[] = [];
    for (const [stepId, degree] of inDegree) {
      if (degree === 0) queue.push(stepId);
    }

    const result: string[] = [];
    while (queue.length > 0) {
      const node = queue.shift()!;
      result.push(node);
      for (const dependent of adjacency.get(node) ?? []) {
        const newDegree = (inDegree.get(dependent) ?? 0) - 1;
        inDegree.set(dependent, newDegree);
        if (newDegree === 0) queue.push(dependent);
      }
    }

    if (result.length !== chain.steps.length) {
      throw new CyclicDependencyError(chain.name);
    }

    return result;
  }

  /**
   * Determine which steps are ready to execute given current state.
   */
  getReadySteps(
    chain: ChainSpec,
    jobsByStepId: Map<string, JobRecord>,
    analysisResults: Map<string, AnalysisResult>,
  ): {
    ready: ChainStepSpec[];
    blocked: ChainStepSpec[];
    skipped: ChainStepSpec[];
    completed: ChainStepSpec[];
    failed: ChainStepSpec[];
  } {
    const ready: ChainStepSpec[] = [];
    const blocked: ChainStepSpec[] = [];
    const skipped: ChainStepSpec[] = [];
    const completed: ChainStepSpec[] = [];
    const failed: ChainStepSpec[] = [];

    for (const step of chain.steps) {
      const job = jobsByStepId.get(step.stepId);

      // Already submitted
      if (job) {
        if (job.status === JobStatus.COMPLETED) {
          completed.push(step);
        } else if (
          job.status === JobStatus.FAILED ||
          job.status === JobStatus.CANCELLED ||
          job.status === JobStatus.TIMEOUT
        ) {
          failed.push(step);
        } else {
          // Running or pending — blocked (already submitted)
          blocked.push(step);
        }
        continue;
      }

      // Not yet submitted — check dependencies
      const deps = step.dependsOn ?? [];

      // Check if any dependency failed
      const anyDepFailed = deps.some((dep) => {
        const depJob = jobsByStepId.get(dep);
        return (
          depJob &&
          (depJob.status === JobStatus.FAILED ||
            depJob.status === JobStatus.CANCELLED ||
            depJob.status === JobStatus.TIMEOUT)
        );
      });

      if (anyDepFailed) {
        skipped.push(step);
        continue;
      }

      // Check if all dependencies completed
      const allDepsCompleted = deps.every((dep) => {
        const depJob = jobsByStepId.get(dep);
        return depJob && depJob.status === JobStatus.COMPLETED;
      });

      if (!allDepsCompleted) {
        blocked.push(step);
        continue;
      }

      // All deps complete — check condition
      if (step.condition) {
        // Use metrics from last dependency (or first available)
        let metrics: MetricsMap = {};
        let status = 'completed';

        if (deps.length > 0) {
          const lastDep = deps[deps.length - 1]!;
          const lastDepJob = jobsByStepId.get(lastDep);
          const lastDepAnalysis = analysisResults.get(lastDep);
          metrics = lastDepAnalysis?.metrics ?? lastDepJob?.metrics ?? {};
          status = lastDepJob?.status ?? 'completed';
        }

        try {
          const conditionMet = this.evaluateCondition(
            step.condition,
            metrics,
            status,
            analysisResults,
          );
          if (!conditionMet) {
            skipped.push(step);
            continue;
          }
        } catch {
          skipped.push(step);
          continue;
        }
      }

      ready.push(step);
    }

    return { ready, blocked, skipped, completed, failed };
  }

  /**
   * Evaluate a condition expression against a job's metrics and status.
   */
  evaluateCondition(
    condition: string,
    metrics: MetricsMap,
    status: string,
    analysisResults?: Map<string, AnalysisResult>,
  ): boolean {
    try {
      const tokens = this.tokenize(condition);
      let pos = 0;

      const parseValue = (): number | string => {
        const tok = tokens[pos];
        if (!tok) throw new ConditionParseError(condition, 'Unexpected end of expression');

        if (tok.type === 'NUMBER') {
          pos++;
          return parseFloat(tok.value);
        }
        if (tok.type === 'STRING') {
          pos++;
          return tok.value.slice(1, -1); // remove quotes
        }
        if (tok.type === 'IDENT') {
          pos++;
          // steps.<stepId>.metrics.<key>
          if (tok.value.startsWith('steps.')) {
            const parts = tok.value.split('.');
            // steps.stepId.metrics.key → parts[0]=steps, parts[1]=stepId, parts[2]=metrics, parts[3]=key
            if (parts.length >= 4 && parts[2] === 'metrics' && analysisResults) {
              const stepId = parts[1]!;
              const key = parts.slice(3).join('.');
              const result = analysisResults.get(stepId);
              return result?.metrics[key] ?? NaN;
            }
            return NaN;
          }
          // metrics.<key>
          if (tok.value.startsWith('metrics.')) {
            const key = tok.value.slice('metrics.'.length);
            return metrics[key] ?? NaN;
          }
          // status
          if (tok.value === 'status') {
            return status;
          }
          throw new ConditionParseError(condition, `Unknown identifier: ${tok.value}`);
        }
        throw new ConditionParseError(condition, `Unexpected token: ${tok.value}`);
      };

      const parseCompare = (): boolean => {
        const left = parseValue();
        const opTok = tokens[pos];
        if (!opTok || opTok.type !== 'OP') {
          // Just a value — truthy check
          return typeof left === 'number' ? !isNaN(left) && left !== 0 : Boolean(left);
        }
        pos++;
        const right = parseValue();
        const op = opTok.value;

        if (typeof left === 'number' && typeof right === 'number') {
          switch (op) {
            case '>': return left > right;
            case '<': return left < right;
            case '>=': return left >= right;
            case '<=': return left <= right;
            case '==': return left === right;
            case '!=': return left !== right;
          }
        }
        // String comparison
        switch (op) {
          case '==': return String(left) === String(right);
          case '!=': return String(left) !== String(right);
        }
        return false;
      };

      const parseExpr = (): boolean => {
        let result = parseCompare();
        while (pos < tokens.length && tokens[pos]?.type === 'LOGIC') {
          const logic = tokens[pos]!.value;
          pos++;
          const right = parseCompare();
          if (logic === '&&') result = result && right;
          else if (logic === '||') result = result || right;
        }
        return result;
      };

      return parseExpr();
    } catch (err) {
      if (err instanceof ConditionParseError) throw err;
      throw new ConditionParseError(condition, String(err));
    }
  }

  /**
   * Tokenizer: splits condition string into tokens.
   */
  private tokenize(expr: string): Token[] {
    const tokens: Token[] = [];
    let i = 0;

    while (i < expr.length) {
      const ch = expr[i]!;

      // Skip whitespace
      if (/\s/.test(ch)) { i++; continue; }

      // Logical operators
      if (expr.slice(i, i + 2) === '&&') {
        tokens.push({ type: 'LOGIC', value: '&&' });
        i += 2;
        continue;
      }
      if (expr.slice(i, i + 2) === '||') {
        tokens.push({ type: 'LOGIC', value: '||' });
        i += 2;
        continue;
      }

      // Comparison operators (two-char first)
      if (expr.slice(i, i + 2) === '>=') { tokens.push({ type: 'OP', value: '>=' }); i += 2; continue; }
      if (expr.slice(i, i + 2) === '<=') { tokens.push({ type: 'OP', value: '<=' }); i += 2; continue; }
      if (expr.slice(i, i + 2) === '==') { tokens.push({ type: 'OP', value: '==' }); i += 2; continue; }
      if (expr.slice(i, i + 2) === '!=') { tokens.push({ type: 'OP', value: '!=' }); i += 2; continue; }
      if (ch === '>') { tokens.push({ type: 'OP', value: '>' }); i++; continue; }
      if (ch === '<') { tokens.push({ type: 'OP', value: '<' }); i++; continue; }

      // String literal
      if (ch === "'" || ch === '"') {
        const quote = ch;
        let j = i + 1;
        while (j < expr.length && expr[j] !== quote) j++;
        tokens.push({ type: 'STRING', value: expr.slice(i, j + 1) });
        i = j + 1;
        continue;
      }

      // Number literal
      if (/[0-9]/.test(ch) || (ch === '-' && /[0-9]/.test(expr[i + 1] ?? ''))) {
        let j = i + 1;
        while (j < expr.length && /[0-9.e+\-]/.test(expr[j]!)) j++;
        tokens.push({ type: 'NUMBER', value: expr.slice(i, j) });
        i = j;
        continue;
      }

      // Identifier (metrics.xxx, status, steps.xxx.metrics.yyy)
      if (/[a-zA-Z_]/.test(ch)) {
        let j = i;
        while (j < expr.length && /[a-zA-Z0-9_.]/i.test(expr[j]!)) j++;
        tokens.push({ type: 'IDENT', value: expr.slice(i, j) });
        i = j;
        continue;
      }

      // Unknown character — skip
      i++;
    }

    return tokens;
  }
}
