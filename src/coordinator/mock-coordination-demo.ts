import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  SCHEMA_VERSION,
  createId,
  nowTimestamp,
  type ArtifactRef,
  type ArtifactId,
  type CouncilDecisionId,
  type GateResultId,
  type Message,
  type SchemaVersion,
  type TaskId,
  type Timestamp,
} from '../core';
import { InMemoryCoordinatorFacade, type CoordinatorTask } from './coordinator-facade';
import type { MessageDelivery } from './mailbox-store';

export interface MockCoordinationDemoInput {
  requirement: string;
  requesting_agent_id: string;
}

export interface MockRoleProfileRef {
  role_profile_id: string;
  role_id: string;
  persona_ref?: string;
  skill_refs?: string[];
  experience_refs?: string[];
  capability_tags?: string[];
  schema_version: SchemaVersion;
}

export interface MockAgentRecord {
  agent_id: string;
  role_id: string;
  driver_id: string;
  session_id: string;
  status: 'active' | 'idle' | 'dead' | 'draining';
  current_task_id?: TaskId;
  capabilities?: Record<string, unknown>;
  last_heartbeat?: Timestamp;
  schema_version: SchemaVersion;
}

export interface MockContextPackRef {
  context_pack_id: string;
  task_id: TaskId;
  uri: string;
  artifact_id?: ArtifactId;
  summary?: string;
  created_at: Timestamp;
  schema_version: SchemaVersion;
}

export interface MockDriverRunResultForCoordination {
  session_id: string;
  attempt_id?: string;
  status: 'success' | 'failed' | 'cancelled' | 'timeout';
  artifacts: ArtifactRef[];
  transcript_ref?: ArtifactRef;
  diagnostics?: Record<string, unknown>;
  error?: {
    code: string;
    message: string;
    retryable?: boolean;
  };
  schema_version: SchemaVersion;
}

export interface MockGateResult {
  gate_result_id: GateResultId;
  gate_id?: string;
  gate_point: string;
  subject_id: string;
  subject_type?: 'task' | 'artifact' | 'proposal' | 'merge_attempt' | 'council' | string;
  causal_event_id?: string;
  attempt_id?: string;
  subject_version?: number;
  decision: 'allow' | 'deny' | 'ask' | 'defer';
  reason: string;
  required_actions: string[];
  audit_ref?: string;
  target_state?: string;
  created_at: Timestamp;
  schema_version: SchemaVersion;
}

export interface MockProposal {
  proposal_id: string;
  task_id: TaskId;
  agent_id?: string;
  artifact_refs: ArtifactId[];
  summary: string;
  affected_paths: string[];
  assumptions: string[];
  known_risks: string[];
  completion_evidence: string[];
  schema_version: SchemaVersion;
}

export interface MockCouncilRunRequest {
  task_id: TaskId;
  trigger: 'user_choice' | 'agent_escalate' | 'gate_defer' | 'manual';
  decision_mode: 'advisory' | 'evidence_only' | 'delegated_decision' | 'human_review_required';
  question: string;
  context_pack_ref?: MockContextPackRef;
  participant_profile_refs?: MockRoleProfileRef[];
  proposals: MockProposal[];
  human_authorization_ref?: string;
  auto_advance_allowed?: boolean;
  max_rounds?: number;
  deadline_at?: Timestamp;
  schema_version: SchemaVersion;
}

export interface MockCouncilDecision {
  decision_id: CouncilDecisionId;
  task_id: TaskId;
  decision_mode: MockCouncilRunRequest['decision_mode'];
  selected_proposal_id?: string;
  verdict: 'select' | 'needs_human' | 'request_revision' | 'reject';
  reason: string;
  evidence_refs: ArtifactId[];
  can_create_merge_authorization: boolean;
  created_at: Timestamp;
  schema_version: SchemaVersion;
}

export interface MockMergeAuthorization {
  merge_authorization_id: string;
  task_id: TaskId;
  selected_artifact_refs: ArtifactId[];
  gate_result_refs: GateResultId[];
  council_decision_ref?: CouncilDecisionId;
  status: 'authorized' | 'blocked' | 'revoked';
  reason?: string;
  created_at: Timestamp;
  schema_version: SchemaVersion;
}

export interface MockCoordinationDemoResult {
  task: CoordinatorTask;
  role_profile: MockRoleProfileRef;
  agent: MockAgentRecord;
  context_pack: MockContextPackRef;
  driver_result: MockDriverRunResultForCoordination;
  artifact_ref: ArtifactRef;
  gate_result: MockGateResult;
  proposal: MockProposal;
  council_request: MockCouncilRunRequest;
  council_decision: MockCouncilDecision;
  merge_authorization: MockMergeAuthorization;
  message: Message;
  message_delivery: MessageDelivery;
  timeline: string[];
}

export function runMockCoordinationDemo(
  input: MockCoordinationDemoInput,
): MockCoordinationDemoResult {
  const coordinator = new InMemoryCoordinatorFacade();
  const timeline: string[] = [];

  const roleProfile = mockRoleProfile();
  const task = coordinator.createTask({
    spec: input.requirement,
    role_id: roleProfile.role_id,
    role_profile_ref: roleProfile.role_profile_id,
    completion_criteria: ['Mock council selects a proposal and C creates merge authorization.'],
  });
  timeline.push('task.created');

  const agent = mockAgentMarketClaim(task.task_id, roleProfile);
  coordinator.claimTask(task.task_id, agent.agent_id);
  timeline.push('task.claimed');

  coordinator.updateTaskStatus(task.task_id, 'running');
  timeline.push('task.started');

  const sent = coordinator.sendMessage({
    thread_id: createId('thread'),
    from_agent_id: input.requesting_agent_id,
    to: [{ agent_id: agent.agent_id }],
    type: 'handoff',
    payload: {
      task_id: task.task_id,
      role_profile_ref: roleProfile.role_profile_id,
      instruction: 'Run the mocked driver path and prepare proposal evidence.',
    },
    requires_ack: true,
    deadline_seconds: 60,
  });
  timeline.push('agent.message_send');

  const messageDelivery = coordinator.ackMessage(sent.message.message_id, {
    agent_id: agent.agent_id,
  });
  timeline.push('agent.message_recv');

  const contextPack = mockContextPack(task.task_id, roleProfile);
  const driverResult = mockDriverRun(agent, task.task_id);
  timeline.push('driver.completed');

  const artifactRef = firstDriverArtifact(driverResult);
  timeline.push('artifact.registered');

  coordinator.updateTaskStatus(task.task_id, 'pending_council');
  const gateResult = mockGateDeferToCouncil(artifactRef);
  timeline.push('gate.deferred');

  const proposal = mockProposal(task.task_id, agent.agent_id, artifactRef);
  const councilRequest = mockCouncilRunRequest(task.task_id, contextPack, roleProfile, proposal);
  const councilDecision = mockCouncilDecision(task.task_id, proposal);
  timeline.push('council.decision');

  const mergeAuthorization = mockMergeAuthorization(
    task.task_id,
    artifactRef,
    gateResult,
    councilDecision,
  );
  timeline.push('merge_authorized');

  const reviewingTask = coordinator.updateTaskStatus(task.task_id, 'reviewing');
  const completedTask = coordinator.updateTaskStatus(reviewingTask.task_id, 'completed');
  timeline.push('task.completed');

  return {
    task: completedTask,
    role_profile: roleProfile,
    agent,
    context_pack: contextPack,
    driver_result: driverResult,
    artifact_ref: artifactRef,
    gate_result: gateResult,
    proposal,
    council_request: councilRequest,
    council_decision: councilDecision,
    merge_authorization: mergeAuthorization,
    message: sent.message,
    message_delivery: messageDelivery,
    timeline,
  };
}

export function formatMockCoordinationDemo(result: MockCoordinationDemoResult): string {
  const timeline = result.timeline.map((event, index) => `${index + 1}. ${event}`).join('\n');

  return [
    'Mock Coordinator Demo',
    `Final task status: ${result.task.status}`,
    '',
    `Task: ${result.task.task_id}`,
    `Owner agent: ${result.agent.agent_id}`,
    `Role profile: ${result.role_profile.role_profile_id}`,
    `Context pack: ${result.context_pack.context_pack_id}`,
    `Message: ${result.message.message_id} (${result.message_delivery.status})`,
    `Artifact: ${result.artifact_ref.artifact_id}`,
    `Gate: ${result.gate_result.decision} -> ${result.gate_result.target_state}`,
    `Council: ${result.council_decision.verdict}`,
    `Merge authorization: ${result.merge_authorization.status}`,
    '',
    'Timeline:',
    timeline,
  ].join('\n');
}

function mockRoleProfile(): MockRoleProfileRef {
  return {
    role_profile_id: createId('role_profile'),
    role_id: 'role_reviewer',
    persona_ref: 'persona://reviewer/default',
    skill_refs: ['skill://typescript', 'skill://coordination-review'],
    experience_refs: ['experience://mock-coordinator-demo'],
    capability_tags: ['typescript', 'coordination', 'review'],
    schema_version: SCHEMA_VERSION,
  };
}

function mockAgentMarketClaim(taskId: TaskId, roleProfile: MockRoleProfileRef): MockAgentRecord {
  return {
    agent_id: createId('agent'),
    role_id: roleProfile.role_id,
    driver_id: 'mock-driver',
    session_id: createId('session'),
    status: 'active',
    current_task_id: taskId,
    capabilities: {
      role_profile_ref: roleProfile.role_profile_id,
      capability_tags: roleProfile.capability_tags,
    },
    last_heartbeat: nowTimestamp(),
    schema_version: SCHEMA_VERSION,
  };
}

function firstDriverArtifact(result: MockDriverRunResultForCoordination): ArtifactRef {
  const artifactRef = result.artifacts[0];
  if (!artifactRef) {
    throw new Error('Mock driver did not produce an artifact');
  }

  return artifactRef;
}

function mockContextPack(taskId: TaskId, roleProfile: MockRoleProfileRef): MockContextPackRef {
  return {
    context_pack_id: createId('context_pack'),
    task_id: taskId,
    uri: `contextpack://${taskId}/${roleProfile.role_profile_id}/mock`,
    summary: 'Context assembled from task, B role profile, and current artifacts.',
    created_at: nowTimestamp(),
    schema_version: SCHEMA_VERSION,
  };
}

function mockDriverRun(agent: MockAgentRecord, taskId: TaskId): MockDriverRunResultForCoordination {
  const artifactRef: ArtifactRef = {
    artifact_id: createId('artifact'),
    type: 'patch',
    uri: `artifact://patch/${taskId}/mock_patch`,
    producer_id: agent.agent_id,
    task_id: taskId,
    metadata: {
      driver_id: agent.driver_id,
      session_id: agent.session_id,
    },
    created_at: nowTimestamp(),
    schema_version: SCHEMA_VERSION,
  };

  return {
    session_id: agent.session_id,
    attempt_id: createId('attempt'),
    status: 'success',
    artifacts: [artifactRef],
    diagnostics: {
      summary: 'Mock driver produced a patch artifact.',
    },
    schema_version: SCHEMA_VERSION,
  };
}

function mockGateDeferToCouncil(artifactRef: ArtifactRef): MockGateResult {
  return {
    gate_result_id: createId('gate_result'),
    gate_id: 'mock_gate',
    gate_point: 'task.completed',
    subject_id: artifactRef.artifact_id,
    subject_type: 'artifact',
    decision: 'defer',
    reason: 'Mock gate defers to council for evidence-backed selection.',
    required_actions: ['run_mock_council'],
    target_state: 'pending_council',
    created_at: nowTimestamp(),
    schema_version: SCHEMA_VERSION,
  };
}

function mockProposal(taskId: TaskId, agentId: string, artifactRef: ArtifactRef): MockProposal {
  return {
    proposal_id: createId('proposal'),
    task_id: taskId,
    agent_id: agentId,
    artifact_refs: [artifactRef.artifact_id],
    summary: 'Use the mock patch artifact as the selected proposal.',
    affected_paths: ['src/coordinator/mock-coordination-demo.ts'],
    assumptions: ['External modules are mocked but contract-shaped.'],
    known_risks: ['No real driver, gate, or council execution happens in this demo.'],
    completion_evidence: ['driver_result.status=success', 'gate_result.decision=defer'],
    schema_version: SCHEMA_VERSION,
  };
}

function mockCouncilRunRequest(
  taskId: TaskId,
  contextPack: MockContextPackRef,
  roleProfile: MockRoleProfileRef,
  proposal: MockProposal,
): MockCouncilRunRequest {
  return {
    task_id: taskId,
    trigger: 'gate_defer',
    decision_mode: 'delegated_decision',
    question: 'Should the mocked proposal be selected for merge authorization?',
    context_pack_ref: contextPack,
    participant_profile_refs: [roleProfile],
    proposals: [proposal],
    human_authorization_ref: 'human_authorization://mock',
    auto_advance_allowed: true,
    max_rounds: 1,
    deadline_at: new Date(Date.now() + 60_000).toISOString(),
    schema_version: SCHEMA_VERSION,
  };
}

function mockCouncilDecision(taskId: TaskId, proposal: MockProposal): MockCouncilDecision {
  return {
    decision_id: createId('council_decision'),
    task_id: taskId,
    decision_mode: 'delegated_decision',
    selected_proposal_id: proposal.proposal_id,
    verdict: 'select',
    reason: 'Mock council selects the only proposal with evidence.',
    evidence_refs: proposal.artifact_refs,
    can_create_merge_authorization: true,
    created_at: nowTimestamp(),
    schema_version: SCHEMA_VERSION,
  };
}

function mockMergeAuthorization(
  taskId: TaskId,
  artifactRef: ArtifactRef,
  gateResult: MockGateResult,
  councilDecision: MockCouncilDecision,
): MockMergeAuthorization {
  return {
    merge_authorization_id: createId('merge_authorization'),
    task_id: taskId,
    selected_artifact_refs: [artifactRef.artifact_id],
    gate_result_refs: [gateResult.gate_result_id],
    council_decision_ref: councilDecision.decision_id,
    status: 'authorized',
    reason: 'Delegated mock council decision allows C to create merge authorization.',
    created_at: nowTimestamp(),
    schema_version: SCHEMA_VERSION,
  };
}

function isDirectExecution(): boolean {
  const executedPath = process.argv[1];
  return executedPath !== undefined && fileURLToPath(import.meta.url) === resolve(executedPath);
}

if (isDirectExecution()) {
  const requirement = process.argv.slice(2).join(' ').trim();

  if (!requirement) {
    console.error(
      'Usage: pnpm exec tsx src/coordinator/mock-coordination-demo.ts "<task requirement>"',
    );
    process.exitCode = 1;
  } else {
    const result = runMockCoordinationDemo({
      requirement,
      requesting_agent_id: 'terminal_user',
    });

    console.log(formatMockCoordinationDemo(result));
  }
}
