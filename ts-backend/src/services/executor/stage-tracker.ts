import type { SubagentConfig } from '@/types/index.js';

export class StageTracker {
  private toolCallCount = 0;
  private artifactWritten = false;
  private stages: Map<string, boolean> = new Map();

  constructor(private subagent?: SubagentConfig) {
    if (subagent) {
      for (const stage of subagent.workflowStages) {
        this.stages.set(stage.id, false);
      }
    }
  }

  recordToolCall(toolName: string) {
    this.toolCallCount++;
    if (toolName === 'bash') {
      this.stages.set('stage0', true);
    }
    if (toolName === 'read_file') {
      this.stages.set('stage0', true);
    }
    if (toolName === 'write_file') {
      this.stages.set('stage3', true);
    }
  }

  recordArtifactWritten() {
    this.artifactWritten = true;
  }

  get isArtifactWritten(): boolean {
    return this.artifactWritten;
  }

  getSummary() {
    return {
      toolCalls: this.toolCallCount,
      artifactWritten: this.artifactWritten,
      stagesCompleted: Array.from(this.stages.entries())
        .filter(([, done]) => done)
        .map(([id]) => id),
    };
  }
}
