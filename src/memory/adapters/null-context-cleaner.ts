import type { AgentContextCleaner, AgentContextCleanInput } from '../ports/agent-context-cleaner';
import type { AgentContextSnapshot } from '../schemas';

export class NullContextCleaner implements AgentContextCleaner {
  async clean(_input: AgentContextCleanInput): Promise<AgentContextSnapshot | null> {
    return null;
  }
}
