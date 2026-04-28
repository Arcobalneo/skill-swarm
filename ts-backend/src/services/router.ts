import { completeSimple } from '@mariozechner/pi-ai';
import { routerModel, getApiKey } from '@/services/models.js';
import { listSkills } from '@/services/skills.js';
import type { SkillInfo } from '@/types/index.js';
import { ROUTER_CONFIG } from '@/config/index.js';
import { logger } from '@/lib/logger.js';

export async function routeQuery(
  query: string,
): Promise<{ skill: SkillInfo | null; reasoning: string; confidence?: 'high' | 'medium' | 'low' }> {
  const skills = await listSkills();
  if (skills.length === 0) {
    return { skill: null, reasoning: 'No skills available' };
  }
  if (skills.length === 1) {
    return { skill: skills[0], reasoning: 'Only one skill available', confidence: 'high' };
  }

  const skillList = skills
    .map((s, i) => {
      const triggerWords = Array.isArray(s.metadata.trigger_words)
        ? (s.metadata.trigger_words as string[]).join(' / ')
        : '';
      const typicalQueries = Array.isArray(s.metadata.typical_queries)
        ? (s.metadata.typical_queries as string[]).map((q) => `   - "${q}"`).join('\n')
        : '';
      const lines = [
        `${i + 1}. ${s.name}`,
        `   描述：${s.description}`,
      ];
      if (triggerWords) lines.push(`   触发词：${triggerWords}`);
      if (typicalQueries) lines.push(`   典型 query：\n${typicalQueries}`);
      return lines.join('\n');
    })
    .join('\n\n');

  const context = {
    systemPrompt:
      'You are a skill router. Your job is to analyze the user request and choose the SINGLE most appropriate skill from the available list.\n\n' +
      'Respond ONLY with a JSON object in this exact format:\n' +
      '{"skill_name": "...", "reasoning": "...", "confidence": "high|medium|low"}\n\n' +
      'Confidence guidelines:\n' +
      '- "high": The user request clearly matches one skill (explicit keywords, clear intent).\n' +
      '- "medium": The request is somewhat ambiguous but one skill is more likely.\n' +
      '- "low": The request is very vague or does not clearly match any skill.\n\n' +
      'If confidence is "low", still pick the best guess and explain why it is uncertain.',
    messages: [
      {
        role: 'user' as const,
        content: `Available skills:\n\n${skillList}\n\nUser request: "${query}"\n\nWhich skill should be used?`,
        timestamp: Date.now(),
      },
    ],
  };

  logger.debug('Routing query', { query: query.slice(0, 100) });
  const response = await completeSimple(routerModel, context, {
    apiKey: getApiKey(routerModel.provider),
    maxTokens: ROUTER_CONFIG.maxTokens,
    temperature: ROUTER_CONFIG.temperature,
    reasoning: 'xhigh',
  });

  const textBlock = response.content.find((b) => b.type === 'text');
  const text = textBlock?.type === 'text' ? textBlock.text : '';

  let skillName: string | null = null;
  let reasoning = text;
  let confidence: 'high' | 'medium' | 'low' | undefined;

  try {
    const jsonMatch = text.match(/\{[\s\S]*\}/);
    if (jsonMatch) {
      const parsed = JSON.parse(jsonMatch[0]);
      skillName = parsed.skill_name ?? null;
      reasoning = parsed.reasoning ?? text;
      if (parsed.confidence === 'high' || parsed.confidence === 'medium' || parsed.confidence === 'low') {
        confidence = parsed.confidence;
      }
    }
  } catch {
    // fallback to fuzzy match
  }

  if (!skillName) {
    for (const s of skills) {
      if (text.toLowerCase().includes(s.name.toLowerCase())) {
        skillName = s.name;
        break;
      }
    }
  }

  const skill = skills.find((s) => s.name === skillName) ?? null;
  logger.info('Routing result', { skill: skill?.name || null, reasoning, confidence });
  return { skill, reasoning, confidence };
}
