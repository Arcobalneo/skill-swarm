import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import { SKILLS_DIR } from '@/config/index.js';
import type { SkillInfo } from '@/types/index.js';

// Cache skills list to avoid re-reading the filesystem on every call.
// Invalidate after 30 seconds to pick up skill changes without restart.
const SKILLS_CACHE_MAX_AGE_MS = 30_000;

let skillsCache: { skills: SkillInfo[]; loadedAt: number } | null = null;

export async function listSkills(): Promise<SkillInfo[]> {
  if (skillsCache && Date.now() - skillsCache.loadedAt < SKILLS_CACHE_MAX_AGE_MS) {
    return skillsCache.skills;
  }

  const entries = await fs.readdir(SKILLS_DIR, { withFileTypes: true });
  const skills: SkillInfo[] = [];
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    const skillMdPath = path.join(SKILLS_DIR, entry.name, 'SKILL.md');
    try {
      const content = await fs.readFile(skillMdPath, 'utf-8');
      const frontmatter = parseFrontmatter(content);
      skills.push({
        name: String(frontmatter.name || entry.name),
        description: String(frontmatter.description || ''),
        version: String(frontmatter.version || '0.0.0'),
        path: skillMdPath,
        metadata: frontmatter,
      });
    } catch {
      // skip directories without SKILL.md
    }
  }

  skillsCache = { skills, loadedAt: Date.now() };
  return skills;
}

export function clearSkillsCache(): void {
  skillsCache = null;
}

export function getSkillDir(name: string): string {
  return path.join(SKILLS_DIR, name);
}

export async function loadSkill(name: string): Promise<{ info: SkillInfo; content: string }> {
  const skills = await listSkills();
  const info = skills.find((s) => s.name === name || path.basename(path.dirname(s.path)) === name);
  if (!info) throw new Error(`Skill not found: ${name}`);
  const content = await fs.readFile(info.path, 'utf-8');
  return { info, content };
}

export async function loadMultipleSkills(
  names: string[],
): Promise<{ info: SkillInfo; content: string; dir: string }[]> {
  const loaded = await Promise.all(names.map((name) => loadSkill(name)));
  return loaded.map(({ info, content }) => ({
    info,
    content,
    dir: path.dirname(info.path),
  }));
}

/**
 * Lightweight YAML frontmatter parser.
 * Supports: string scalars, arrays (dash-prefixed), and one-level nested objects.
 */
function parseFrontmatter(content: string): Record<string, unknown> {
  const result: Record<string, unknown> = {};
  if (!content.startsWith('---')) return result;
  const end = content.indexOf('---', 3);
  if (end === -1) return result;

  const lines = content.slice(3, end).trimEnd().split('\n');
  let i = 0;

  while (i < lines.length) {
    const line = lines[i];
    const idx = line.indexOf(':');
    if (idx === -1) {
      i++;
      continue;
    }

    const key = line.slice(0, idx).trim();
    const rest = line.slice(idx + 1).trim();

    // Check if next line is indented (array or nested object)
    if (i + 1 < lines.length && lines[i + 1].match(/^\s+/)) {
      const childLines: string[] = [];
      i++;
      while (i < lines.length && (lines[i].match(/^\s+/) || lines[i].trim() === '')) {
        if (lines[i].trim() !== '') childLines.push(lines[i]);
        i++;
      }

      if (childLines.length > 0 && childLines[0].trim().startsWith('-')) {
        // Array
        const arr: string[] = [];
        for (const cl of childLines) {
          const m = cl.trim().match(/^-\s*(.*)$/);
          if (m) arr.push(m[1].trim());
        }
        result[key] = arr;
      } else {
        // Nested object
        const obj: Record<string, string> = {};
        for (const cl of childLines) {
          const cidx = cl.indexOf(':');
          if (cidx !== -1) {
            obj[cl.slice(0, cidx).trim()] = cl.slice(cidx + 1).trim();
          }
        }
        result[key] = obj;
      }
      continue;
    }

    // Simple scalar
    result[key] = rest;
    i++;
  }

  return result;
}
