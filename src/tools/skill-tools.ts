import { z } from 'zod';
import fs from 'node:fs';
import path from 'node:path';
import { ToolDefinition } from '../types/tool.js';

export function createSkillTools(skillsDir = path.resolve('skills')): ToolDefinition[] {
  return [
    {
      name: 'skills_list',
      description: 'Lists all available markdown skills installed on the system.',
      effectClass: 'READ',
      schema: z.object({}),
      execute: async () => {
        if (!fs.existsSync(skillsDir)) return [];
        const entries = fs.readdirSync(skillsDir, { withFileTypes: true });
        const skills: Array<{ name: string; hasReadme: boolean }> = [];
        for (const entry of entries) {
          if (entry.isDirectory()) {
            const skillMd = path.join(skillsDir, entry.name, 'SKILL.md');
            skills.push({ name: entry.name, hasReadme: fs.existsSync(skillMd) });
          }
        }
        return skills;
      }
    },
    {
      name: 'skill_read',
      description: 'Reads the markdown guidelines for an installed skill (e.g. humanizer, humanization, poprawna-polszczyzna). Their scripts and word lists run inside owner_text_check; do not open them or run them yourself.',
      effectClass: 'READ',
      schema: z.object({
        name: z.string().describe('Skill folder name (e.g. humanizer, humanization, poprawna-polszczyzna)')
      }),
      execute: async (params) => {
        const skillMd = path.join(skillsDir, params.name, 'SKILL.md');
        if (!fs.existsSync(skillMd)) {
          throw new Error(`Skill '${params.name}' not found at ${skillMd}`);
        }
        const content = fs.readFileSync(skillMd, 'utf8');
        return { name: params.name, content };
      }
    },
    {
      name: 'skill_edit',
      description: 'Updates or creates the markdown instructions for a skill under skills/<name>/SKILL.md. Verified via read-back.',
      effectClass: 'INTERNAL_REVERSIBLE_WRITE',
      schema: z.object({
        name: z.string().describe('Skill folder name (e.g. humanizer, poprawna-polszczyzna)'),
        content: z.string().describe('The full markdown text content of SKILL.md')
      }),
      execute: async (params) => {
        const targetDir = path.join(skillsDir, params.name);
        fs.mkdirSync(targetDir, { recursive: true });
        const skillMd = path.join(targetDir, 'SKILL.md');
        fs.writeFileSync(skillMd, params.content, 'utf8');
        return { ok: true, name: params.name, path: skillMd, bytes: Buffer.byteLength(params.content) };
      },
      verify: async (params) => {
        const skillMd = path.join(skillsDir, params.name, 'SKILL.md');
        if (fs.existsSync(skillMd)) {
          const read = fs.readFileSync(skillMd, 'utf8');
          if (read === params.content) {
            return { outcome: 'VERIFIED_SUCCESS', details: `Skill '${params.name}' verified on disk (${read.length} chars).` };
          }
        }
        return { outcome: 'FAILED_SAFE', details: `Skill '${params.name}' content does not match on disk.` };
      }
    }
  ];
}
