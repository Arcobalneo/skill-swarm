export interface SkillInfo {
  name: string;
  description: string;
  version: string;
  path: string;
  /** Full parsed YAML frontmatter metadata */
  metadata: Record<string, unknown>;
}

export interface SkillSet {
  /** The primary skill that drives execution */
  primary: string;
  /** All skills in this subagent's collection (includes primary) */
  skills: string[];
}

export interface TaskConfig {
  taskId: string;
  workspaceDir: string;
  query: string;
  skillName: string;
  skillSet?: SkillSet;
  /** Subagent configuration loaded from JSON */
  subagent?: SubagentConfig;
  productConfig?: Record<string, unknown>;
}

export interface SubagentConfig {
  id: string;
  name: string;
  description: string;
  skills: string[];
  systemPromptModifier: string;
  workflowStages: WorkflowStage[];
  enforcementRules: string[];
}

export interface WorkflowStage {
  id: string;
  name: string;
  required: boolean;
  condition?: string;
}

export interface ExecutionState {
  status: 'queued' | 'running' | 'completed' | 'failed' | 'interrupted';
  query: string;
  skillName: string;
  startTime: number;
  endTime?: number;
  artifacts: string[];
  message?: string;
  error?: string;
}
