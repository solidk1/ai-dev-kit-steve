import { useCallback, useEffect, useRef, useState } from 'react';
import { useNavigate, useParams } from 'react-router-dom';
import { useUser } from '@/contexts/UserContext';
import {
  Brain,
  ChevronDown,
  FileText,
  Image as ImageIcon,
  Loader2,
  MessageSquare,
  Paperclip,
  Send,
  Square,
  Wrench,
  X,
} from 'lucide-react';
import { toast } from 'sonner';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import { Prism as SyntaxHighlighter } from 'react-syntax-highlighter';
import { oneDark } from 'react-syntax-highlighter/dist/esm/styles/prism';
import { MainLayout } from '@/components/layout/MainLayout';
import { Sidebar } from '@/components/layout/Sidebar';
import { SkillsExplorer } from '@/components/SkillsExplorer';
import { FunLoader } from '@/components/FunLoader';
import { Button } from '@/components/ui/Button';
import {
  createConversation,
  deleteConversation,
  fetchClusters,
  fetchConversation,
  fetchConversations,
  fetchExecutions,
  fetchProject,
  fetchUserSettings,
  fetchWarehouses,
  invokeAgent,
  reconnectToExecution,
  stopExecution,
  uploadProjectFile,
} from '@/lib/api';
import type { Cluster, Conversation, Message, Project, UserSettings, Warehouse, TodoItem } from '@/lib/types';
import type { ImageAttachment } from '@/lib/api';
import { cn } from '@/lib/utils';

// Local attachment types
interface AttachedImage {
  id: string;
  file: File;
  preview: string;    // ObjectURL for display
  data: string;       // base64 for API
  mediaType: 'image/jpeg' | 'image/png' | 'image/gif' | 'image/webp';
}

interface AttachedFile {
  id: string;
  file: File;
}

interface QueuedMessage {
  conversationId: string | null;
  userMessage: string;
  displayContent: string;
  imagesToSend: ImageAttachment[];
}

interface InProgressConversationState {
  userMessage?: Message;
  streamingText: string;
  queuedMessages?: Message[];
}

const PENDING_CONVERSATION_KEY = '__pending__';

const SUPPORTED_IMAGE_TYPES = ['image/jpeg', 'image/png', 'image/gif', 'image/webp'];
const MAX_IMAGE_SIZE = 20 * 1024 * 1024; // 20MB

async function readImageAsBase64(file: File): Promise<{ data: string; mediaType: AttachedImage['mediaType'] }> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = (e) => {
      const dataUrl = e.target?.result as string;
      const [prefix, data] = dataUrl.split(',');
      const mediaType = prefix.split(':')[1].split(';')[0] as AttachedImage['mediaType'];
      resolve({ data, mediaType });
    };
    reader.onerror = reject;
    reader.readAsDataURL(file);
  });
}

// Combined activity item for display
interface ActivityItem {
  id: string;
  type: 'thinking' | 'tool_use' | 'tool_result' | 'keepalive';
  content: string;
  toolName?: string;
  toolInput?: Record<string, unknown>;
  isError?: boolean;
  timestamp: number;
}

// Minimal activity indicator - shows only current tool being executed (non-verbose)
function ActivitySection({
  items,
  isStreaming,
}: {
  items: ActivityItem[];
  isStreaming: boolean;
}) {
  if (items.length === 0) return null;

  const currentTool = [...items].reverse().find((item) => item.type === 'tool_use');
  if (!currentTool) return null;

  return (
    <div className="mb-2 flex items-center gap-2 text-xs text-[var(--color-text-muted)]">
      <Wrench className={cn('h-3 w-3 text-[var(--color-accent-primary)]', isStreaming && 'animate-pulse')} />
      <span className="truncate">
        Using {currentTool.toolName?.replace('mcp__databricks__', '')}...
      </span>
    </div>
  );
}

// Extract code and language from tool inputs for the 3 code-execution MCP tools.
function getCodeFromToolInput(
  toolName: string | undefined,
  toolInput: Record<string, unknown> | undefined,
): { code: string; language: string; params?: Record<string, unknown> } | null {
  if (!toolName || !toolInput) return null;
  const name = toolName.replace('mcp__databricks__', '');
  if (name === 'execute_sql') {
    const code = toolInput.sql_query as string;
    if (code) {
      const { sql_query, ...params } = toolInput;
      return { code, language: 'sql', params: Object.keys(params).length > 0 ? params : undefined };
    }
  } else if (name === 'execute_sql_multi') {
    const code = toolInput.sql_content as string;
    if (code) {
      const { sql_content, ...params } = toolInput;
      return { code, language: 'sql', params: Object.keys(params).length > 0 ? params : undefined };
    }
  } else if (name === 'execute_databricks_command') {
    const code = toolInput.code as string;
    if (code) {
      const { code: _code, language: lang, ...params } = toolInput;
      return { code, language: (lang as string) || 'python', params: Object.keys(params).length > 0 ? params : undefined };
    }
  }
  return null;
}

// Single item in the verbose trace
function VerboseItem({ item }: { item: ActivityItem }) {
  const [expanded, setExpanded] = useState(item.type === 'thinking');

  if (item.type === 'thinking') {
    return (
      <div className="border-b border-[var(--color-border)]/20 last:border-0">
        <button
          onClick={() => setExpanded(!expanded)}
          className="w-full flex items-center gap-2 px-3 py-1.5 text-left hover:bg-[var(--color-bg-secondary)]/40 transition-colors"
        >
          <Brain className="h-3 w-3 flex-shrink-0 text-purple-400" />
          <span className="text-[11px] text-[var(--color-text-muted)] flex-1 truncate">
            {expanded
              ? `Thinking · ${item.content.length} chars`
              : item.content.slice(0, 220).replace(/\n/g, ' ')}
          </span>
          <ChevronDown className={cn('h-3 w-3 flex-shrink-0 text-[var(--color-text-muted)] transition-transform', expanded && 'rotate-180')} />
        </button>
        {expanded && (
          <div className="px-3 pb-2 ml-5 font-mono text-[10px] text-[var(--color-text-muted)] whitespace-pre-wrap leading-relaxed max-h-96 overflow-y-auto">
            {item.content}
          </div>
        )}
      </div>
    );
  }

  if (item.type === 'tool_use') {
    const toolName = item.toolName?.replace('mcp__databricks__', '') ?? '';
    const codeInfo = getCodeFromToolInput(item.toolName, item.toolInput);
    const inputStr = !codeInfo && item.toolInput ? JSON.stringify(item.toolInput, null, 2) : '';
    const hasExpandable = !!(codeInfo || inputStr);
    return (
      <div className="border-b border-[var(--color-border)]/20 last:border-0">
        <button
          onClick={() => setExpanded(!expanded)}
          className="w-full flex items-center gap-2 px-3 py-1.5 text-left hover:bg-[var(--color-bg-secondary)]/40 transition-colors"
        >
          <Wrench className="h-3 w-3 flex-shrink-0 text-[var(--color-accent-primary)]" />
          <span className="font-mono text-[11px] text-[var(--color-text-primary)]">{toolName}</span>
          {codeInfo && (
            <span className="ml-1 px-1 py-0.5 rounded text-[9px] font-mono uppercase tracking-wide bg-[var(--color-accent-primary)]/10 text-[var(--color-accent-primary)]">
              {codeInfo.language}
            </span>
          )}
          {hasExpandable && (
            <ChevronDown className={cn('h-3 w-3 ml-auto flex-shrink-0 text-[var(--color-text-muted)] transition-transform', expanded && 'rotate-180')} />
          )}
        </button>
        {expanded && codeInfo?.params && (
          <div className="flex flex-wrap gap-1 mx-3 mb-1.5">
            {Object.entries(codeInfo.params).map(([key, val]) => (
              <span key={key} className="inline-flex items-center gap-1 px-1.5 py-0.5 rounded text-[9px] font-mono bg-[var(--color-bg-secondary)]/60 text-[var(--color-text-muted)] border border-[var(--color-border)]/30">
                <span className="text-[var(--color-text-muted)]/70">{key}:</span>
                <span className="text-[var(--color-text-primary)]">{String(val)}</span>
              </span>
            ))}
          </div>
        )}
        {expanded && codeInfo && (
          <div className="mx-3 mb-2 max-h-64 overflow-y-auto rounded text-[10px]">
            <SyntaxHighlighter
              language={codeInfo.language}
              style={oneDark}
              customStyle={{ margin: 0, borderRadius: '0.25rem', fontSize: '10px', lineHeight: '1.5' }}
              wrapLongLines
            >
              {codeInfo.code}
            </SyntaxHighlighter>
          </div>
        )}
        {expanded && inputStr && (
          <div className="px-3 pb-2 ml-5 font-mono text-[10px] text-[var(--color-text-muted)] whitespace-pre-wrap leading-relaxed max-h-32 overflow-y-auto bg-[var(--color-bg-secondary)]/30 rounded mx-3 mb-1 p-1.5">
            {inputStr}
          </div>
        )}
      </div>
    );
  }

  if (item.type === 'tool_result') {
    const preview = item.content.slice(0, 120).replace(/\n/g, ' ');
    const hasMore = item.content.length > 120;
    return (
      <div className={cn('border-b border-[var(--color-border)]/20 last:border-0', item.isError && 'bg-[var(--color-error)]/5')}>
        <button
          onClick={() => (hasMore ? setExpanded(!expanded) : undefined)}
          className={cn(
            'w-full flex items-start gap-2 px-3 py-1.5 text-left transition-colors',
            hasMore && 'hover:bg-[var(--color-bg-secondary)]/40 cursor-pointer',
            !hasMore && 'cursor-default',
          )}
        >
          <span className={cn('text-[10px] flex-shrink-0 mt-0.5 font-mono', item.isError ? 'text-[var(--color-error)]' : 'text-[var(--color-success)]')}>
            {item.isError ? '✕' : '✓'}
          </span>
          <span className="font-mono text-[10px] text-[var(--color-text-muted)] flex-1 truncate">{preview}</span>
          {hasMore && (
            <ChevronDown className={cn('h-3 w-3 flex-shrink-0 text-[var(--color-text-muted)] transition-transform', expanded && 'rotate-180')} />
          )}
        </button>
        {expanded && (
          <div className="px-3 pb-2 ml-5 font-mono text-[10px] text-[var(--color-text-muted)] whitespace-pre-wrap leading-relaxed max-h-48 overflow-y-auto bg-[var(--color-bg-secondary)]/30 rounded mx-3 mb-1 p-1.5">
            {item.content}
          </div>
        )}
      </div>
    );
  }

  if (item.type === 'keepalive') {
    return (
      <div className="border-b border-[var(--color-border)]/20 last:border-0">
        <div className="w-full flex items-center gap-2 px-3 py-1.5 text-left">
          <Loader2 className="h-3 w-3 flex-shrink-0 animate-spin text-[var(--color-accent-primary)]" />
          <span className="text-[10px] font-mono text-[var(--color-text-muted)]">{item.content}</span>
        </div>
      </div>
    );
  }

  return null;
}

// Full verbose trace panel (thinking + tool calls + results in order)
function VerboseActivityLog({
  items,
  isStreaming,
}: {
  items: ActivityItem[];
  isStreaming: boolean;
}) {
  const [collapsed, setCollapsed] = useState(false);

  if (items.length === 0) return null;

  const currentTool = isStreaming ? [...items].reverse().find((i) => i.type === 'tool_use') : null;

  return (
    <div className="mb-2 max-w-[85%] rounded-lg border border-[var(--color-border)]/50 bg-[var(--color-bg-secondary)]/20 overflow-hidden text-xs">
      <button
        onClick={() => setCollapsed(!collapsed)}
        className="w-full flex items-center gap-2 px-3 py-2 text-[var(--color-text-muted)] hover:bg-[var(--color-bg-secondary)]/50 transition-colors"
      >
        <Wrench className={cn('h-3 w-3 text-[var(--color-accent-primary)]', isStreaming && currentTool && 'animate-pulse')} />
        <span className="font-medium text-[var(--color-text-muted)]">
          {isStreaming && currentTool
            ? `Using ${currentTool.toolName?.replace('mcp__databricks__', '')}…`
            : `Agent trace · ${items.length} step${items.length !== 1 ? 's' : ''}`}
        </span>
        <ChevronDown className={cn('h-3 w-3 ml-auto transition-transform', !collapsed && 'rotate-180')} />
      </button>
      {!collapsed && (
        <div className="border-t border-[var(--color-border)]/30 max-h-96 overflow-y-auto">
          {items.map((item) => (
            <VerboseItem key={item.id} item={item} />
          ))}
        </div>
      )}
    </div>
  );
}

// Determine the proxy URL for a Databricks file path
function toDatabricksProxyUrl(path: string): string {
  return `/api/workspace/file?path=${encodeURIComponent(path)}`;
}

function isDatabricksFilePath(src: string): boolean {
  return (
    src.startsWith('/Workspace/') ||
    src.startsWith('/Users/') ||
    src.startsWith('/Shared/') ||
    src.startsWith('dbfs:/') ||
    src.startsWith('/dbfs/') ||
    src.startsWith('/Volumes/')
  );
}

// Renders a Databricks-hosted image via the workspace proxy.
// Fetches via JS (not <img src>) so we can capture server error details.
function DatabricksImage({
  path,
  alt,
  className,
}: {
  path: string;
  alt?: string;
  className?: string;
}) {
  const [blobUrl, setBlobUrl] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const proxyUrl = toDatabricksProxyUrl(path);

  useEffect(() => {
    let cancelled = false;
    let objectUrl: string | null = null;
    fetch(proxyUrl, { credentials: 'include' })
      .then(async (res) => {
        if (!res.ok) {
          const body = await res.json().catch(() => ({}));
          throw new Error((body as Record<string, string>).detail || res.statusText);
        }
        return res.blob();
      })
      .then((blob) => {
        if (!cancelled) {
          objectUrl = URL.createObjectURL(blob);
          setBlobUrl(objectUrl);
          setError(null);
        }
      })
      .catch((e) => {
        if (!cancelled) setError(e instanceof Error ? e.message : String(e));
      });

    return () => {
      cancelled = true;
      if (objectUrl) URL.revokeObjectURL(objectUrl);
    };
  }, [proxyUrl]);

  if (error) {
    return (
      <div className="flex items-center gap-2 text-xs text-[var(--color-text-muted)] bg-[var(--color-bg-secondary)] rounded-md px-3 py-2 my-2 border border-[var(--color-border)]/30">
        <ImageIcon className="h-4 w-4 flex-shrink-0" />
        <span className="truncate">Image error ({path}): {error}</span>
      </div>
    );
  }
  if (!blobUrl) return null; // Loading

  return (
    <img
      src={blobUrl}
      alt={alt ?? ''}
      className={className ?? 'max-w-full rounded-md border border-[var(--color-border)]/30 my-2'}
    />
  );
}

// Image component for ReactMarkdown — proxies Databricks paths, falls back to
// a fetch()-based loader so errors are visible rather than silent broken icons.
function MarkdownImg({
  src,
  alt,
}: {
  src?: string;
  alt?: string;
}) {
  if (!src) return null;

  // All Databricks paths go through the proxy with error visibility
  if (isDatabricksFilePath(src) || src.startsWith('/api/workspace/file')) {
    const path = src.startsWith('/api/workspace/file')
      ? decodeURIComponent(new URL(src, window.location.origin).searchParams.get('path') ?? src)
      : src;
    return <DatabricksImage path={path} alt={alt} />;
  }

  // Regular URLs — plain img, retry via proxy on error
  return (
    <img
      src={src}
      alt={alt ?? ''}
      className="max-w-full rounded-md border border-[var(--color-border)]/30 my-2"
      loading="lazy"
      onError={(e) => {
        const img = e.currentTarget;
        if (!img.src.includes('/api/workspace/file')) {
          img.src = toDatabricksProxyUrl(src);
        }
      }}
    />
  );
}

// Shared ReactMarkdown component overrides for all chat bubbles
const markdownComponents: React.ComponentProps<typeof ReactMarkdown>['components'] = {
  a: ({ href, children }) => (
    <a
      href={href}
      target="_blank"
      rel="noopener noreferrer"
      className="text-[var(--color-accent-primary)] underline hover:text-[var(--color-accent-secondary)]"
    >
      {children}
    </a>
  ),
  table: ({ children }) => (
    <div className="overflow-x-auto w-full my-2">
      <table className="min-w-max w-full border-collapse text-[13px]">
        {children}
      </table>
    </div>
  ),
  thead: ({ children }) => (
    <thead className="bg-[var(--color-bg-secondary)]">{children}</thead>
  ),
  th: ({ children }) => (
    <th className="border border-[var(--color-border)] px-3 py-1.5 text-left font-semibold text-[var(--color-text-heading)] whitespace-nowrap">
      {children}
    </th>
  ),
  td: ({ children }) => (
    <td className="border border-[var(--color-border)] px-3 py-1.5 text-[var(--color-text-primary)] whitespace-nowrap">
      {children}
    </td>
  ),
  img: ({ src, alt }) => <MarkdownImg src={src} alt={alt} />,
};

export default function ProjectPage() {
  const { projectId } = useParams<{ projectId: string }>();
  const navigate = useNavigate();
  const { user, workspaceUrl } = useUser();

  // State
  const [project, setProject] = useState<Project | null>(null);
  const [conversations, setConversations] = useState<Conversation[]>([]);
  const [currentConversation, setCurrentConversation] = useState<Conversation | null>(null);
  const [messages, setMessages] = useState<Message[]>([]);
  const [input, setInput] = useState('');
  const [isLoading, setIsLoading] = useState(true);
  const [isStreaming, setIsStreaming] = useState(false);
  const [streamingText, setStreamingText] = useState('');
  const [activityItems, setActivityItems] = useState<ActivityItem[]>([]);
  const [todos, setTodos] = useState<TodoItem[]>([]);
  const [clusters, setClusters] = useState<Cluster[]>([]);
  const [selectedClusterId, setSelectedClusterId] = useState<string | undefined>();
  const [clusterDropdownOpen, setClusterDropdownOpen] = useState(false);
  const [warehouses, setWarehouses] = useState<Warehouse[]>([]);
  const [selectedWarehouseId, setSelectedWarehouseId] = useState<string | undefined>();
  const [warehouseDropdownOpen, setWarehouseDropdownOpen] = useState(false);
  const [userConfig, setUserConfig] = useState<UserSettings | null>(null);
  const [defaultCatalog, setDefaultCatalog] = useState<string>('');
  const [defaultSchema, setDefaultSchema] = useState<string>('');
  const [workspaceFolder, setWorkspaceFolder] = useState<string>('');
  const [mlflowExperimentName, setMlflowExperimentName] = useState<string>('');
  const [skillsExplorerOpen, setSkillsExplorerOpen] = useState(false);
  const [activeExecutionId, setActiveExecutionId] = useState<string | null>(null);
  const [isReconnecting, setIsReconnecting] = useState(false);
  const [verbose, setVerbose] = useState(false);
  const [lastRunActivityItems, setLastRunActivityItems] = useState<ActivityItem[]>([]);
  const [attachedImages, setAttachedImages] = useState<AttachedImage[]>([]);
  const [attachedFiles, setAttachedFiles] = useState<AttachedFile[]>([]);

  // Refs
  const messagesEndRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLTextAreaElement>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const imageInputRef = useRef<HTMLInputElement>(null);
  const abortControllerRef = useRef<AbortController | null>(null);
  const queuedMessagesRef = useRef<QueuedMessage[]>([]);
  const currentConversationIdRef = useRef<string | null>(null);
  const activeStreamingConversationIdRef = useRef<string | null>(null);
  const inProgressByConversationRef = useRef<Record<string, InProgressConversationState>>({});
  const lastRunActivityByConversationRef = useRef<Record<string, ActivityItem[]>>({});
  const clusterDropdownRef = useRef<HTMLDivElement>(null);
  const warehouseDropdownRef = useRef<HTMLDivElement>(null);
  const reconnectAttemptedRef = useRef<string | null>(null); // Track which conversation we've checked
  // True when current conversation was auto-selected (not explicitly chosen by user).
  // If true, first prompt should start a new conversation by default.
  const shouldAutoCreateOnNextSendRef = useRef(false);
  // Accumulates inline image paths during streaming; images are appended after text in the final message.
  const streamingImagesRef = useRef<string[]>([]);
  // Set to true when user sends a new message while streaming (interrupt-and-resend), suppresses cancel toast.
  const isInterruptingRef = useRef(false);

  // Keep queued user messages visually below the response that is currently finishing.
  const insertAssistantBeforeQueued = useCallback(
    (prev: Message[], assistant: Message, conversationId: string | null): Message[] => {
      if (!conversationId) return [...prev, assistant];
      const pendingForConversation = queuedMessagesRef.current.filter(
        (m) => m.conversationId === conversationId
      ).length;
      if (pendingForConversation <= 0) return [...prev, assistant];
      const insertAt = Math.max(prev.length - pendingForConversation, 0);
      return [...prev.slice(0, insertAt), assistant, ...prev.slice(insertAt)];
    },
    []
  );
  // Load project and conversations
  useEffect(() => {
    if (!projectId) return;

    const loadData = async () => {
      try {
        setIsLoading(true);
        const [projectData, conversationsData, clustersData, warehousesData, userSettingsData] = await Promise.all([
          fetchProject(projectId),
          fetchConversations(projectId),
          fetchClusters().catch(() => []), // Don't fail if clusters can't be loaded
          fetchWarehouses().catch(() => []), // Don't fail if warehouses can't be loaded
          fetchUserSettings().catch(() => null),
        ]);
        setProject(projectData);
        setConversations(conversationsData);
        setClusters(clustersData);
        setWarehouses(warehousesData);
        setUserConfig(userSettingsData);

        // Load first conversation if available
        if (conversationsData.length > 0) {
          const conv = await fetchConversation(projectId, conversationsData[0].id);
          setCurrentConversation(conv);
          setMessages(conv.messages || []);
          setLastRunActivityItems(lastRunActivityByConversationRef.current[conv.id] || []);
          shouldAutoCreateOnNextSendRef.current = true;
          // Restore cluster selection from conversation, or default to first cluster
          if (conv.cluster_id) {
            setSelectedClusterId(conv.cluster_id);
          } else if (clustersData.length > 0) {
            setSelectedClusterId(clustersData[0].cluster_id);
          }
          // Restore warehouse selection from conversation, or default to first warehouse
          if (conv.warehouse_id) {
            setSelectedWarehouseId(conv.warehouse_id);
          } else if (warehousesData.length > 0) {
            setSelectedWarehouseId(warehousesData[0].warehouse_id);
          }
          // Restore catalog/schema/folder from conversation, then user config, then empty
          setDefaultCatalog(conv.default_catalog || userSettingsData?.default_catalog || '');
          setDefaultSchema(conv.default_schema || userSettingsData?.default_schema || '');
          setWorkspaceFolder(conv.workspace_folder || userSettingsData?.workspace_folder || '');
        } else {
          shouldAutoCreateOnNextSendRef.current = false;
          // No conversation yet — apply user config defaults
          if (clustersData.length > 0) {
            setSelectedClusterId(clustersData[0].cluster_id);
          }
          if (warehousesData.length > 0) {
            setSelectedWarehouseId(warehousesData[0].warehouse_id);
          }
          setDefaultCatalog(userSettingsData?.default_catalog || '');
          setDefaultSchema(userSettingsData?.default_schema || '');
          setWorkspaceFolder(userSettingsData?.workspace_folder || '');
        }
      } catch (error) {
        console.error('Failed to load project:', error);
        toast.error('Failed to load project');
        navigate('/');
      } finally {
        setIsLoading(false);
      }
    };

    loadData();
  }, [projectId, navigate]);

  // Keep selected conversation ID available to async stream callbacks.
  useEffect(() => {
    currentConversationIdRef.current = currentConversation?.id ?? null;
  }, [currentConversation?.id]);

  // Keep left sidebar conversation title in sync with the chat header.
  useEffect(() => {
    if (!currentConversation?.id || !currentConversation.title) return;
    setConversations((prev) =>
      prev.map((conv) =>
        conv.id === currentConversation.id && conv.title !== currentConversation.title
          ? { ...conv, title: currentConversation.title }
          : conv
      )
    );
  }, [currentConversation?.id, currentConversation?.title]);

  // Check for active execution when conversation loads and reconnect if needed
  useEffect(() => {
    if (!projectId || !currentConversation?.id || isLoading || isStreaming) return;

    // Skip if we've already checked this conversation
    if (reconnectAttemptedRef.current === currentConversation.id) return;
    reconnectAttemptedRef.current = currentConversation.id;

    const checkAndReconnect = async () => {
      try {
        const { active } = await fetchExecutions(projectId, currentConversation.id);

        if (active && active.status === 'running') {
          console.log('[RECONNECT] Found active execution:', active.id);
          setIsReconnecting(true);
          setIsStreaming(true);
          activeStreamingConversationIdRef.current = currentConversation.id;
          setActiveExecutionId(active.id);

          // Create abort controller for reconnection
          abortControllerRef.current = new AbortController();

          let confirmedText = '';
          let deltaText = '';

          const buildDisplayText = () => {
            const base = !confirmedText ? deltaText
              : !deltaText ? confirmedText
              : confirmedText + (confirmedText.endsWith('\n') || deltaText.startsWith('\n') ? '' : '\n\n') + deltaText;
            const imgs = streamingImagesRef.current.map(p => `\n\n![](${p})`).join('');
            return base + imgs;
          };

          await reconnectToExecution({
            executionId: active.id,
            storedEvents: active.events,
            signal: abortControllerRef.current.signal,
            onEvent: (event) => {
              const type = event.type as string;

              if (type === 'text_delta') {
                const text = event.text as string;
                deltaText += text;
                setStreamingText(buildDisplayText());
              } else if (type === 'text') {
                const text = event.text as string;
                if (text) {
                  if (confirmedText && !confirmedText.endsWith('\n') && !text.startsWith('\n')) {
                    confirmedText += '\n\n';
                  }
                  confirmedText += text;
                  deltaText = '';
                  setStreamingText(buildDisplayText());
                }
              } else if (type === 'tool_use') {
                setActivityItems((prev) => [
                  ...prev,
                  {
                    id: event.tool_id as string,
                    type: 'tool_use',
                    content: '',
                    toolName: event.tool_name as string,
                    toolInput: event.tool_input as Record<string, unknown>,
                    timestamp: Date.now(),
                  },
                ]);
              } else if (type === 'tool_result') {
                const resultItem = {
                  id: `result-${event.tool_use_id}`,
                  type: 'tool_result' as const,
                  content: typeof event.content === 'string' ? event.content : JSON.stringify(event.content),
                  isError: event.is_error as boolean,
                  timestamp: Date.now(),
                };
                setActivityItems((prev) => {
                  const idx = prev.findIndex((i) => i.id === resultItem.id);
                  if (idx >= 0) { const u = [...prev]; u[idx] = resultItem; return u; }
                  return [...prev, resultItem];
                });
              } else if (type === 'inline_image') {
                const path = event.path as string;
                if (!streamingImagesRef.current.includes(path)) {
                  streamingImagesRef.current = [...streamingImagesRef.current, path];
                  setStreamingText(buildDisplayText());
                }
              } else if (type === 'todos') {
                const todoItems = event.todos as TodoItem[];
                if (todoItems) {
                  setTodos(todoItems);
                }
              } else if (type === 'keepalive') {
                const elapsed = Number(event.elapsed_since_last_event ?? 0);
                const keepaliveItem: ActivityItem = {
                  id: 'keepalive-latest',
                  type: 'keepalive',
                  content: `Waiting on long-running step... ${Math.max(0, Math.round(elapsed))}s since last update`,
                  timestamp: Date.now(),
                };
                setActivityItems((prev) => {
                  const idx = prev.findIndex((i) => i.id === keepaliveItem.id);
                  if (idx >= 0) {
                    const updated = [...prev];
                    updated[idx] = keepaliveItem;
                    return updated;
                  }
                  return [...prev, keepaliveItem];
                });
              } else if (type === 'error') {
                toast.error(event.error as string, { duration: 8000 });
              }
            },
            onError: (error) => {
              console.error('Reconnect error:', error);
              // Clean up streaming state so UI doesn't get stuck
              setIsStreaming(false);
              activeStreamingConversationIdRef.current = null;
              setIsReconnecting(false);
              setActiveExecutionId(null);
              setStreamingText('');
              setActivityItems([]);
              // Only show a toast for unexpected errors, not stream-not-found
              // (which is normal after a server redeploy)
              const msg = error.message ?? '';
              if (!msg.includes('Stream not found') && !msg.includes('404')) {
                toast.error('Lost connection to agent execution', { duration: 5000 });
              }
            },
            onDone: async () => {
              // Reload conversation to get the final messages from DB.
              // Wrap in try/catch so a network error here doesn't leave
              // isStreaming / isReconnecting permanently stuck.
              try {
                const conv = await fetchConversation(projectId, currentConversation.id);
                setCurrentConversation(conv);
                setMessages(conv.messages || []);
              } catch (e) {
                console.error('Failed to reload conversation after reconnect:', e);
              }
              // Always clear streaming state regardless of the fetch result
              setStreamingText('');
              setIsStreaming(false);
              setIsReconnecting(false);
              setActiveExecutionId(null);
              setActivityItems((current) => {
                if (currentConversation.id) {
                  lastRunActivityByConversationRef.current[currentConversation.id] = current;
                }
                setLastRunActivityItems(current);
                return [];
              });
              setTodos([]);
            },
          });
        }
      } catch (error) {
        console.error('Failed to check for active executions:', error);
        // Always clean up streaming state so UI doesn't get stuck
        setIsStreaming(false);
        activeStreamingConversationIdRef.current = null;
        setIsReconnecting(false);
        setActiveExecutionId(null);
        setStreamingText('');
        setActivityItems([]);
      }
    };

    checkAndReconnect();
  }, [projectId, currentConversation?.id, isLoading, isStreaming]);

  // Scroll to bottom when messages change
  useEffect(() => {
    messagesEndRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [messages, streamingText, activityItems]);

  // Close dropdowns on outside click
  useEffect(() => {
    const handleClickOutside = (event: MouseEvent) => {
      if (clusterDropdownRef.current && !clusterDropdownRef.current.contains(event.target as Node)) {
        setClusterDropdownOpen(false);
      }
      if (warehouseDropdownRef.current && !warehouseDropdownRef.current.contains(event.target as Node)) {
        setWarehouseDropdownOpen(false);
      }
    };
    document.addEventListener('mousedown', handleClickOutside);
    return () => document.removeEventListener('mousedown', handleClickOutside);
  }, []);

  // Select a conversation
  const handleSelectConversation = async (conversationId: string) => {
    if (!projectId || currentConversation?.id === conversationId) return;

    // Reset reconnect tracking for the new conversation
    reconnectAttemptedRef.current = null;

    try {
      shouldAutoCreateOnNextSendRef.current = false;
      const conv = await fetchConversation(projectId, conversationId);
      const inProgress = inProgressByConversationRef.current[conversationId];
      const baseMessages = conv.messages || [];
      const viewMessages = inProgress?.userMessage
        ? [...baseMessages, inProgress.userMessage, ...(inProgress.queuedMessages || [])]
        : baseMessages;

      setCurrentConversation(conv);
      setMessages(viewMessages);
      setStreamingText(
        inProgress && activeStreamingConversationIdRef.current === conversationId
          ? inProgress.streamingText
          : ''
      );
      setActivityItems([]);
      setLastRunActivityItems(lastRunActivityByConversationRef.current[conversationId] || []);
      // Restore cluster selection from conversation, or default to first cluster
      setSelectedClusterId(conv.cluster_id || (clusters.length > 0 ? clusters[0].cluster_id : undefined));
      // Restore warehouse selection from conversation, or default to first warehouse
      setSelectedWarehouseId(conv.warehouse_id || (warehouses.length > 0 ? warehouses[0].warehouse_id : undefined));
      // Restore catalog/schema/folder from conversation, then user config, then empty
      setDefaultCatalog(conv.default_catalog || userConfig?.default_catalog || '');
      setDefaultSchema(conv.default_schema || userConfig?.default_schema || '');
      setWorkspaceFolder(conv.workspace_folder || userConfig?.workspace_folder || '');
    } catch (error) {
      console.error('Failed to load conversation:', error);
      toast.error('Failed to load conversation');
    }
  };

  // Create new conversation
  const handleNewConversation = async () => {
    if (!projectId) return;

    try {
      shouldAutoCreateOnNextSendRef.current = false;
      const conv = await createConversation(projectId);
      setConversations((prev) => [conv, ...prev]);
      setCurrentConversation(conv);
      setMessages([]);
      setActivityItems([]);
      setLastRunActivityItems([]);
      // Reset to user config defaults for new conversations
      setDefaultCatalog(userConfig?.default_catalog || '');
      setDefaultSchema(userConfig?.default_schema || '');
      setWorkspaceFolder(userConfig?.workspace_folder || '');
      inputRef.current?.focus();
    } catch (error) {
      console.error('Failed to create conversation:', error);
      toast.error('Failed to create conversation');
    }
  };

  // Delete conversation
  const handleDeleteConversation = async (conversationId: string) => {
    if (!projectId) return;

    try {
      await deleteConversation(projectId, conversationId);
      setConversations((prev) => prev.filter((c) => c.id !== conversationId));
      delete lastRunActivityByConversationRef.current[conversationId];

      if (currentConversation?.id === conversationId) {
        const remaining = conversations.filter((c) => c.id !== conversationId);
        if (remaining.length > 0) {
          const conv = await fetchConversation(projectId, remaining[0].id);
          setCurrentConversation(conv);
          setMessages(conv.messages || []);
          setLastRunActivityItems(lastRunActivityByConversationRef.current[conv.id] || []);
          shouldAutoCreateOnNextSendRef.current = true;
        } else {
          setCurrentConversation(null);
          setMessages([]);
          setLastRunActivityItems([]);
          shouldAutoCreateOnNextSendRef.current = false;
        }
        setActivityItems([]);
      }
      toast.success('Conversation deleted');
    } catch (error) {
      console.error('Failed to delete conversation:', error);
      toast.error('Failed to delete conversation');
    }
  };

  const sendPreparedMessage = useCallback(async (
    prepared: QueuedMessage,
    addUserMessage: boolean = true
  ) => {
    const { conversationId: targetConversationId, userMessage, displayContent, imagesToSend } = prepared;
    if (!projectId) return;

    isInterruptingRef.current = false;
    activeStreamingConversationIdRef.current = targetConversationId;
    setIsStreaming(true);
    setStreamingText('');
    setActivityItems([]);
    setLastRunActivityItems([]);
    streamingImagesRef.current = [];
    setTodos([]);

    if (addUserMessage) {
      const tempUserMessage: Message = {
        id: `temp-${Date.now()}`,
        conversation_id: targetConversationId || '',
        role: 'user',
        content: displayContent,
        timestamp: new Date().toISOString(),
        is_error: false,
      };
      setMessages((prev) => [...prev, tempUserMessage]);
      const progressKey = targetConversationId ?? PENDING_CONVERSATION_KEY;
      const existing = inProgressByConversationRef.current[progressKey] ?? { streamingText: '' };
      inProgressByConversationRef.current[progressKey] = {
        ...existing,
        userMessage: tempUserMessage,
      };

    }

    abortControllerRef.current = new AbortController();

    try {
      let conversationId = targetConversationId;
      // confirmedText: authoritative text from completed text events (with proper separators)
      // deltaText: accumulated text_delta tokens for the current in-progress block
      let confirmedText = '';
      let deltaText = '';

      const buildDisplayText = () => {
        const base = !confirmedText ? deltaText
          : !deltaText ? confirmedText
          : confirmedText + (confirmedText.endsWith('\n') || deltaText.startsWith('\n') ? '' : '\n\n') + deltaText;
        const imgs = streamingImagesRef.current.map(p => `\n\n![](${p})`).join('');
        return base + imgs;
      };

      await invokeAgent({
        projectId,
        conversationId,
        message: userMessage,
        images: imagesToSend.length > 0 ? imagesToSend : null,
        clusterId: selectedClusterId,
        defaultCatalog,
        defaultSchema,
        warehouseId: selectedWarehouseId,
        workspaceFolder,
        mlflowExperimentName: mlflowExperimentName || null,
        signal: abortControllerRef.current.signal,
        onExecutionId: (executionId) => setActiveExecutionId(executionId),
        onEvent: (event) => {
          const type = event.type as string;

          if (type === 'conversation.created') {
            conversationId = event.conversation_id as string;
            shouldAutoCreateOnNextSendRef.current = false;
            // If this execution started before the conversation was created
            // (conversationId was null), bind streaming ownership to the new ID
            // so onDone/onError can clear streaming state correctly.
            if (activeStreamingConversationIdRef.current === null) {
              activeStreamingConversationIdRef.current = conversationId;
            }
            const pending = inProgressByConversationRef.current[PENDING_CONVERSATION_KEY];
            if (pending) {
              inProgressByConversationRef.current[conversationId] = pending;
              delete inProgressByConversationRef.current[PENDING_CONVERSATION_KEY];
            }
          } else if (type === 'text_delta') {
            // Token-by-token streaming - accumulate delta for current block
            const text = event.text as string;
            deltaText += text;
            if (conversationId) {
              const existing = inProgressByConversationRef.current[conversationId] ?? { streamingText: '' };
              inProgressByConversationRef.current[conversationId] = {
                ...existing,
                streamingText: buildDisplayText(),
              };
            }
            if (currentConversationIdRef.current === conversationId) setStreamingText(buildDisplayText());
          } else if (type === 'text') {
            // Complete text block from AssistantMessage - authoritative content for one block.
            // Add it to confirmedText (with separator) and reset the delta so that
            // future text_delta events for the NEXT block don't concatenate directly.
            const text = event.text as string;
            if (text) {
              if (confirmedText && !confirmedText.endsWith('\n') && !text.startsWith('\n')) {
                confirmedText += '\n\n';
              }
              confirmedText += text;
              deltaText = '';  // Block confirmed - clear delta so next block starts fresh
              if (conversationId) {
                const existing = inProgressByConversationRef.current[conversationId] ?? { streamingText: '' };
                inProgressByConversationRef.current[conversationId] = {
                  ...existing,
                  streamingText: buildDisplayText(),
                };
              }
              if (currentConversationIdRef.current === conversationId) setStreamingText(buildDisplayText());
            }
          } else if (type === 'thinking' || type === 'thinking_delta') {
            // Handle both complete thinking blocks and streaming thinking deltas.
            // The SDK emits thinking_delta events first (streaming), then a complete
            // thinking event from AssistantMessage. We must not add a second item —
            // instead replace the delta-built item with the authoritative complete block.
            const thinking = (event.thinking as string) || '';
            if (thinking && currentConversationIdRef.current === conversationId) {
              setActivityItems((prev) => {
                const lastItem = prev.length > 0 ? prev[prev.length - 1] : null;
                if (lastItem?.type === 'thinking') {
                  const updated = [...prev];
                  if (type === 'thinking_delta') {
                    // Append delta token to existing thinking item
                    updated[updated.length - 1] = { ...lastItem, content: lastItem.content + thinking };
                  } else {
                    // Complete block: replace delta-built item (prevents duplication)
                    updated[updated.length - 1] = { ...lastItem, content: thinking };
                  }
                  return updated;
                }
                // No existing thinking item — create a new one
                return [
                  ...prev,
                  {
                    id: `thinking-${Date.now()}`,
                    type: 'thinking',
                    content: thinking,
                    timestamp: Date.now(),
                  },
                ];
              });
            }
          } else if (type === 'tool_use') {
            if (currentConversationIdRef.current === conversationId) {
              setActivityItems((prev) => [
                ...prev,
                {
                  id: event.tool_id as string,
                  type: 'tool_use',
                  content: '',
                  toolName: event.tool_name as string,
                  toolInput: event.tool_input as Record<string, unknown>,
                  timestamp: Date.now(),
                },
              ]);
            }
          } else if (type === 'tool_result') {
            let content = event.content as string;

            // Parse and improve error messages
            if (event.is_error && typeof content === 'string') {
              // Extract error from XML-style tags like <tool_use_error>...</tool_use_error>
              const errorMatch = content.match(/<tool_use_error>(.*?)<\/tool_use_error>/s);
              if (errorMatch) {
                content = errorMatch[1].trim();
              }

              // Improve generic "Stream closed" errors
              if (content === 'Stream closed' || content.includes('Stream closed')) {
                content = 'Tool execution interrupted: The operation took too long or the connection was lost. This may happen when operations exceed the 50-second timeout window. Check backend logs for details.';
              }
            }

            const resultItem = {
              id: `result-${event.tool_use_id}`,
              type: 'tool_result' as const,
              content: typeof content === 'string' ? content : JSON.stringify(content),
              isError: event.is_error as boolean,
              timestamp: Date.now(),
            };
            if (currentConversationIdRef.current === conversationId) {
              setActivityItems((prev) => {
                const idx = prev.findIndex((i) => i.id === resultItem.id);
                if (idx >= 0) { const u = [...prev]; u[idx] = resultItem; return u; }
                return [...prev, resultItem];
              });
            }
          } else if (type === 'error') {
            let errorMsg = event.error as string;

            // Improve generic error messages
            if (errorMsg === 'Stream closed' || errorMsg.includes('Stream closed')) {
              errorMsg = 'Execution interrupted: The operation took too long or the connection was lost. Operations exceeding 50 seconds may be interrupted. Check backend logs for details.';
            }

            toast.error(errorMsg, {
              duration: 8000,
            });
          } else if (type === 'inline_image') {
            const path = event.path as string;
            if (!streamingImagesRef.current.includes(path)) {
              streamingImagesRef.current = [...streamingImagesRef.current, path];
              if (currentConversationIdRef.current === conversationId) setStreamingText(buildDisplayText());
            }
          } else if (type === 'cancelled') {
            // Suppress toast when user cancelled by sending a new message
            if (!isInterruptingRef.current) toast.info('Generation stopped');
          } else if (type === 'todos') {
            // Update todo list from agent
            const todoItems = event.todos as TodoItem[];
            if (todoItems && currentConversationIdRef.current === conversationId) {
              setTodos(todoItems);
            }
          } else if (type === 'keepalive') {
            const elapsed = Number(event.elapsed_since_last_event ?? 0);
            if (currentConversationIdRef.current === conversationId) {
              const keepaliveItem: ActivityItem = {
                id: 'keepalive-latest',
                type: 'keepalive',
                content: `Waiting on long-running step... ${Math.max(0, Math.round(elapsed))}s since last update`,
                timestamp: Date.now(),
              };
              setActivityItems((prev) => {
                const idx = prev.findIndex((i) => i.id === keepaliveItem.id);
                if (idx >= 0) {
                  const updated = [...prev];
                  updated[idx] = keepaliveItem;
                  return updated;
                }
                return [...prev, keepaliveItem];
              });
            }
          }
        },
        onError: (error) => {
          console.error('Stream error:', error);
          // Show the actual error message instead of generic text
          const errorMessage = error.message || 'Failed to get response';
          toast.error(errorMessage, {
            duration: 8000, // Show error for 8 seconds
          });
        },
        onDone: async () => {
          const fullText = confirmedText || deltaText;
          const images = streamingImagesRef.current;
          streamingImagesRef.current = [];
          const imageMarkdown = images
            .filter((p) => !fullText.includes(`](${p})`))
            .map((p) => `![](${p})`)
            .join('\n\n');
          const content = [fullText, imageMarkdown].filter(Boolean).join('\n\n');
          if (content && currentConversationIdRef.current === conversationId) {
            setMessages((prev) =>
              insertAssistantBeforeQueued(
                prev,
                {
                  id: `msg-${Date.now()}`,
                  conversation_id: conversationId || '',
                  role: 'assistant',
                  content,
                  timestamp: new Date().toISOString(),
                  is_error: false,
                },
                conversationId
              )
            );
          }
          if (currentConversationIdRef.current === conversationId) setStreamingText('');
          if (activeStreamingConversationIdRef.current === conversationId) {
            setIsStreaming(false);
            activeStreamingConversationIdRef.current = null;
          }
          if (conversationId) {
            delete inProgressByConversationRef.current[conversationId];
          }
          delete inProgressByConversationRef.current[PENDING_CONVERSATION_KEY];
          setActiveExecutionId(null);
          // Save activity items for verbose display, then clear live items
          if (currentConversationIdRef.current === conversationId) {
            setActivityItems((current) => {
              if (conversationId) {
                lastRunActivityByConversationRef.current[conversationId] = current;
              }
              setLastRunActivityItems(current);
              return [];
            });
            setTodos([]);
          }

          if (conversationId && !currentConversationIdRef.current) {
            const conv = await fetchConversation(projectId, conversationId);
            setCurrentConversation(conv);
          }

          // Refresh conversations after the run finishes so sidebar updates
          // follow the finalized header/title timing.
          fetchConversations(projectId).then(setConversations).catch(() => undefined);

          // Queue is per-conversation. Only continue queued messages for this chat.
          const nextIdx = queuedMessagesRef.current.findIndex((m) => m.conversationId === conversationId);
          const next = nextIdx >= 0 ? queuedMessagesRef.current.splice(nextIdx, 1)[0] : undefined;
          if (next) {
            toast.info(`Sending queued message (${queuedMessagesRef.current.length} remaining)...`);
            void sendPreparedMessage(next, false);
          }
        },
      });
    } catch (error) {
      // Ignore AbortError — handleStopGeneration handles cleanup for user-initiated stops
      if (error instanceof Error && error.name === 'AbortError') return;
      console.error('Failed to send message:', error);
      const errorMessage = error instanceof Error ? error.message : 'Failed to send message';
      toast.error(errorMessage, {
        duration: 8000,
      });
      if (activeStreamingConversationIdRef.current === targetConversationId) {
        setIsStreaming(false);
        activeStreamingConversationIdRef.current = null;
      }
      if (targetConversationId) {
        delete inProgressByConversationRef.current[targetConversationId];
      }
      delete inProgressByConversationRef.current[PENDING_CONVERSATION_KEY];

      const nextIdx = queuedMessagesRef.current.findIndex((m) => m.conversationId === targetConversationId);
      const next = nextIdx >= 0 ? queuedMessagesRef.current.splice(nextIdx, 1)[0] : undefined;
      if (next) {
        toast.info(`Sending queued message (${queuedMessagesRef.current.length} remaining)...`);
        void sendPreparedMessage(next, false);
      }
    }
  }, [projectId, currentConversation?.id, selectedClusterId, defaultCatalog, defaultSchema, selectedWarehouseId, workspaceFolder, mlflowExperimentName]);

  // Start an execution without streaming (used when another chat is currently streaming).
  const sendBackgroundMessage = useCallback(async (
    prepared: QueuedMessage,
    addUserMessage: boolean = true
  ) => {
    if (!projectId) return;
    const { conversationId, userMessage, displayContent, imagesToSend } = prepared;

    if (addUserMessage) {
      setMessages((prev) => [
        ...prev,
        {
          id: `temp-bg-${Date.now()}`,
          conversation_id: conversationId || '',
          role: 'user',
          content: displayContent,
          timestamp: new Date().toISOString(),
          is_error: false,
        },
      ]);
    }

    const res = await fetch('/api/invoke_agent', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      credentials: 'include',
      body: JSON.stringify({
        project_id: projectId,
        conversation_id: conversationId ?? null,
        message: userMessage,
        images: imagesToSend.length > 0 ? imagesToSend : null,
        cluster_id: selectedClusterId ?? null,
        default_catalog: defaultCatalog ?? null,
        default_schema: defaultSchema ?? null,
        warehouse_id: selectedWarehouseId ?? null,
        workspace_folder: workspaceFolder ?? null,
        mlflow_experiment_name: mlflowExperimentName || null,
      }),
    });

    if (!res.ok) {
      const errBody = await res.json().catch(() => ({}));
      const message = (errBody.detail ?? res.statusText) as string;
      throw new Error(typeof message === 'string' ? message : JSON.stringify(message));
    }
  }, [projectId, selectedClusterId, defaultCatalog, defaultSchema, selectedWarehouseId, workspaceFolder, mlflowExperimentName]);

  // Send message — allows new messages while streaming by queueing them.
  const handleSendMessage = useCallback(async () => {
    const hasContent = input.trim() || attachedImages.length > 0 || attachedFiles.length > 0;
    if (!projectId || !hasContent) return;

    const userText = input.trim();
    setInput('');

    // Capture and clear attachments
    const imagesToSend = attachedImages.map((img): ImageAttachment => ({
      type: 'base64',
      media_type: img.mediaType,
      data: img.data,
    }));
    const filesToSend = [...attachedFiles];
    setAttachedImages([]);
    setAttachedFiles([]);

    // Upload attached files into project-local uploads folder and send paths only.
    const uploadedFilePaths: string[] = [];
    for (const attached of filesToSend) {
      try {
        const uploaded = await uploadProjectFile(projectId, attached.file);
        uploadedFilePaths.push(uploaded.path);
      } catch (error) {
        const msg = error instanceof Error ? error.message : String(error);
        toast.error(`Failed to upload "${attached.file.name}": ${msg}`);
      }
    }

    // Build the actual message sent to the agent (text + uploaded local file paths)
    let agentMessage = userText;
    if (uploadedFilePaths.length > 0) {
      agentMessage += `\n\n--- Attached local files (project paths) ---\n${uploadedFilePaths.map((p) => `- ${p}`).join('\n')}\nUse these file paths and read files by path when needed. Do not ask for file contents unless required.\n---`;
    }

    // Build the display message shown in chat
    const attachmentParts: string[] = [];
    if (imagesToSend.length > 0) attachmentParts.push(`📷 ${imagesToSend.length} image${imagesToSend.length > 1 ? 's' : ''}`);
    if (uploadedFilePaths.length > 0) attachmentParts.push(`📎 ${uploadedFilePaths.join(', ')}`);
    const displayContent = [userText, attachmentParts.join(' · ')].filter(Boolean).join('\n');
    const userMessage = agentMessage.trim() || userText;
    if (!userMessage && imagesToSend.length === 0) {
      toast.error('No content to send (file upload failed)');
      return;
    }

    const shouldCreateNewConversationNow =
      shouldAutoCreateOnNextSendRef.current && !!currentConversation?.id;
    if (shouldCreateNewConversationNow) {
      // Clear the auto-selected conversation view; this prompt starts a new chat.
      setCurrentConversation(null);
      setMessages([]);
      setActivityItems([]);
      setLastRunActivityItems([]);
      setStreamingText('');
      shouldAutoCreateOnNextSendRef.current = false;
    }

    const prepared: QueuedMessage = {
      conversationId: shouldCreateNewConversationNow ? null : (currentConversation?.id ?? null),
      userMessage,
      displayContent,
      imagesToSend,
    };

    // If the same conversation is already streaming, queue in that conversation only.
    if (isStreaming) {
      if (activeStreamingConversationIdRef.current === prepared.conversationId) {
        queuedMessagesRef.current.push(prepared);
        const queuedUserMessage: Message = {
          id: `temp-queued-${Date.now()}`,
          conversation_id: currentConversation?.id || '',
          role: 'user',
          content: displayContent,
          timestamp: new Date().toISOString(),
          is_error: false,
        };
        setMessages((prev) => [...prev, queuedUserMessage]);
        const progressKey = prepared.conversationId ?? PENDING_CONVERSATION_KEY;
        const existing = inProgressByConversationRef.current[progressKey] ?? { streamingText: '' };
        inProgressByConversationRef.current[progressKey] = {
          ...existing,
          queuedMessages: [...(existing.queuedMessages || []), queuedUserMessage],
        };
        toast.info(`Queued in this chat (${queuedMessagesRef.current.length} waiting)`);
        return;
      }

      // Different chat: run independently instead of cross-chat queueing.
      try {
        await sendBackgroundMessage(prepared, true);
      } catch (error) {
        const msg = error instanceof Error ? error.message : String(error);
        toast.error(msg, { duration: 8000 });
      }
      return;
    }

    await sendPreparedMessage(prepared, true);
  }, [projectId, input, attachedImages, attachedFiles, isStreaming, currentConversation?.id, sendPreparedMessage, sendBackgroundMessage]);

  // Stop generation - abort client stream AND tell backend to cancel
  const handleStopGeneration = useCallback(async () => {
    abortControllerRef.current?.abort();

    // Tell the backend to cancel the agent execution
    if (activeExecutionId) {
      try {
        await stopExecution(activeExecutionId);
      } catch (error) {
        console.error('Failed to stop execution on backend:', error);
      }
    }

    // Finalize UI: keep user message and save whatever partial response we have
    setStreamingText((currentText) => {
      if (currentText) {
        setMessages((prev) =>
          insertAssistantBeforeQueued(
            prev,
            {
              id: `msg-stopped-${Date.now()}`,
              conversation_id: '',
              role: 'assistant' as const,
              content: currentText,
              timestamp: new Date().toISOString(),
              is_error: false,
            },
            activeStreamingConversationIdRef.current
          )
        );
      }
      return '';
    });
    const stoppedConversationId = activeStreamingConversationIdRef.current;
    if (stoppedConversationId) {
      const before = queuedMessagesRef.current.length;
      queuedMessagesRef.current = queuedMessagesRef.current.filter(
        (m) => m.conversationId !== stoppedConversationId
      );
      const removed = before - queuedMessagesRef.current.length;
      if (removed > 0) {
        toast.info(`Cleared ${removed} queued message${removed > 1 ? 's' : ''} for this chat`);
      }
      delete inProgressByConversationRef.current[stoppedConversationId];
      setMessages((prev) =>
        prev.filter(
          (m) =>
            !(m.id.startsWith('temp-queued-') && m.conversation_id === stoppedConversationId)
        )
      );
    }
    delete inProgressByConversationRef.current[PENDING_CONVERSATION_KEY];
    setIsStreaming(false);
    activeStreamingConversationIdRef.current = null;
    setActiveExecutionId(null);
    setActivityItems((current) => {
      if (stoppedConversationId) {
        lastRunActivityByConversationRef.current[stoppedConversationId] = current;
      }
      setLastRunActivityItems(current);
      return [];
    });
    setTodos([]);
  }, [activeExecutionId, insertAssistantBeforeQueued]);

  // Handle keyboard submit
  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      handleSendMessage();
    }
  };

  // Handle paste — intercept image pastes from clipboard
  const handlePaste = useCallback((e: React.ClipboardEvent<HTMLTextAreaElement>) => {
    const items = e.clipboardData?.items;
    if (!items) return;
    const imageFiles: File[] = [];
    for (const item of items) {
      if (item.type.startsWith('image/')) {
        const file = item.getAsFile();
        if (file) imageFiles.push(file);
      }
    }
    if (imageFiles.length > 0) {
      e.preventDefault();
      handleAddImages(imageFiles);
    }
  }, []);

  // Process and add image files
  const handleAddImages = useCallback(async (files: File[]) => {
    const valid = files.filter((f) => {
      if (!SUPPORTED_IMAGE_TYPES.includes(f.type)) {
        toast.error(`Unsupported image type: ${f.type}`);
        return false;
      }
      if (f.size > MAX_IMAGE_SIZE) {
        toast.error(`Image too large (max 20MB): ${f.name}`);
        return false;
      }
      return true;
    });
    if (valid.length === 0) return;

    const newImages = await Promise.all(
      valid.map(async (file) => {
        const preview = URL.createObjectURL(file);
        const { data, mediaType } = await readImageAsBase64(file);
        return { id: crypto.randomUUID(), file, preview, data, mediaType };
      })
    );
    setAttachedImages((prev) => [...prev, ...newImages].slice(0, 5)); // max 5 images
  }, []);

  // Handle image file input change
  const handleImageChange = useCallback(
    (e: React.ChangeEvent<HTMLInputElement>) => {
      const files = e.target.files;
      if (files && files.length > 0) handleAddImages(Array.from(files));
      e.target.value = '';
    },
    [handleAddImages]
  );

  // Process text files — mirrors handleAddImages pattern (start FileReader synchronously)
  const handleAddFiles = useCallback(async (files: File[]) => {
    const queued = files.map((file) => ({ id: crypto.randomUUID(), file }));
    if (queued.length > 0) setAttachedFiles((prev) => [...prev, ...queued]);
  }, []);

  // Handle text file input change — mirrors handleImageChange exactly
  const handleFileChange = useCallback(
    (e: React.ChangeEvent<HTMLInputElement>) => {
      const files = e.target.files;
      if (files && files.length > 0) handleAddFiles(Array.from(files));
      e.target.value = '';
    },
    [handleAddFiles]
  );

  // Open skills explorer
  const handleViewSkills = () => {
    setSkillsExplorerOpen(true);
  };

  if (isLoading) {
    return (
      <MainLayout projectName={project?.name}>
        <div className="flex h-full items-center justify-center">
          <Loader2 className="h-8 w-8 animate-spin text-[var(--color-text-muted)]" />
        </div>
      </MainLayout>
    );
  }

  const queuedMessageIdPrefix = 'temp-queued-';
  const currentConversationId = currentConversation?.id ?? null;
  const isCurrentConversationStreaming =
    isStreaming && (
      activeStreamingConversationIdRef.current === currentConversationId
      || currentConversationId === null
    );
  const nonQueuedMessages = isCurrentConversationStreaming
    ? messages.filter((message) => !message.id.startsWith(queuedMessageIdPrefix))
    : messages;
  const queuedMessages = isCurrentConversationStreaming
    ? messages.filter((message) => message.id.startsWith(queuedMessageIdPrefix))
    : [];

  const sidebar = (
    <Sidebar
      conversations={conversations}
      currentConversationId={currentConversation?.id}
      onConversationSelect={handleSelectConversation}
      onNewConversation={handleNewConversation}
      onDeleteConversation={handleDeleteConversation}
      onViewSkills={handleViewSkills}
      isLoading={false}
    />
  );

  return (
    <MainLayout projectName={project?.name} sidebar={sidebar}>
      <div className="flex flex-1 flex-col h-full">
        {/* Chat Header - always show configuration controls */}
        <div className="flex h-14 items-center justify-between border-b border-[var(--color-border)] px-6 bg-[var(--color-bg-secondary)]/50">
          <h2 className="font-medium text-[var(--color-text-heading)] truncate max-w-[150px] flex-shrink-0">
            {currentConversation?.title || 'New Chat'}
          </h2>
          <div className="flex items-center gap-2 flex-1 min-w-0 justify-end">
              {/* Catalog.Schema Input */}
              <div className="flex items-center h-8 w-[200px] flex-shrink-0 rounded-md border border-[var(--color-border)] bg-[var(--color-background)] focus-within:ring-2 focus-within:ring-[var(--color-accent-primary)]/50">
                <div className="flex items-center justify-center w-8 h-full border-r border-[var(--color-border)] bg-[var(--color-bg-secondary)]/50 rounded-l-md flex-shrink-0">
                  <svg className="w-4 h-4 text-[var(--color-text-muted)]" viewBox="0 0 16 16" fill="none" xmlns="http://www.w3.org/2000/svg">
                    <path fill="currentColor" fillRule="evenodd" d="M8.646.368a.75.75 0 0 0-1.292 0l-3.25 5.5A.75.75 0 0 0 4.75 7h6.5a.75.75 0 0 0 .646-1.132zM8 2.224 9.936 5.5H6.064zM8.5 9.25a.75.75 0 0 1 .75-.75h5a.75.75 0 0 1 .75.75v5a.75.75 0 0 1-.75.75h-5a.75.75 0 0 1-.75-.75zM10 10v3.5h3.5V10zM1 11.75a3.25 3.25 0 1 1 6.5 0 3.25 3.25 0 0 1-6.5 0M4.25 10a1.75 1.75 0 1 0 0 3.5 1.75 1.75 0 0 0 0-3.5" clipRule="evenodd" />
                  </svg>
                </div>
                <input
                  type="text"
                  value={defaultCatalog}
                  onChange={(e) => setDefaultCatalog(e.target.value)}
                  placeholder="catalog"
                  className="h-full w-[70px] flex-shrink-0 px-2 bg-transparent text-xs text-[var(--color-text-primary)] placeholder:text-[var(--color-text-muted)] focus:outline-none overflow-hidden text-ellipsis"
                  title={defaultCatalog || 'Default catalog'}
                />
                <span className="text-[var(--color-text-muted)] text-xs flex-shrink-0">.</span>
                <input
                  type="text"
                  value={defaultSchema}
                  onChange={(e) => setDefaultSchema(e.target.value)}
                  placeholder="schema"
                  className="h-full w-[90px] flex-shrink-0 px-2 bg-transparent text-xs text-[var(--color-text-primary)] placeholder:text-[var(--color-text-muted)] focus:outline-none overflow-hidden text-ellipsis"
                  title={defaultSchema || 'Default schema'}
                />
              </div>
              {/* Cluster Dropdown */}
              {clusters.length > 0 && (
              <div className="relative" ref={clusterDropdownRef}>
                <button
                  onClick={() => setClusterDropdownOpen(!clusterDropdownOpen)}
                  className="flex items-center h-8 rounded-md border border-[var(--color-border)] bg-[var(--color-background)] text-xs text-[var(--color-text-primary)] hover:bg-[var(--color-bg-secondary)]/30 focus:outline-none focus:ring-2 focus:ring-[var(--color-accent-primary)]/50 transition-colors"
                  title="Cluster for code execution"
                >
                  <div className="flex items-center justify-center w-8 h-full border-r border-[var(--color-border)] bg-[var(--color-bg-secondary)]/50 rounded-l-md">
                    <svg className="w-4 h-4 text-[var(--color-text-muted)]" viewBox="0 0 16 16" fill="none" xmlns="http://www.w3.org/2000/svg">
                      <path fill="currentColor" fillRule="evenodd" d="M3.394 5.586a4.752 4.752 0 0 1 9.351.946 3.75 3.75 0 0 1-.668 7.464L12 14H4a.8.8 0 0 1-.179-.021 4.25 4.25 0 0 1-.427-8.393m.72 6.914h7.762a.8.8 0 0 1 .186-.008q.092.008.188.008a2.25 2.25 0 0 0 0-4.5H12a.75.75 0 0 1-.75-.75v-.5a3.25 3.25 0 0 0-6.475-.402.75.75 0 0 1-.698.657 2.75 2.75 0 0 0-.024 5.488z" clipRule="evenodd" />
                    </svg>
                  </div>
                  <div className="flex items-center gap-2 px-2">
                    {(() => {
                      const selected = clusters.find(c => c.cluster_id === selectedClusterId);
                      return selected ? (
                        <>
                          <span className={cn(
                            'w-2 h-2 rounded-full',
                            selected.state === 'RUNNING' ? 'bg-[var(--color-success)]' : 'bg-[var(--color-text-muted)]'
                          )} />
                          <span className="max-w-[100px] truncate">{selected.cluster_name}</span>
                        </>
                      ) : (
                        <span className="text-[var(--color-text-muted)]">Cluster...</span>
                      );
                    })()}
                    <ChevronDown className={cn('w-3 h-3 transition-transform', clusterDropdownOpen && 'rotate-180')} />
                  </div>
                </button>
                {clusterDropdownOpen && (
                  <div className="absolute right-0 top-full mt-1 w-72 max-h-64 overflow-y-auto rounded-md border border-[var(--color-border)] bg-[var(--color-background)] shadow-lg z-50">
                    {clusters.map((cluster) => (
                      <button
                        key={cluster.cluster_id}
                        onClick={() => {
                          setSelectedClusterId(cluster.cluster_id);
                          setClusterDropdownOpen(false);
                        }}
                        className={cn(
                          'w-full flex items-center gap-2 px-3 py-2 text-xs text-left hover:bg-[var(--color-bg-secondary)] transition-colors',
                          selectedClusterId === cluster.cluster_id && 'bg-[var(--color-bg-secondary)]'
                        )}
                      >
                        <span className={cn(
                          'w-2 h-2 rounded-full flex-shrink-0',
                          cluster.state === 'RUNNING' ? 'bg-[var(--color-success)]' : 'bg-[var(--color-text-muted)]'
                        )} />
                        <span className="truncate text-[var(--color-text-primary)]">{cluster.cluster_name}</span>
                      </button>
                    ))}
                  </div>
                )}
              </div>
              )}
              {/* Warehouse Dropdown */}
              {warehouses.length > 0 && (
              <div className="relative" ref={warehouseDropdownRef}>
                <button
                  onClick={() => setWarehouseDropdownOpen(!warehouseDropdownOpen)}
                  className="flex items-center h-8 rounded-md border border-[var(--color-border)] bg-[var(--color-background)] text-xs text-[var(--color-text-primary)] hover:bg-[var(--color-bg-secondary)]/30 focus:outline-none focus:ring-2 focus:ring-[var(--color-accent-primary)]/50 transition-colors"
                  title="SQL Warehouse for queries"
                >
                  <div className="flex items-center justify-center w-8 h-full border-r border-[var(--color-border)] bg-[var(--color-bg-secondary)]/50 rounded-l-md">
                    <svg className="w-4 h-4 text-[var(--color-text-muted)]" viewBox="0 0 16 16" fill="none" xmlns="http://www.w3.org/2000/svg">
                      <path d="M13 13.75C13 14.5784 11.6569 15.25 10 15.25C8.34315 15.25 7 14.5784 7 13.75" stroke="currentColor" strokeWidth="1.5" />
                      <path d="M3.39373 5.58639C3.91293 3.52534 5.77786 2 8 2C10.5504 2 12.6314 4.01005 12.7451 6.5324C14.1591 6.7189 15.3247 7.69323 15.7866 9H14.1211C13.7175 8.39701 13.0301 8 12.25 8H12C11.5858 8 11.25 7.66421 11.25 7.25V6.75C11.25 4.95507 9.79493 3.5 8 3.5C6.34131 3.5 4.97186 4.74324 4.7745 6.34833C4.73041 6.70685 4.43704 6.98301 4.07651 7.00536C2.63892 7.09448 1.5 8.28952 1.5 9.75C1.5 11.1845 2.59873 12.3629 4 12.4888V14C3.93845 14 3.87864 13.9926 3.8214 13.9786C1.67511 13.7633 0 11.9526 0 9.75C0 7.69604 1.45669 5.98279 3.39373 5.58639Z" fill="currentColor" />
                      <path d="M7 11.5V13.7769" stroke="currentColor" strokeWidth="1.5" />
                      <path d="M13 11.5V13.7769" stroke="currentColor" strokeWidth="1.5" />
                      <ellipse cx="10" cy="11.5" rx="3" ry="1.5" stroke="currentColor" strokeWidth="1.5" />
                    </svg>
                  </div>
                  <div className="flex items-center gap-2 px-2">
                    {(() => {
                      const selected = warehouses.find(w => w.warehouse_id === selectedWarehouseId);
                      return selected ? (
                        <>
                          <span className={cn(
                            'w-2 h-2 rounded-full',
                            selected.state === 'RUNNING' ? 'bg-[var(--color-success)]' : 'bg-[var(--color-text-muted)]'
                          )} />
                          <span className="max-w-[100px] truncate">{selected.warehouse_name}</span>
                        </>
                      ) : (
                        <span className="text-[var(--color-text-muted)]">Warehouse...</span>
                      );
                    })()}
                    <ChevronDown className={cn('w-3 h-3 transition-transform', warehouseDropdownOpen && 'rotate-180')} />
                  </div>
                </button>
                {warehouseDropdownOpen && (
                  <div className="absolute right-0 top-full mt-1 w-72 max-h-64 overflow-y-auto rounded-md border border-[var(--color-border)] bg-[var(--color-background)] shadow-lg z-50">
                    {warehouses.map((warehouse) => (
                      <button
                        key={warehouse.warehouse_id}
                        onClick={() => {
                          setSelectedWarehouseId(warehouse.warehouse_id);
                          setWarehouseDropdownOpen(false);
                        }}
                        className={cn(
                          'w-full flex items-center gap-2 px-3 py-2 text-xs text-left hover:bg-[var(--color-bg-secondary)] transition-colors',
                          selectedWarehouseId === warehouse.warehouse_id && 'bg-[var(--color-bg-secondary)]'
                        )}
                      >
                        <span className={cn(
                          'w-2 h-2 rounded-full flex-shrink-0',
                          warehouse.state === 'RUNNING' ? 'bg-[var(--color-success)]' : 'bg-[var(--color-text-muted)]'
                        )} />
                        <span className="truncate text-[var(--color-text-primary)]">{warehouse.warehouse_name}</span>
                      </button>
                    ))}
                  </div>
                )}
              </div>
              )}
              {/* Workspace Folder Input */}
              <div className="flex items-center h-8 w-[280px] flex-shrink-0 rounded-md border border-[var(--color-border)] bg-[var(--color-background)] focus-within:ring-2 focus-within:ring-[var(--color-accent-primary)]/50">
                <div className="flex items-center justify-center w-8 h-full border-r border-[var(--color-border)] bg-[var(--color-bg-secondary)]/50 rounded-l-md flex-shrink-0">
                  <svg className="w-4 h-4 text-[var(--color-text-muted)]" viewBox="0 0 16 16" fill="none" xmlns="http://www.w3.org/2000/svg">
                    <path fill="currentColor" fillRule="evenodd" d="M3 1.75A.75.75 0 0 1 3.75 1h10.5a.75.75 0 0 1 .75.75v12.5a.75.75 0 0 1-.75.75H3.75a.75.75 0 0 1-.75-.75V12.5H1V11h2V8.75H1v-1.5h2V5H1V3.5h2zm1.5.75v11H6v-11zm3 0v11h6v-11z" clipRule="evenodd" />
                  </svg>
                </div>
                <input
                  type="text"
                  value={workspaceFolder}
                  onChange={(e) => setWorkspaceFolder(e.target.value)}
                  placeholder="/Workspace/Users/..."
                  className="h-full w-[240px] flex-shrink-0 px-2 bg-transparent text-xs text-[var(--color-text-primary)] placeholder:text-[var(--color-text-muted)] focus:outline-none overflow-hidden text-ellipsis"
                  title={workspaceFolder || 'Workspace working folder for uploading files and pipelines'}
                />
              </div>
              {/* MLflow Experiment Input */}
              <div className="flex items-center h-8 w-[280px] flex-shrink-0 rounded-md border border-[var(--color-border)] bg-[var(--color-background)] focus-within:ring-2 focus-within:ring-[var(--color-accent-primary)]/50">
                <div className="flex items-center justify-center w-8 h-full border-r border-[var(--color-border)] bg-[var(--color-bg-secondary)]/50 rounded-l-md flex-shrink-0">
                  <svg className="w-4 h-4 text-[var(--color-text-muted)]" viewBox="0 0 16 16" fill="none" xmlns="http://www.w3.org/2000/svg">
                    <path fill="currentColor" d="M8 1a.75.75 0 0 1 .75.75v2.5a.75.75 0 0 1-1.5 0v-2.5A.75.75 0 0 1 8 1M3.343 3.343a.75.75 0 0 1 1.061 0l1.768 1.768a.75.75 0 1 1-1.061 1.06L3.343 4.404a.75.75 0 0 1 0-1.06M1 8a.75.75 0 0 1 .75-.75h2.5a.75.75 0 0 1 0 1.5h-2.5A.75.75 0 0 1 1 8m2.343 4.657a.75.75 0 0 1 0-1.06l1.768-1.768a.75.75 0 1 1 1.06 1.06l-1.767 1.768a.75.75 0 0 1-1.061 0M8 11a.75.75 0 0 1 .75.75v2.5a.75.75 0 0 1-1.5 0v-2.5A.75.75 0 0 1 8 11m4.657-2.343a.75.75 0 0 1 0 1.06l-1.768 1.768a.75.75 0 0 1-1.06-1.06l1.767-1.768a.75.75 0 0 1 1.061 0M11 8a.75.75 0 0 1 .75-.75h2.5a.75.75 0 0 1 0 1.5h-2.5A.75.75 0 0 1 11 8m.829-4.657a.75.75 0 0 1 0 1.06L10.06 6.172a.75.75 0 1 1-1.06-1.061l1.768-1.768a.75.75 0 0 1 1.06 0" />
                  </svg>
                </div>
                <input
                  type="text"
                  value={mlflowExperimentName}
                  onChange={(e) => setMlflowExperimentName(e.target.value)}
                  placeholder="MLflow Experiment ID or Name"
                  className="h-full w-[240px] flex-shrink-0 px-2 bg-transparent text-xs text-[var(--color-text-primary)] placeholder:text-[var(--color-text-muted)] focus:outline-none overflow-hidden text-ellipsis"
                  title={mlflowExperimentName || 'MLflow experiment ID (e.g. 2452310130108632) or name (e.g. /Users/you@company.com/traces)'}
                />
              </div>
              {/* Verbose / thinking toggle */}
              <button
                onClick={() => setVerbose((v) => !v)}
                className={cn(
                  'flex items-center justify-center h-8 w-8 flex-shrink-0 rounded-md border transition-colors focus:outline-none focus:ring-2 focus:ring-[var(--color-accent-primary)]/50',
                  verbose
                    ? 'border-[var(--color-accent-primary)] bg-[var(--color-accent-primary)]/10 text-[var(--color-accent-primary)]'
                    : 'border-[var(--color-border)] bg-[var(--color-background)] text-[var(--color-text-muted)] hover:bg-[var(--color-bg-secondary)] hover:text-[var(--color-text-primary)]'
                )}
                title={verbose ? 'Verbose ON — showing full agent trace (thinking, tools, results)' : 'Verbose OFF — click to show full agent trace'}
              >
                <Brain className="h-4 w-4" />
              </button>
          </div>
        </div>

        {/* Messages */}
        <div className="flex-1 overflow-y-auto p-6">
          {messages.length === 0 && !streamingText ? (
            <div className="flex h-full items-center justify-center">
              <div className="text-center max-w-2xl">
                <MessageSquare className="mx-auto h-12 w-12 text-[var(--color-text-muted)]/40" />
                <h3 className="mt-4 text-lg font-medium text-[var(--color-text-heading)]">
                  What can I help you build?
                </h3>
                <p className="mt-2 text-sm text-[var(--color-text-muted)]">
                  I can help you build data pipelines, generate synthetic data, create dashboards, and more on Databricks.
                </p>

                {/* Example prompts */}
                <div className="mt-6 grid gap-2 text-left">
                  <button
                    onClick={() => setInput('Generate synthetic customer data with orders and support tickets')}
                    className="p-3 rounded-lg border border-[var(--color-border)] bg-[var(--color-bg-secondary)]/30 hover:bg-[var(--color-bg-secondary)] text-left transition-colors"
                  >
                    <span className="text-sm font-medium text-[var(--color-text-primary)]">Generate synthetic data</span>
                    <p className="text-xs text-[var(--color-text-muted)] mt-0.5">Create realistic test datasets with customers, orders, and tickets</p>
                  </button>
                  <button
                    onClick={() => setInput('Create a data pipeline to transform raw data into bronze, silver, and gold layers')}
                    className="p-3 rounded-lg border border-[var(--color-border)] bg-[var(--color-bg-secondary)]/30 hover:bg-[var(--color-bg-secondary)] text-left transition-colors"
                  >
                    <span className="text-sm font-medium text-[var(--color-text-primary)]">Build a data pipeline</span>
                    <p className="text-xs text-[var(--color-text-muted)] mt-0.5">Create ETL workflows with bronze/silver/gold medallion architecture</p>
                  </button>
                  <button
                    onClick={() => setInput('Create a dashboard to visualize customer metrics and trends')}
                    className="p-3 rounded-lg border border-[var(--color-border)] bg-[var(--color-bg-secondary)]/30 hover:bg-[var(--color-bg-secondary)] text-left transition-colors"
                  >
                    <span className="text-sm font-medium text-[var(--color-text-primary)]">Create a dashboard</span>
                    <p className="text-xs text-[var(--color-text-muted)] mt-0.5">Build interactive visualizations with AI/BI dashboards</p>
                  </button>
                  <button
                    onClick={() => setInput('What tables and data do I have in my project?')}
                    className="p-3 rounded-lg border border-[var(--color-border)] bg-[var(--color-bg-secondary)]/30 hover:bg-[var(--color-bg-secondary)] text-left transition-colors"
                  >
                    <span className="text-sm font-medium text-[var(--color-text-primary)]">Explore my data</span>
                    <p className="text-xs text-[var(--color-text-muted)] mt-0.5">See what tables, volumes, and resources exist in your project</p>
                  </button>
                </div>
              </div>
            </div>
          ) : (
            <div className="mx-auto max-w-5xl space-y-4">
              {(() => {
                const lastAssistantMessageIndex =
                  verbose && !isCurrentConversationStreaming && lastRunActivityItems.length > 0
                    ? nonQueuedMessages.map((m) => m.role).lastIndexOf('assistant')
                    : -1;
                return nonQueuedMessages.map((message, index) => (
                  <div key={`msg-row-${message.id}`}>
                    {index === lastAssistantMessageIndex && (
                      <div className="mb-4 flex justify-start">
                        <VerboseActivityLog items={lastRunActivityItems} isStreaming={false} />
                      </div>
                    )}
                    <div
                      className={cn(
                        'flex',
                        message.role === 'user' ? 'justify-end' : 'justify-start'
                      )}
                    >
                      <div
                        className={cn(
                          'max-w-[85%] rounded-lg px-3 py-2 shadow-sm',
                          message.role === 'user'
                            ? 'bg-[var(--color-accent-primary)] text-white'
                            : 'bg-[var(--color-bg-secondary)] border border-[var(--color-border)]/50',
                          message.is_error && 'bg-[var(--color-error)]/10 border-[var(--color-error)]/30'
                        )}
                      >
                        {message.role === 'assistant' ? (
                          <div className="prose prose-xs max-w-none text-[var(--color-text-primary)] text-[13px] leading-relaxed">
                            <ReactMarkdown remarkPlugins={[remarkGfm]} components={markdownComponents}>
                              {message.content}
                            </ReactMarkdown>
                          </div>
                        ) : (
                          <p className="whitespace-pre-wrap text-[13px]">{message.content}</p>
                        )}
                      </div>
                    </div>
                  </div>
                ));
              })()}

              {/* Activity section - verbose shows full trace, non-verbose shows current tool only */}
              {isCurrentConversationStreaming && activityItems.length > 0 && (
                verbose
                  ? <div className="flex justify-start"><VerboseActivityLog items={activityItems} isStreaming={true} /></div>
                  : <ActivitySection items={activityItems} isStreaming={isCurrentConversationStreaming} />
              )}

              {/* Streaming response - show accumulated text as it arrives */}
              {isCurrentConversationStreaming && streamingText && (
                <div className="flex justify-start">
                  <div className="max-w-[85%] rounded-lg px-3 py-2 shadow-sm bg-[var(--color-bg-secondary)] border border-[var(--color-border)]/50">
                    <div className="prose prose-xs max-w-none text-[var(--color-text-primary)] text-[13px] leading-relaxed">
                      <ReactMarkdown remarkPlugins={[remarkGfm]} components={markdownComponents}>
                        {streamingText}
                      </ReactMarkdown>
                    </div>
                  </div>
                </div>
              )}

              {/* Fun loader with progress - shown while streaming before text arrives */}
              {isCurrentConversationStreaming && !streamingText && (
                <div className="flex justify-start">
                  {isReconnecting ? (
                    <div className="flex items-center gap-2 text-sm text-[var(--color-text-muted)] py-2">
                      <Loader2 className="h-4 w-4 animate-spin" />
                      <span>Reconnecting to agent...</span>
                    </div>
                  ) : (
                    <FunLoader todos={todos} className="py-2" />
                  )}
                </div>
              )}

              {/* Queued user messages stay visually at the bottom while current run completes */}
              {queuedMessages.map((message) => (
                <div key={`queued-row-${message.id}`} className="flex justify-end">
                  <div className="max-w-[85%] rounded-lg px-3 py-2 shadow-sm bg-[var(--color-accent-primary)] text-white">
                    <p className="whitespace-pre-wrap text-[13px]">{message.content}</p>
                  </div>
                </div>
              ))}

              <div ref={messagesEndRef} />
            </div>
          )}
        </div>

        {/* Input Area */}
        <div className="border-t border-[var(--color-border)] p-4 bg-[var(--color-bg-secondary)]/30">
          <div className="mx-auto max-w-5xl flex gap-3 items-end">
            <div className={cn(
              'flex-1',
              'rounded-xl border bg-[var(--color-background)] transition-all',
              isStreaming
                ? 'border-[var(--color-border)] opacity-80'
                : 'border-[var(--color-border)] focus-within:ring-2 focus-within:ring-[var(--color-accent-primary)]/50 focus-within:border-[var(--color-accent-primary)]'
            )}>
              {/* Attachment previews */}
              {(attachedImages.length > 0 || attachedFiles.length > 0) && (
                <div className="flex flex-wrap gap-2 px-4 pt-3">
                  {attachedImages.map((img) => (
                    <div
                      key={img.id}
                      className="relative group w-16 h-16 rounded-lg overflow-hidden border border-[var(--color-border)] bg-[var(--color-bg-secondary)] flex-shrink-0"
                    >
                      <img src={img.preview} alt="Attached" className="w-full h-full object-cover" />
                      <button
                        onClick={() => {
                          URL.revokeObjectURL(img.preview);
                          setAttachedImages((prev) => prev.filter((i) => i.id !== img.id));
                        }}
                        className="absolute top-0.5 right-0.5 h-4 w-4 rounded-full bg-black/60 text-white opacity-0 group-hover:opacity-100 transition-opacity flex items-center justify-center"
                      >
                        <X className="h-2.5 w-2.5" />
                      </button>
                    </div>
                  ))}
                  {attachedFiles.map((file) => (
                    <div
                      key={file.id}
                      className="flex items-center gap-1.5 h-8 px-3 rounded-full border border-[var(--color-border)] bg-[var(--color-bg-secondary)] text-xs text-[var(--color-text-primary)] flex-shrink-0"
                    >
                      <FileText className="h-3 w-3 text-[var(--color-accent-primary)]" />
                      <span className="max-w-[120px] truncate">{file.file.name}</span>
                      <button
                        onClick={() => setAttachedFiles((prev) => prev.filter((f) => f.id !== file.id))}
                        className="ml-0.5 text-[var(--color-text-muted)] hover:text-[var(--color-text-primary)] transition-colors"
                      >
                        <X className="h-3 w-3" />
                      </button>
                    </div>
                  ))}
                </div>
              )}

              {/* Textarea */}
              <textarea
                ref={inputRef}
                value={input}
                onChange={(e) => setInput(e.target.value)}
                onKeyDown={handleKeyDown}
                onPaste={handlePaste}
                placeholder="Ask Claude to help with code..."
                rows={1}
                className="w-full resize-none bg-transparent px-4 pt-3 pb-2 text-sm text-[var(--color-text-primary)] placeholder:text-[var(--color-text-muted)] focus:outline-none"
              />

              {/* Bottom toolbar — attach buttons only */}
              <div className="flex items-center gap-1 px-3 pb-2.5 pt-1">
                <button
                  onClick={() => fileInputRef.current?.click()}
                  className="flex items-center gap-1.5 h-7 px-2 rounded-md text-[var(--color-text-muted)] hover:text-[var(--color-text-primary)] hover:bg-[var(--color-bg-secondary)] border border-transparent hover:border-[var(--color-border)] transition-all text-xs"
                  title="Attach file"
                >
                  <Paperclip className="h-3.5 w-3.5" />
                  <span>File</span>
                </button>
                <button
                  onClick={() => imageInputRef.current?.click()}
                  className="flex items-center gap-1.5 h-7 px-2 rounded-md text-[var(--color-text-muted)] hover:text-[var(--color-text-primary)] hover:bg-[var(--color-bg-secondary)] border border-transparent hover:border-[var(--color-border)] transition-all text-xs"
                  title="Attach image"
                >
                  <ImageIcon className="h-3.5 w-3.5" />
                  <span>Image</span>
                </button>
              </div>
            </div>

            {/* Send / Stop button — Send takes priority when input has content (interrupt-and-resend).
                Stop is shown only when streaming with no pending input. */}
            {isStreaming && !input.trim() && attachedImages.length === 0 && attachedFiles.length === 0 ? (
              <Button
                onClick={handleStopGeneration}
                className="h-12 w-12 rounded-xl bg-[var(--color-destructive)] hover:bg-[var(--color-destructive)]/90 flex-shrink-0"
                title="Stop generation"
              >
                <Square className="h-5 w-5" />
              </Button>
            ) : (
              <Button
                onClick={handleSendMessage}
                disabled={!input.trim() && attachedImages.length === 0 && attachedFiles.length === 0}
                className="h-12 w-12 rounded-xl flex-shrink-0"
              >
                <Send className="h-5 w-5" />
              </Button>
            )}

            {/* Hidden file inputs */}
            <input
              ref={fileInputRef}
              type="file"
              multiple
              className="hidden"
              accept="text/*,.md,.py,.js,.ts,.jsx,.tsx,.json,.yaml,.yml,.csv,.sql,.sh,.env,.toml,.ini,.cfg,.xml,.html,.htm,.css,.scss,.less,.r,.R,.rmd,.scala,.java,.c,.cpp,.h,.hpp,.go,.rs,.rb,.php,.swift,.kt,.lua,.pl,.pm,.ps1,.bat,.cmd,.makefile,.dockerfile,.tf,.hcl,.conf,.properties,.log,.diff,.patch,.ipynb,.tsv,.graphql,.proto,.gradle,.sbt,.lock,.gitignore,.dockerignore"
              onChange={handleFileChange}
            />
            <input
              ref={imageInputRef}
              type="file"
              multiple
              className="hidden"
              accept="image/jpeg,image/png,image/gif,image/webp"
              onChange={handleImageChange}
            />
          </div>
          <p className="mt-2 text-xs text-[var(--color-text-muted)]">
            Press Enter to send, Shift+Enter for new line
          </p>
        </div>
      </div>

      {/* Skills Explorer */}
      {skillsExplorerOpen && projectId && (
        <SkillsExplorer
          projectId={projectId}
          systemPromptParams={{
            clusterId: selectedClusterId,
            warehouseId: selectedWarehouseId,
            defaultCatalog,
            defaultSchema,
            workspaceFolder,
            projectId,
          }}
          customSystemPrompt={project?.custom_system_prompt ?? null}
          onSystemPromptChange={(prompt) => {
            setProject((prev) => prev ? { ...prev, custom_system_prompt: prompt } : prev);
          }}
          onClose={() => setSkillsExplorerOpen(false)}
        />
      )}
    </MainLayout>
  );
}
