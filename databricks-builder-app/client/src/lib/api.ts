/**
 * Client API for the databricks-builder-app backend.
 * All routes are under /api (proxied in dev).
 */

import type { Cluster, Conversation, Execution, McpToolDescriptor, PersonalSkill, Project, UserInfo, UserSettings, Warehouse } from '@/lib/types';

const API_BASE = '/api';

async function request<T>(
  path: string,
  options: RequestInit & { method?: string; body?: unknown } = {}
): Promise<T> {
  const { method = 'GET', body, ...rest } = options;
  const init: RequestInit = {
    ...rest,
    method,
    headers: {
      'Content-Type': 'application/json',
      ...rest.headers,
    },
    credentials: 'include',
  };
  if (body !== undefined && method !== 'GET') {
    init.body = JSON.stringify(body);
  }
  const res = await fetch(`${API_BASE}${path}`, init);
  if (!res.ok) {
    const errBody = await res.json().catch(() => ({}));
    const message = (errBody.detail ?? res.statusText) as string;
    throw new Error(typeof message === 'string' ? message : JSON.stringify(message));
  }
  if (res.status === 204 || res.headers.get('content-length') === '0') {
    return undefined as T;
  }
  return res.json() as Promise<T>;
}

// --- Config / user ---

export async function fetchUserInfo(): Promise<UserInfo> {
  return request<UserInfo>('/config/me');
}

// --- Projects ---

export async function fetchProjects(): Promise<Project[]> {
  return request<Project[]>('/projects');
}

export async function fetchProject(projectId: string): Promise<Project> {
  return request<Project>(`/projects/${projectId}`);
}

export async function createProject(name: string): Promise<Project> {
  return request<Project>('/projects', { method: 'POST', body: { name } });
}

export async function renameProject(projectId: string, name: string): Promise<void> {
  return request(`/projects/${projectId}`, { method: 'PATCH', body: { name } });
}

export async function deleteProject(projectId: string): Promise<void> {
  return request(`/projects/${projectId}`, { method: 'DELETE' });
}

// --- Conversations ---

export async function fetchConversations(projectId: string): Promise<Conversation[]> {
  return request<Conversation[]>(`/projects/${projectId}/conversations`);
}

export async function fetchConversation(
  projectId: string,
  conversationId: string
): Promise<Conversation> {
  return request<Conversation>(`/projects/${projectId}/conversations/${conversationId}`);
}

export async function createConversation(
  projectId: string,
  title: string = 'New Conversation'
): Promise<Conversation> {
  return request<Conversation>(`/projects/${projectId}/conversations`, {
    method: 'POST',
    body: { title },
  });
}

export async function deleteConversation(
  projectId: string,
  conversationId: string
): Promise<void> {
  return request(`/projects/${projectId}/conversations/${conversationId}`, {
    method: 'DELETE',
  });
}

// --- Clusters & warehouses ---

export async function fetchClusters(): Promise<Cluster[]> {
  return request<Cluster[]>('/clusters');
}

export async function fetchWarehouses(): Promise<Warehouse[]> {
  return request<Warehouse[]>('/warehouses');
}

// --- Agent (invoke + streaming) ---

export interface ImageAttachment {
  type: 'base64';
  media_type: 'image/jpeg' | 'image/png' | 'image/gif' | 'image/webp';
  data: string;
}

export interface InvokeAgentParams {
  projectId: string;
  conversationId?: string | null;
  message: string;
  images?: ImageAttachment[] | null;
  clusterId?: string | null;
  defaultCatalog?: string | null;
  defaultSchema?: string | null;
  warehouseId?: string | null;
  workspaceFolder?: string | null;
  mlflowExperimentName?: string | null;
  signal?: AbortSignal;
  onEvent: (event: Record<string, unknown>) => void;
  onError: (error: Error) => void;
  onDone: () => void | Promise<void>;
  onExecutionId?: (executionId: string) => void;
}

export async function invokeAgent(params: InvokeAgentParams): Promise<void> {
  const {
    projectId,
    conversationId,
    message,
    images,
    clusterId,
    defaultCatalog,
    defaultSchema,
    warehouseId,
    workspaceFolder,
    mlflowExperimentName,
    signal,
    onEvent,
    onError,
    onDone,
    onExecutionId,
  } = params;

  const res = await request<{ execution_id: string; conversation_id: string }>('/invoke_agent', {
    method: 'POST',
    body: {
      project_id: projectId,
      conversation_id: conversationId ?? null,
      message,
      images: images ?? null,
      cluster_id: clusterId ?? null,
      default_catalog: defaultCatalog ?? null,
      default_schema: defaultSchema ?? null,
      warehouse_id: warehouseId ?? null,
      workspace_folder: workspaceFolder ?? null,
      mlflow_experiment_name: mlflowExperimentName ?? null,
    },
  });

  onExecutionId?.(res.execution_id);

  await streamProgress({
    executionId: res.execution_id,
    lastEventTimestamp: undefined,
    signal,
    onEvent,
    onError,
    onDone,
  });
}

export interface ReconnectToExecutionParams {
  executionId: string;
  storedEvents: unknown[];
  signal?: AbortSignal;
  onEvent: (event: Record<string, unknown>) => void;
  onError: (error: Error) => void;
  onDone: () => void | Promise<void>;
}

export async function reconnectToExecution(params: ReconnectToExecutionParams): Promise<void> {
  const { executionId, storedEvents, signal, onEvent, onError, onDone } = params;

  for (const ev of storedEvents) {
    const e = ev as Record<string, unknown>;
    if (e && typeof e === 'object' && e.type !== undefined) {
      onEvent(e);
    }
  }

  let lastTimestamp: number | undefined;
  const lastEv = storedEvents[storedEvents.length - 1] as Record<string, unknown> | undefined;
  if (lastEv && typeof lastEv === 'object' && lastEv.timestamp != null) {
    lastTimestamp = Number(lastEv.timestamp);
  }

  await streamProgress({
    executionId,
    lastEventTimestamp: lastTimestamp,
    signal,
    onEvent,
    onError,
    onDone,
  });
}

async function streamProgress(params: {
  executionId: string;
  lastEventTimestamp?: number;
  signal?: AbortSignal;
  onEvent: (event: Record<string, unknown>) => void;
  onError: (error: Error) => void;
  onDone: () => void | Promise<void>;
}): Promise<void> {
  const {
    executionId,
    lastEventTimestamp,
    signal,
    onEvent,
    onError,
    onDone,
  } = params;

  let lastTs: number = lastEventTimestamp ?? 0;

  while (true) {
    if (signal?.aborted) return;

    let shouldReconnect = false;

    try {
      const res = await fetch(`${API_BASE}/stream_progress/${executionId}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        credentials: 'include',
        body: JSON.stringify({ last_event_timestamp: lastTs }),
        signal,
      });

      if (!res.ok) {
        // 404 means the stream no longer exists in memory (e.g. server restarted after a
        // deploy while the execution was running). Treat it as completed so the caller
        // reloads the conversation from the DB instead of showing an error.
        if (res.status === 404) {
          await onDone();
          return;
        }
        const errBody = await res.json().catch(() => ({}));
        const message = (errBody.detail ?? res.statusText) as string;
        onError(new Error(typeof message === 'string' ? message : JSON.stringify(message)));
        return;
      }

      const reader = res.body?.getReader();
      if (!reader) {
        onError(new Error('No response body'));
        return;
      }

      const decoder = new TextDecoder();
      let buffer = '';

      while (true) {
        if (signal?.aborted) return;
        const { done, value } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });
        const lines = buffer.split('\n');
        buffer = lines.pop() ?? '';

        for (const line of lines) {
          if (!line.startsWith('data: ')) continue;
          const payload = line.slice(6).trim();
          if (payload === '[DONE]') {
            await onDone();
            return;
          }
          try {
            const event = JSON.parse(payload) as Record<string, unknown>;
            if (event.type === 'stream.reconnect') {
              lastTs = Number(event.last_timestamp) ?? lastTs;
              shouldReconnect = true;
              break;
            }
            if (event.type === 'stream.completed') {
              await onDone();
              return;
            }
            onEvent(event);
          } catch {
            // skip malformed
          }
        }
        if (shouldReconnect) break;
      }
    } catch (e) {
      if ((e as Error).name === 'AbortError') return;
      onError(e instanceof Error ? e : new Error(String(e)));
      return;
    }

    if (!shouldReconnect) {
      await onDone();
      return;
    }
  }
}

// --- Stop execution ---

export async function stopExecution(executionId: string): Promise<{ success: boolean; message: string }> {
  return request<{ success: boolean; message: string }>(`/stop_stream/${executionId}`, {
    method: 'POST',
  });
}

// --- Executions ---

export async function fetchExecutions(
  projectId: string,
  conversationId: string
): Promise<{ active: Execution | null; recent: Execution[] }> {
  const data = await request<{
    active: Execution | null;
    recent: Execution[];
  }>(`/projects/${projectId}/conversations/${conversationId}/executions`);
  return data;
}

// --- Project local file uploads ---

export interface UploadedProjectFile {
  name: string;
  path: string; // relative path inside project directory
  size: number;
}

export async function uploadProjectFile(
  projectId: string,
  file: File
): Promise<UploadedProjectFile> {
  const formData = new FormData();
  formData.append('file', file);

  const res = await fetch(`${API_BASE}/projects/${projectId}/files/upload`, {
    method: 'POST',
    credentials: 'include',
    body: formData,
  });

  if (!res.ok) {
    const errBody = await res.json().catch(() => ({}));
    const message = (errBody.detail ?? res.statusText) as string;
    throw new Error(typeof message === 'string' ? message : JSON.stringify(message));
  }

  return res.json() as Promise<UploadedProjectFile>;
}

// --- Skills ---

export interface SkillTreeNode {
  name: string;
  path: string;
  type: 'directory' | 'file';
  children?: SkillTreeNode[];
}

export interface FetchSystemPromptParams {
  clusterId?: string | null;
  warehouseId?: string | null;
  defaultCatalog?: string | null;
  defaultSchema?: string | null;
  workspaceFolder?: string | null;
  projectId?: string | null;
}

export async function fetchSkillsTree(projectId: string): Promise<SkillTreeNode[]> {
  const data = await request<{ tree: SkillTreeNode[] }>(
    `/projects/${projectId}/skills/tree`
  );
  return data.tree ?? [];
}

export async function fetchSkillFile(
  projectId: string,
  path: string
): Promise<{ content: string; path?: string; filename?: string }> {
  const data = await request<{ content: string; path?: string; filename?: string }>(
    `/projects/${projectId}/skills/file?path=${encodeURIComponent(path)}`
  );
  return data;
}

export async function fetchSystemPrompt(params: FetchSystemPromptParams): Promise<string> {
  const q = new URLSearchParams();
  if (params.clusterId != null) q.set('cluster_id', params.clusterId);
  if (params.warehouseId != null) q.set('warehouse_id', params.warehouseId);
  if (params.defaultCatalog != null) q.set('default_catalog', params.defaultCatalog);
  if (params.defaultSchema != null) q.set('default_schema', params.defaultSchema);
  if (params.workspaceFolder != null) q.set('workspace_folder', params.workspaceFolder);
  if (params.projectId != null) q.set('project_id', params.projectId);
  const data = await request<{ system_prompt: string }>(`/config/system_prompt?${q.toString()}`);
  return data.system_prompt ?? '';
}

export async function fetchAvailableSkills(
  projectId: string
): Promise<{ skills: { name: string; description: string; enabled: boolean }[]; all_enabled: boolean; enabled_count: number; total_count: number }> {
  return request(`/projects/${projectId}/skills/available`);
}

export async function updateEnabledSkills(
  projectId: string,
  enabledSkills: string[] | null
): Promise<void> {
  await request(`/projects/${projectId}/skills/enabled`, {
    method: 'PUT',
    body: { enabled_skills: enabledSkills },
  });
}

export async function reloadProjectSkills(projectId: string): Promise<void> {
  await request(`/projects/${projectId}/skills/reload`, { method: 'POST' });
}

export async function saveProjectSkillFile(
  projectId: string,
  path: string,
  content: string
): Promise<void> {
  await request(`/projects/${projectId}/skills/file`, {
    method: 'PUT',
    body: { path, content },
  });
}

// --- Personal workspace (user's /Users/<email>/.claude/ in Databricks) ---

export async function fetchPersonalSkills(): Promise<PersonalSkill[]> {
  const data = await request<{ skills: PersonalSkill[] }>('/personal/skills');
  return data.skills ?? [];
}

export async function fetchPersonalSkillsTree(): Promise<SkillTreeNode[]> {
  const data = await request<{ tree: SkillTreeNode[] }>('/personal/skills/tree');
  return data.tree ?? [];
}

export async function fetchPersonalSkillFile(
  workspacePath: string
): Promise<{ content: string; path: string; filename: string }> {
  return request<{ content: string; path: string; filename: string }>(
    `/personal/skills/file?path=${encodeURIComponent(workspacePath)}`
  );
}

export async function savePersonalSkillFile(
  workspacePath: string,
  content: string
): Promise<void> {
  await request('/personal/skills/file', {
    method: 'PUT',
    body: { workspace_path: workspacePath, content },
  });
}

// --- MCP tools ---

export async function fetchInstalledMcpTools(): Promise<McpToolDescriptor[]> {
  const data = await request<{ tools: McpToolDescriptor[]; count: number }>('/mcp/tools');
  return data.tools ?? [];
}

// --- User settings ---

export async function fetchUserSettings(): Promise<UserSettings> {
  return request<UserSettings>('/config/settings');
}

export interface SaveUserSettingsParams {
  defaultCatalog: string | null;
  defaultSchema: string | null;
  workspaceFolder: string | null;
  model: string | null;
  modelMini: string | null;
}

export async function saveUserSettings(params: SaveUserSettingsParams): Promise<void> {
  await request('/config/settings', {
    method: 'PUT',
    body: {
      default_catalog: params.defaultCatalog || null,
      default_schema: params.defaultSchema || null,
      workspace_folder: params.workspaceFolder || null,
      model: params.model || null,
      model_mini: params.modelMini || null,
    },
  });
}

// --- PAT management ---

export async function savePat(pat: string): Promise<void> {
  await request('/config/pat', { method: 'PUT', body: { pat } });
}

export async function deletePat(): Promise<void> {
  await request('/config/pat', { method: 'DELETE' });
}

// --- System Prompt ---

export async function updateProjectSystemPrompt(
  projectId: string,
  systemPrompt: string | null
): Promise<void> {
  await request(`/projects/${projectId}/system_prompt`, {
    method: 'PUT',
    body: { system_prompt: systemPrompt },
  });
}

export async function updateProjectClaudeMd(
  projectId: string,
  claudeMd: string | null
): Promise<void> {
  await request(`/projects/${projectId}/claude_md`, {
    method: 'PUT',
    body: { claude_md: claudeMd },
  });
}
