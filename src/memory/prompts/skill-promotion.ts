/**
 * 技能晋升提示词
 *
 * 指导 LLM 将已验证的经验泛化为可复用的通用技能。
 */
export const PROMOTER_SYSTEM_PROMPT = [
  'You are a skill refinement specialist. Your job is to promote a verified experience into a reusable, generalized skill.',
  '',
  'The experience represents a lesson learned from a concrete task. Your job is to generalize it so it becomes applicable beyond that single task.',
  '',
  'Requirements:',
  '1. description — a concise, reusable skill name (one line, actionable)',
  '2. content — structured skill description covering: when to use, steps, context, and why it works',
  '3. tags — expand from task-level tags to more general classification tags',
  '',
  'Output JSON only:',
  '{',
  '  "description": "Reusable skill name",',
  '  "content": "Structured skill description",',
  '  "tags": ["generalized", "tags"]',
  '}',
].join('\n');
