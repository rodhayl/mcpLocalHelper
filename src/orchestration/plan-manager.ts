import * as fs from 'fs';
import * as path from 'path';
import { OrchestrationPlan, OrchestrationStep, OrchestrationStatus } from '../types/index.js';

interface PlanManagerOptions {
  plansDir?: string;
}

export class PlanManager {
  private plansDir: string;

  constructor(options: PlanManagerOptions = {}) {
    const envPlansDir = process.env.MCP_ORCHESTRATION_PLANS_DIR?.trim();
    this.plansDir =
      options.plansDir ||
      (envPlansDir ? path.resolve(envPlansDir) : path.join(process.cwd(), '.orchestration-plans'));
    this.ensurePlansDir();
  }

  private ensurePlansDir(): void {
    if (!fs.existsSync(this.plansDir)) {
      fs.mkdirSync(this.plansDir, { recursive: true });
    }
  }

  generatePlanId(): string {
    const timestamp = new Date()
      .toISOString()
      .replace(/[-:T]/g, '')
      .replace(/\..+/, '')
      .slice(0, 14);
    const random = Math.random().toString(36).substring(2, 8);
    return `plan_${timestamp}_${random}`;
  }

  createPlan(task: string, threshold: number = 7, maxIterations: number = 3): OrchestrationPlan {
    const planId = this.generatePlanId();
    const planDir = path.join(this.plansDir, planId);

    fs.mkdirSync(path.join(planDir, 'steps'), { recursive: true });
    fs.mkdirSync(path.join(planDir, 'results'), { recursive: true });

    const plan: OrchestrationPlan = {
      id: planId,
      originalTask: task,
      description: `Orchestration: ${task.substring(0, 100)}${task.length > 100 ? '...' : ''}`,
      steps: [],
      currentStep: 0,
      status: 'planning',
      iterations: 0,
      createdAt: new Date(),
      updatedAt: new Date(),
      threshold,
      maxIterations,
    };

    this.savePlan(plan);

    return plan;
  }

  getPlan(planId: string): OrchestrationPlan | null {
    const planPath = path.join(this.plansDir, planId, 'plan.json');

    if (!fs.existsSync(planPath)) {
      return null;
    }

    const content = fs.readFileSync(planPath, 'utf8');
    return this.parsePlanJson(content);
  }

  updatePlan(planId: string, updates: Partial<OrchestrationPlan>): void {
    const plan = this.getPlan(planId);
    if (!plan) {
      throw new Error(`Plan not found: ${planId}`);
    }

    const updatedPlan: OrchestrationPlan = {
      ...plan,
      ...updates,
      updatedAt: new Date(),
    };

    this.savePlan(updatedPlan);
  }

  addStep(planId: string, step: Omit<OrchestrationStep, 'id'>): OrchestrationStep {
    const plan = this.getPlan(planId);
    if (!plan) {
      throw new Error(`Plan not found: ${planId}`);
    }

    const newStep: OrchestrationStep = {
      ...step,
      id: `step_${String(plan.steps.length + 1).padStart(3, '0')}`,
    };

    plan.steps.push(newStep);
    plan.status = 'executing';
    plan.updatedAt = new Date();

    this.savePlan(plan);

    const stepPath = path.join(this.plansDir, planId, 'steps', `${newStep.id}.json`);
    this.atomicWriteJson(stepPath, newStep);

    return newStep;
  }

  updateStep(planId: string, stepId: string, updates: Partial<OrchestrationStep>): void {
    const plan = this.getPlan(planId);
    if (!plan) {
      throw new Error(`Plan not found: ${planId}`);
    }

    const stepIndex = plan.steps.findIndex((s) => s.id === stepId);
    if (stepIndex === -1) {
      throw new Error(`Step not found: ${stepId}`);
    }

    plan.steps[stepIndex] = {
      ...plan.steps[stepIndex],
      ...updates,
    };

    plan.updatedAt = new Date();
    this.savePlan(plan);

    const stepPath = path.join(this.plansDir, planId, 'steps', `${stepId}.json`);
    this.atomicWriteJson(stepPath, plan.steps[stepIndex]);
  }

  saveResult(
    planId: string,
    stepId: string,
    result: {
      success: boolean;
      content: string;
      files_modified: string[];
      tools_used: string[];
      error?: string;
    }
  ): void {
    const resultPath = path.join(this.plansDir, planId, 'results', `${stepId}_${Date.now()}.json`);
    this.atomicWriteJson(resultPath, result);
  }

  listPlans(): OrchestrationPlan[] {
    if (!fs.existsSync(this.plansDir)) {
      return [];
    }

    const entries = fs.readdirSync(this.plansDir, { withFileTypes: true });
    const plans: OrchestrationPlan[] = [];

    for (const entry of entries) {
      if (entry.isDirectory()) {
        const plan = this.getPlan(entry.name);
        if (plan) {
          plans.push(plan);
        }
      }
    }

    return plans.sort((a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime());
  }

  deletePlan(planId: string): boolean {
    const planDir = path.join(this.plansDir, planId);

    if (!fs.existsSync(planDir)) {
      return false;
    }

    this.deleteDirectory(planDir);
    return true;
  }

  getStep(planId: string, stepId: string): OrchestrationStep | null {
    const plan = this.getPlan(planId);
    if (!plan) {
      return null;
    }

    return plan.steps.find((s) => s.id === stepId) || null;
  }

  private savePlan(plan: OrchestrationPlan): void {
    const planPath = path.join(this.plansDir, plan.id, 'plan.json');
    this.atomicWriteJson(planPath, plan);
  }

  /**
   * Atomic write: write to temp file then rename to prevent truncated files on crash
   */
  private atomicWriteJson(targetPath: string, data: unknown): void {
    const tempPath = `${targetPath}.tmp`;
    const content = JSON.stringify(data, null, 2);
    fs.writeFileSync(tempPath, content, 'utf8');
    fs.renameSync(tempPath, targetPath);
  }

  private deleteDirectory(dirPath: string): void {
    if (fs.existsSync(dirPath)) {
      fs.readdirSync(dirPath).forEach((file) => {
        const curPath = path.join(dirPath, file);
        if (fs.lstatSync(curPath).isDirectory()) {
          this.deleteDirectory(curPath);
        } else {
          fs.unlinkSync(curPath);
        }
      });
      fs.rmdirSync(dirPath);
    }
  }

  private parsePlanJson(content: string): OrchestrationPlan | null {
    try {
      const parsed = JSON.parse(content, this.dateReviver);

      if (!parsed || !Array.isArray(parsed.steps)) {
        return null;
      }

      return {
        ...parsed,
        status: parsed.status as OrchestrationStatus,
        steps: parsed.steps.map((s: OrchestrationStep) => ({
          ...s,
          status: s.status as OrchestrationStep['status'],
        })),
      };
    } catch {
      return null;
    }
  }

  private dateReviver(_key: string, value: unknown): unknown {
    if (typeof value === 'string') {
      const dateRegex = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}.\d{3}Z$/;
      if (dateRegex.test(value)) {
        return new Date(value);
      }
    }
    return value;
  }
}
