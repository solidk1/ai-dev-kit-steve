import { useEffect, useMemo, useState } from 'react';
import { Loader2 } from 'lucide-react';
import { useNavigate, useParams, useSearchParams } from 'react-router-dom';
import { MainLayout } from '@/components/layout/MainLayout';
import { SkillsExplorer } from '@/components/SkillsExplorer';
import { fetchProject } from '@/lib/api';
import type { Project } from '@/lib/types';

export default function ProjectSkillsPage() {
  const { projectId } = useParams<{ projectId: string }>();
  const [searchParams] = useSearchParams();
  const navigate = useNavigate();

  const [project, setProject] = useState<Project | null>(null);
  const [isLoading, setIsLoading] = useState(true);

  useEffect(() => {
    if (!projectId) return;
    const loadProject = async () => {
      try {
        setIsLoading(true);
        const projectData = await fetchProject(projectId);
        setProject(projectData);
      } finally {
        setIsLoading(false);
      }
    };
    loadProject();
  }, [projectId]);

  const systemPromptParams = useMemo(
    () => ({
      projectId,
      clusterId: searchParams.get('cluster_id') || undefined,
      warehouseId: searchParams.get('warehouse_id') || undefined,
      defaultCatalog: searchParams.get('default_catalog') || undefined,
      defaultSchema: searchParams.get('default_schema') || undefined,
      workspaceFolder: searchParams.get('workspace_folder') || undefined,
    }),
    [projectId, searchParams]
  );

  if (!projectId) return null;

  return (
    <MainLayout projectName={project?.name}>
      {isLoading ? (
        <div className="flex h-full items-center justify-center">
          <Loader2 className="h-8 w-8 animate-spin text-[var(--color-text-muted)]" />
        </div>
      ) : (
        <div className="flex-1 min-h-0">
          <SkillsExplorer
            projectId={projectId}
            systemPromptParams={systemPromptParams}
            customSystemPrompt={project?.custom_system_prompt ?? null}
            claudeMd={project?.claude_md ?? null}
            onSystemPromptChange={(prompt) => {
              setProject((prev) => (prev ? { ...prev, custom_system_prompt: prompt } : prev));
            }}
            onClaudeMdChange={(claudeMd) => {
              setProject((prev) => (prev ? { ...prev, claude_md: claudeMd } : prev));
            }}
            onClose={() => navigate(`/projects/${projectId}`)}
            layout="page"
          />
        </div>
      )}
    </MainLayout>
  );
}
