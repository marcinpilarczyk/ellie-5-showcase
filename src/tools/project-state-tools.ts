import { z } from 'zod';
import { ToolDefinition } from '../types/tool.js';
import { GoogleWorkspaceClient } from '../integrations/google/client.js';

export const CANONICAL_PROJECT_SECTIONS = [
  'Objective',
  'Current Status',
  'Active Workstreams',
  'Open Loops / Waiting On',
  'Key Decisions',
  'Risks / Blockers',
  'Next Actions',
  'Linked Artifacts'
] as const;

export type CanonicalSectionName = typeof CANONICAL_PROJECT_SECTIONS[number];

const SECTION_ALIASES: Record<string, CanonicalSectionName> = {
  'objective': 'Objective',
  'current_status': 'Current Status',
  'currentstatus': 'Current Status',
  'status': 'Current Status',
  'active_workstreams': 'Active Workstreams',
  'activeworkstreams': 'Active Workstreams',
  'workstreams': 'Active Workstreams',
  'open_loops': 'Open Loops / Waiting On',
  'openloops': 'Open Loops / Waiting On',
  'waiting_on': 'Open Loops / Waiting On',
  'waitingon': 'Open Loops / Waiting On',
  'open_loops_waiting_on': 'Open Loops / Waiting On',
  'key_decisions': 'Key Decisions',
  'keydecisions': 'Key Decisions',
  'decisions': 'Key Decisions',
  'risks_blockers': 'Risks / Blockers',
  'risksblockers': 'Risks / Blockers',
  'risks': 'Risks / Blockers',
  'blockers': 'Risks / Blockers',
  'next_actions': 'Next Actions',
  'nextactions': 'Next Actions',
  'actions': 'Next Actions',
  'linked_artifacts': 'Linked Artifacts',
  'linkedartifacts': 'Linked Artifacts',
  'artifacts': 'Linked Artifacts'
};

export function normalizeSectionName(input: string): CanonicalSectionName | null {
  const trimmed = input.trim();
  const direct = CANONICAL_PROJECT_SECTIONS.find(s => s.toLowerCase() === trimmed.toLowerCase());
  if (direct) return direct;
  const key = trimmed.toLowerCase().replace(/[^a-z0-9_]/g, '_').replace(/_+/g, '_').replace(/^_|_$/g, '');
  return SECTION_ALIASES[key] ?? null;
}

export function parseProjectStateSections(rawText: string): {
  header: string;
  sections: Record<CanonicalSectionName, string>;
} {
  const sections: Record<CanonicalSectionName, string> = {
    'Objective': '',
    'Current Status': '',
    'Active Workstreams': '',
    'Open Loops / Waiting On': '',
    'Key Decisions': '',
    'Risks / Blockers': '',
    'Next Actions': '',
    'Linked Artifacts': ''
  };

  if (!rawText || !rawText.trim()) {
    return { header: '', sections };
  }

  // Regex to split headings: ## Section Name or # Section Name
  const headingRegex = /(?:^|\n)##?\s+([^\n]+)\n/g;
  let match: RegExpExecArray | null;
  const matches: Array<{ name: string; index: number; length: number }> = [];

  while ((match = headingRegex.exec(rawText)) !== null) {
    matches.push({
      name: match[1].trim(),
      index: match.index,
      length: match[0].length
    });
  }

  if (matches.length === 0) {
    return { header: rawText.trim(), sections };
  }

  const header = rawText.substring(0, matches[0].index).trim();

  for (let i = 0; i < matches.length; i++) {
    const current = matches[i];
    const startIndex = current.index + current.length;
    const endIndex = i + 1 < matches.length ? matches[i + 1].index : rawText.length;
    const body = rawText.substring(startIndex, endIndex).trim();

    const canonical = normalizeSectionName(current.name);
    if (canonical) {
      sections[canonical] = body;
    }
  }

  return { header, sections };
}

export function serializeProjectState(projectName: string, sections: Record<CanonicalSectionName, string>): string {
  const out: string[] = [`# PROJECT_STATE: ${projectName.trim()}`, ''];

  for (const name of CANONICAL_PROJECT_SECTIONS) {
    out.push(`## ${name}`);
    const content = sections[name]?.trim();
    out.push(content && content.length > 0 ? content : '_None_');
    out.push('');
  }

  return out.join('\n').trim() + '\n';
}

export interface ProjectStateAdapter {
  findDoc(projectName: string): Promise<{ documentId: string; title: string } | null>;
  createDoc(projectName: string, initialContent: string): Promise<{ documentId: string }>;
  readDoc(documentId: string): Promise<string>;
  replaceDoc(documentId: string, content: string): Promise<void>;
}

export function createGoogleProjectStateAdapter(
  googleClient: GoogleWorkspaceClient,
  ownerFolderId: () => Promise<string | undefined>
): ProjectStateAdapter {
  return {
    findDoc: async (projectName: string) => {
      const rootId = await ownerFolderId();
      if (!rootId) return null;
      try {
        const projectFolderPath = `Projects/${projectName.trim()}`;
        const folderId = await googleClient.ensureFolderPath(rootId, projectFolderPath);
        const docs = await googleClient.listFolderDocs(folderId, () => false, 1, 10);
        const found = docs.find(d => /PROJECT_STATE/i.test(d.title));
        if (found) {
          return { documentId: found.id, title: found.title };
        }
      } catch {}
      return null;
    },
    createDoc: async (projectName: string, initialContent: string) => {
      const rootId = await ownerFolderId();
      let folderId: string | undefined;
      if (rootId) {
        try {
          folderId = await googleClient.ensureFolderPath(rootId, `Projects/${projectName.trim()}`);
        } catch {}
      }
      const res = await googleClient.createDocInFolder(`PROJECT_STATE: ${projectName.trim()}`, initialContent, folderId);
      return { documentId: res.documentId };
    },
    readDoc: async (documentId: string) => {
      return googleClient.readDoc(documentId);
    },
    replaceDoc: async (documentId: string, content: string) => {
      await googleClient.replaceDocContent(documentId, content);
    }
  };
}

export function createProjectStateTools(adapter: ProjectStateAdapter): ToolDefinition[] {
  const tools: ToolDefinition[] = [];

  // 1. project_state_read
  tools.push({
    name: 'project_state_read',
    description: 'Reads the canonical PROJECT_STATE Google Doc for a given project under /EllieOS/Projects/<Project>/PROJECT_STATE. Returns all 8 canonical sections.',
    effectClass: 'READ',
    schema: z.object({
      project: z.string().describe('The project directory name (e.g. "JOB_SEARCH", "ADVISORY", "ELLIE_V5")')
    }),
    readsResource: (params: any) => `project_state:${params.project}`,
    execute: async (params) => {
      const found = await adapter.findDoc(params.project);
      if (!found) {
        return {
          project: params.project,
          found: false,
          message: `No PROJECT_STATE doc found under Projects/${params.project}. Use project_state_update to initialize it.`
        };
      }
      const rawText = await adapter.readDoc(found.documentId);
      const parsed = parseProjectStateSections(rawText);
      return {
        project: params.project,
        found: true,
        documentId: found.documentId,
        title: found.title,
        sections: parsed.sections,
        rawText
      };
    }
  });

  // 2. project_state_update
  tools.push({
    name: 'project_state_update',
    description: 'Updates specific canonical sections of a project PROJECT_STATE Doc without clobbering other sections. Creates the Doc under /EllieOS/Projects/<Project>/PROJECT_STATE if it does not exist.',
    effectClass: 'INTERNAL_REVERSIBLE_WRITE',
    schema: z.object({
      project: z.string().describe('The project directory name (e.g. "JOB_SEARCH", "ADVISORY", "ELLIE_V5")'),
      sections: z.record(z.string()).describe(
        'Map of section updates. Allowed section keys: "objective", "current_status", "active_workstreams", "open_loops", "key_decisions", "risks_blockers", "next_actions", "linked_artifacts"'
      ),
      notes: z.string().optional().describe('Optional context or changelog note for this update')
    }),
    writesResource: (_params: any, result: any) => result?.documentId,
    execute: async (params) => {
      let doc = await adapter.findDoc(params.project);
      let existingText = '';
      let documentId = '';

      if (doc) {
        documentId = doc.documentId;
        existingText = await adapter.readDoc(documentId);
      }

      const parsed = parseProjectStateSections(existingText);
      const updatedSectionNames: CanonicalSectionName[] = [];

      const sectionMap = (params.sections || {}) as Record<string, unknown>;
      for (const [key, value] of Object.entries(sectionMap)) {
        const canonical = normalizeSectionName(key);
        if (!canonical) {
          throw new Error(`Unknown section '${key}'. Allowed canonical sections: ${CANONICAL_PROJECT_SECTIONS.join(', ')}.`);
        }
        parsed.sections[canonical] = String(value ?? '').trim();
        updatedSectionNames.push(canonical);
      }

      const newContent = serializeProjectState(params.project, parsed.sections);

      if (!doc) {
        const created = await adapter.createDoc(params.project, newContent);
        documentId = created.documentId;
      } else {
        await adapter.replaceDoc(documentId, newContent);
      }

      return {
        project: params.project,
        documentId,
        updatedSections: updatedSectionNames,
        status: 'UPDATED',
        message: `Updated PROJECT_STATE for ${params.project} (${updatedSectionNames.join(', ')}). Doc ID: ${documentId}.`
      };
    },
    verify: async (params, lastKnownResult) => {
      const docId = lastKnownResult?.documentId;
      if (!docId) return { outcome: 'FAILED_SAFE', details: 'No document ID returned.' };
      try {
        const text = await adapter.readDoc(docId);
        const parsed = parseProjectStateSections(text);
        const verifyMap = (params.sections || {}) as Record<string, unknown>;
        for (const [key, rawExpected] of Object.entries(verifyMap)) {
          const canonical = normalizeSectionName(key);
          const expectedValue = String(rawExpected ?? '').trim();
          if (canonical && expectedValue) {
            const actual = parsed.sections[canonical];
            if (!actual || !actual.includes(expectedValue.substring(0, 30))) {
              return { outcome: 'FAILED_SAFE', details: `Section '${canonical}' was not updated as expected upon read-back.` };
            }
          }
        }
        return { outcome: 'VERIFIED_SUCCESS', details: `PROJECT_STATE Doc ${docId} verified with updated sections.` };
      } catch (err: any) {
        return { outcome: 'RECONCILIATION_REQUIRED', reconciliationNotes: `Verification read-back failed: ${err.message}` };
      }
    }
  });

  return tools;
}
