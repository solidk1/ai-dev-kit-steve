import { useCallback, useEffect, useState } from 'react';
import {
  ChevronDown,
  ChevronRight,
  Code,
  Eye,
  File,
  FileText,
  Folder,
  FolderOpen,
  Loader2,
  Plug,
  Pencil,
  RefreshCw,
  RotateCcw,
  Save,
  Sparkles,
  User,
  X,
} from 'lucide-react';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import { toast } from 'sonner';
import { cn } from '@/lib/utils';
import {
  fetchAvailableSkills,
  fetchInstalledMcpTools,
  fetchPersonalSkillFile,
  fetchPersonalSkillsTree,
  fetchSkillFile,
  fetchSkillsTree,
  fetchSystemPrompt,
  reloadProjectSkills,
  savePersonalSkillFile,
  updateProjectClaudeMd,
  updateEnabledSkills,
  updateProjectSystemPrompt,
  type FetchSystemPromptParams,
  type SkillTreeNode,
} from '@/lib/api';
import type { AvailableSkill, McpToolDescriptor } from '@/lib/types';

interface TreeNodeProps {
  node: SkillTreeNode;
  level: number;
  selectedPath: string | null;
  expandedPaths: Set<string>;
  onSelect: (path: string) => void;
  onToggle: (path: string) => void;
}

function TreeNode({
  node,
  level,
  selectedPath,
  expandedPaths,
  onSelect,
  onToggle,
}: TreeNodeProps) {
  const isExpanded = expandedPaths.has(node.path);
  const isSelected = selectedPath === node.path;
  const isDirectory = node.type === 'directory';
  const isMarkdown = node.name.endsWith('.md');

  const handleClick = () => {
    if (isDirectory) {
      onToggle(node.path);
    } else {
      onSelect(node.path);
    }
  };

  return (
    <div>
      <button
        onClick={handleClick}
        className={cn(
          'flex w-full items-center gap-1.5 rounded-md px-2 py-1.5 text-left text-[13px] transition-colors',
          isSelected
            ? 'bg-[var(--color-accent-primary)]/10 text-[var(--color-accent-primary)]'
            : 'text-[var(--color-text-secondary)] hover:bg-[var(--color-bg-secondary)] hover:text-[var(--color-text-primary)]'
        )}
        style={{ paddingLeft: `${level * 12 + 8}px` }}
      >
        {isDirectory ? (
          <>
            {isExpanded ? (
              <ChevronDown className="h-3 w-3 flex-shrink-0 text-[var(--color-text-muted)]" />
            ) : (
              <ChevronRight className="h-3 w-3 flex-shrink-0 text-[var(--color-text-muted)]" />
            )}
            {isExpanded ? (
              <FolderOpen className="h-3.5 w-3.5 flex-shrink-0 text-[var(--color-warning)]" />
            ) : (
              <Folder className="h-3.5 w-3.5 flex-shrink-0 text-[var(--color-warning)]" />
            )}
          </>
        ) : (
          <>
            <span className="w-3" />
            {isMarkdown ? (
              <FileText className="h-3.5 w-3.5 flex-shrink-0 text-[var(--color-accent-secondary)]" />
            ) : (
              <File className="h-3.5 w-3.5 flex-shrink-0 text-[var(--color-text-muted)]" />
            )}
          </>
        )}
        <span className="truncate">{node.name}</span>
      </button>

      {isDirectory && isExpanded && node.children && (
        <div>
          {node.children.map((child) => (
            <TreeNode
              key={child.path}
              node={child}
              level={level + 1}
              selectedPath={selectedPath}
              expandedPaths={expandedPaths}
              onSelect={onSelect}
              onToggle={onToggle}
            />
          ))}
        </div>
      )}
    </div>
  );
}

// Toggle switch component
function Toggle({
  checked,
  onChange,
  disabled,
}: {
  checked: boolean;
  onChange: (checked: boolean) => void;
  disabled?: boolean;
}) {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={checked}
      disabled={disabled}
      onClick={(e) => {
        e.stopPropagation();
        onChange(!checked);
      }}
      className={cn(
        'relative inline-flex h-4 w-7 flex-shrink-0 cursor-pointer rounded-full border-2 border-transparent transition-colors duration-200 ease-in-out focus:outline-none focus:ring-2 focus:ring-[var(--color-accent-primary)]/50 focus:ring-offset-1',
        checked ? 'bg-[var(--color-accent-primary)]' : 'bg-[var(--color-text-muted)]/50',
        disabled && 'opacity-50 cursor-not-allowed'
      )}
    >
      <span
        className={cn(
          'pointer-events-none inline-block h-3 w-3 transform rounded-full bg-white shadow ring-0 transition duration-200 ease-in-out',
          checked ? 'translate-x-3' : 'translate-x-0'
        )}
      />
    </button>
  );
}

type SelectedType = 'system_prompt' | 'claude_md' | 'skill' | 'personal_skill' | 'mcp_tool';
type SidebarTab = 'system_prompt' | 'skills' | 'mcp_tools';

interface SkillsExplorerProps {
  projectId: string;
  systemPromptParams: FetchSystemPromptParams;
  customSystemPrompt: string | null;
  claudeMd: string | null;
  onSystemPromptChange: (prompt: string | null) => void;
  onClaudeMdChange: (claudeMd: string | null) => void;
  onClose: () => void;
  layout?: 'overlay' | 'page';
}

export function SkillsExplorer({
  projectId,
  systemPromptParams,
  customSystemPrompt,
  claudeMd,
  onSystemPromptChange,
  onClaudeMdChange,
  onClose,
  layout = 'overlay',
}: SkillsExplorerProps) {
  const [tree, setTree] = useState<SkillTreeNode[]>([]);
  const [isLoadingTree, setIsLoadingTree] = useState(true);
  const [selectedPath, setSelectedPath] = useState<string | null>(null);
  const [selectedType, setSelectedType] = useState<SelectedType>('system_prompt');
  const [expandedPaths, setExpandedPaths] = useState<Set<string>>(new Set());
  const [content, setContent] = useState<string>('');
  const [isLoadingContent, setIsLoadingContent] = useState(false);
  const [showRawCode, setShowRawCode] = useState(false);
  const [isReloading, setIsReloading] = useState(false);

  // System prompt editing state
  const [isEditing, setIsEditing] = useState(false);
  const [editedPrompt, setEditedPrompt] = useState('');
  const [defaultPrompt, setDefaultPrompt] = useState('');
  const [isSavingPrompt, setIsSavingPrompt] = useState(false);
  const [isEditingClaudeMd, setIsEditingClaudeMd] = useState(false);
  const [editedClaudeMd, setEditedClaudeMd] = useState('');
  const [isSavingClaudeMd, setIsSavingClaudeMd] = useState(false);

  // Skill management state
  const [availableSkills, setAvailableSkills] = useState<AvailableSkill[]>([]);
  const [isUpdatingSkills, setIsUpdatingSkills] = useState(false);

  // Personal workspace state
  const [personalTree, setPersonalTree] = useState<SkillTreeNode[]>([]);
  const [isLoadingPersonalTree, setIsLoadingPersonalTree] = useState(false);
  const [personalExpandedPaths, setPersonalExpandedPaths] = useState<Set<string>>(new Set());
  const [isEditingPersonal, setIsEditingPersonal] = useState(false);
  const [editedPersonalContent, setEditedPersonalContent] = useState('');
  const [isSavingPersonal, setIsSavingPersonal] = useState(false);
  const [activePersonalPath, setActivePersonalPath] = useState<string | null>(null);
  const [mcpTools, setMcpTools] = useState<McpToolDescriptor[]>([]);
  const [isLoadingMcpTools, setIsLoadingMcpTools] = useState(false);
  const [selectedMcpTool, setSelectedMcpTool] = useState<McpToolDescriptor | null>(null);
  const [activeTab, setActiveTab] = useState<SidebarTab>('system_prompt');

  // Load skills tree, available skills, and personal workspace tree
  useEffect(() => {
    const loadData = async () => {
      try {
        setIsLoadingTree(true);
        setIsLoadingPersonalTree(true);

        const [treeData, skillsData] = await Promise.all([
          fetchSkillsTree(projectId),
          fetchAvailableSkills(projectId),
        ]);
        setTree(treeData);
        setAvailableSkills(skillsData.skills);
        // Keep skill files folded by default.
        setExpandedPaths(new Set());
      } catch (error) {
        console.error('Failed to load skills data:', error);
      } finally {
        setIsLoadingTree(false);
      }

      // Load installed MCP tools (non-blocking)
      try {
        setIsLoadingMcpTools(true);
        const installedMcpTools = await fetchInstalledMcpTools();
        setMcpTools(installedMcpTools);
      } catch {
        // Optional metadata; ignore load failure
      } finally {
        setIsLoadingMcpTools(false);
      }

      // Load personal workspace tree (non-blocking, may fail if no token)
      try {
        const personalTreeData = await fetchPersonalSkillsTree();
        setPersonalTree(personalTreeData);
        const personalExpanded = new Set<string>();
        personalTreeData.forEach((node) => {
          if (node.type === 'directory') personalExpanded.add(node.path);
        });
        setPersonalExpandedPaths(personalExpanded);
      } catch {
        // Personal workspace may be unavailable (dev mode, no token, etc.)
      } finally {
        setIsLoadingPersonalTree(false);
      }
    };

    loadData();
  }, [projectId]);

  // Load system prompt by default
  useEffect(() => {
    const loadSystemPrompt = async () => {
      try {
        setIsLoadingContent(true);
        const generated = await fetchSystemPrompt(systemPromptParams);
        setDefaultPrompt(generated);
        const activePrompt = customSystemPrompt ?? generated;
        setContent(activePrompt);
        setEditedPrompt(activePrompt);
        setSelectedType('system_prompt');
        setIsEditing(!!customSystemPrompt);
      } catch (error) {
        console.error('Failed to load system prompt:', error);
        setContent('Error loading system prompt');
      } finally {
        setIsLoadingContent(false);
      }
    };

    loadSystemPrompt();
  }, [systemPromptParams, customSystemPrompt]);

  useEffect(() => {
    setEditedClaudeMd(claudeMd ?? '');
  }, [claudeMd]);

  const handleSelectSystemPrompt = useCallback(async () => {
    setActiveTab('system_prompt');
    setSelectedPath(null);
    setActivePersonalPath(null);
    setSelectedMcpTool(null);
    setSelectedType('system_prompt');
    setIsEditingPersonal(false);
    setIsLoadingContent(true);
    try {
      const generated = await fetchSystemPrompt(systemPromptParams);
      setDefaultPrompt(generated);
      const activePrompt = customSystemPrompt ?? generated;
      setContent(activePrompt);
      setEditedPrompt(activePrompt);
      setIsEditing(!!customSystemPrompt);
    } catch (error) {
      console.error('Failed to load system prompt:', error);
      setContent('Error loading system prompt');
    } finally {
      setIsLoadingContent(false);
    }
  }, [systemPromptParams, customSystemPrompt]);

  // --- Personal skill files ---

  const handleSelectPersonalSkillFile = useCallback(async (path: string) => {
    setActiveTab('skills');
    setSelectedPath(null);
    setActivePersonalPath(path);
    setSelectedMcpTool(null);
    setSelectedType('personal_skill');
    setIsEditing(false);
    setIsEditingPersonal(false);
    setIsLoadingContent(true);
    try {
      const file = await fetchPersonalSkillFile(path);
      setContent(file.content);
      setEditedPersonalContent(file.content);
    } catch (error) {
      console.error('Failed to load personal skill file:', error);
      setContent('Error loading file');
    } finally {
      setIsLoadingContent(false);
    }
  }, []);

  const handleSavePersonalSkillFile = useCallback(async () => {
    if (!activePersonalPath) return;
    setIsSavingPersonal(true);
    try {
      await savePersonalSkillFile(activePersonalPath, editedPersonalContent);
      setContent(editedPersonalContent);
      setIsEditingPersonal(false);
      toast.success('Skill file saved to personal workspace');
    } catch (error) {
      console.error('Failed to save personal skill file:', error);
      toast.error('Failed to save skill file');
    } finally {
      setIsSavingPersonal(false);
    }
  }, [activePersonalPath, editedPersonalContent]);

  const handleSaveSystemPrompt = useCallback(async () => {
    setIsSavingPrompt(true);
    try {
      await updateProjectSystemPrompt(projectId, editedPrompt);
      onSystemPromptChange(editedPrompt);
      setContent(editedPrompt);
      toast.success('System prompt saved');
    } catch (error) {
      console.error('Failed to save system prompt:', error);
      toast.error('Failed to save system prompt');
    } finally {
      setIsSavingPrompt(false);
    }
  }, [projectId, editedPrompt, onSystemPromptChange]);

  const handleResetSystemPrompt = useCallback(async () => {
    setIsSavingPrompt(true);
    try {
      await updateProjectSystemPrompt(projectId, null);
      onSystemPromptChange(null);
      setContent(defaultPrompt);
      setEditedPrompt(defaultPrompt);
      setIsEditing(false);
      toast.success('System prompt reset to default');
    } catch (error) {
      console.error('Failed to reset system prompt:', error);
      toast.error('Failed to reset system prompt');
    } finally {
      setIsSavingPrompt(false);
    }
  }, [projectId, defaultPrompt, onSystemPromptChange]);

  const handleStartEditing = useCallback(() => {
    setIsEditing(true);
    setEditedPrompt(content);
  }, [content]);

  const handleSaveClaudeMd = useCallback(async () => {
    setIsSavingClaudeMd(true);
    try {
      const nextValue = editedClaudeMd.trim().length > 0 ? editedClaudeMd : null;
      await updateProjectClaudeMd(projectId, nextValue);
      onClaudeMdChange(nextValue);
      setIsEditingClaudeMd(false);
      toast.success('CLAUDE.md saved');
    } catch (error) {
      console.error('Failed to save CLAUDE.md:', error);
      toast.error('Failed to save CLAUDE.md');
    } finally {
      setIsSavingClaudeMd(false);
    }
  }, [editedClaudeMd, onClaudeMdChange, projectId]);

  const handleSelectClaudeMd = useCallback(() => {
    setActiveTab('system_prompt');
    setSelectedPath(null);
    setActivePersonalPath(null);
    setSelectedMcpTool(null);
    setSelectedType('claude_md');
    setIsEditing(false);
    setIsEditingPersonal(false);
    setEditedClaudeMd(claudeMd ?? '');
  }, [claudeMd]);

  const handleSelectSkill = useCallback(
    async (path: string) => {
      setActiveTab('skills');
      setSelectedPath(path);
      setActivePersonalPath(null);
      setSelectedMcpTool(null);
      setSelectedType('skill');
      setIsEditingPersonal(false);
      setIsLoadingContent(true);
      try {
        const file = await fetchSkillFile(projectId, path);
        setContent(file.content);
      } catch (error) {
        console.error('Failed to load skill file:', error);
        setContent('Error loading file');
      } finally {
        setIsLoadingContent(false);
      }
    },
    [projectId]
  );

  const handleToggle = useCallback((path: string) => {
    setExpandedPaths((prev) => {
      const next = new Set(prev);
      if (next.has(path)) {
        next.delete(path);
      } else {
        next.add(path);
      }
      return next;
    });
  }, []);

  const handlePersonalToggle = useCallback((path: string) => {
    setPersonalExpandedPaths((prev) => {
      const next = new Set(prev);
      if (next.has(path)) {
        next.delete(path);
      } else {
        next.add(path);
      }
      return next;
    });
  }, []);

  const handleSelectMcpTool = useCallback((tool: McpToolDescriptor) => {
    setActiveTab('mcp_tools');
    setSelectedPath(null);
    setActivePersonalPath(null);
    setSelectedMcpTool(tool);
    setSelectedType('mcp_tool');
    setIsEditing(false);
    setIsEditingPersonal(false);
  }, []);

  const handleSelectTab = useCallback((tab: SidebarTab) => {
    setActiveTab(tab);
    if (tab === 'system_prompt') {
      void handleSelectSystemPrompt();
      return;
    }
    if (tab === 'mcp_tools') {
      if (mcpTools.length > 0) {
        handleSelectMcpTool(mcpTools[0]);
      } else {
        setSelectedType('mcp_tool');
        setSelectedMcpTool(null);
      }
      return;
    }

    // Skills tab
    if (selectedType === 'system_prompt' || selectedType === 'mcp_tool') {
      setSelectedType('skill');
      setSelectedPath(null);
      setActivePersonalPath(null);
      setSelectedMcpTool(null);
      setContent('Select a skill file from the sidebar.');
    }
  }, [handleSelectMcpTool, handleSelectSystemPrompt, mcpTools, selectedType]);

  const handleReloadSkills = useCallback(async () => {
    setIsReloading(true);
    try {
      await reloadProjectSkills(projectId);
      // Reload the tree and available skills after refresh
      const [treeData, skillsData] = await Promise.all([
        fetchSkillsTree(projectId),
        fetchAvailableSkills(projectId),
      ]);
      setTree(treeData);
      setAvailableSkills(skillsData.skills);
      // Keep skill files folded by default after reload, too.
      setExpandedPaths(new Set());
      toast.success('Skills reloaded');
    } catch (error) {
      console.error('Failed to reload skills:', error);
      toast.error('Failed to reload skills');
    } finally {
      setIsReloading(false);
    }
  }, [projectId]);

  // Toggle a single skill
  const handleToggleSkill = useCallback(
    async (skillName: string, enabled: boolean) => {
      setIsUpdatingSkills(true);
      try {
        // Calculate new enabled list
        const allEnabled = availableSkills.every((s) => s.enabled) && availableSkills.some((s) => s.name !== skillName);
        let newEnabledList: string[] | null;

        if (enabled) {
          // Enabling a skill
          const currentEnabled = availableSkills.filter((s) => s.enabled).map((s) => s.name);
          const newEnabled = [...currentEnabled, skillName];
          // If all skills would be enabled, set to null (all)
          if (newEnabled.length >= availableSkills.length) {
            newEnabledList = null;
          } else {
            newEnabledList = newEnabled;
          }
        } else {
          // Disabling a skill
          const currentEnabled = availableSkills.filter((s) => s.enabled).map((s) => s.name);
          newEnabledList = currentEnabled.filter((n) => n !== skillName);
          if (newEnabledList.length === 0) {
            toast.error('At least one skill must be enabled');
            setIsUpdatingSkills(false);
            return;
          }
        }

        await updateEnabledSkills(projectId, newEnabledList);

        // Update local state
        setAvailableSkills((prev) =>
          prev.map((s) => (s.name === skillName ? { ...s, enabled } : s))
        );

        // Refresh the tree to reflect filesystem changes
        const treeData = await fetchSkillsTree(projectId);
        setTree(treeData);

        // Refresh system prompt if currently viewing it (so disabled skills disappear)
        if (selectedType === 'system_prompt') {
          const prompt = await fetchSystemPrompt(systemPromptParams);
          setContent(prompt);
        }
      } catch (error) {
        console.error('Failed to toggle skill:', error);
        toast.error('Failed to update skill');
      } finally {
        setIsUpdatingSkills(false);
      }
    },
    [projectId, availableSkills, selectedType, systemPromptParams]
  );

  // Enable or disable all skills
  const handleToggleAll = useCallback(
    async (enableAll: boolean) => {
      setIsUpdatingSkills(true);
      try {
        if (enableAll) {
          await updateEnabledSkills(projectId, null);
          setAvailableSkills((prev) => prev.map((s) => ({ ...s, enabled: true })));
        } else {
          // Disable all except first skill (must have at least one)
          const firstSkill = availableSkills[0]?.name;
          if (!firstSkill) return;
          await updateEnabledSkills(projectId, [firstSkill]);
          setAvailableSkills((prev) =>
            prev.map((s) => ({ ...s, enabled: s.name === firstSkill }))
          );
        }

        // Refresh tree
        const treeData = await fetchSkillsTree(projectId);
        setTree(treeData);

        // Refresh system prompt if currently viewing it
        if (selectedType === 'system_prompt') {
          const prompt = await fetchSystemPrompt(systemPromptParams);
          setContent(prompt);
        }

        toast.success(enableAll ? 'All skills enabled' : 'Skills minimized');
      } catch (error) {
        console.error('Failed to toggle all skills:', error);
        toast.error('Failed to update skills');
      } finally {
        setIsUpdatingSkills(false);
      }
    },
    [projectId, availableSkills, selectedType, systemPromptParams]
  );

  const enabledCount = availableSkills.filter((s) => s.enabled).length;
  const totalCount = availableSkills.length;
  const isMarkdownFile =
    selectedType === 'system_prompt' ||
    selectedType === 'claude_md' ||
    selectedPath?.endsWith('.md') ||
    activePersonalPath?.endsWith('.md') ||
    activePersonalPath?.includes('SKILL');

  const isPersonalEditable = selectedType === 'personal_skill';
  const isOverlay = layout === 'overlay';

  return (
    <div
      className={cn(
        isOverlay ? 'fixed inset-0 z-50 flex text-[13px]' : 'flex h-full min-h-0 text-[13px]'
      )}
    >
      {isOverlay && (
        <div
          className="absolute inset-0 bg-black/50 backdrop-blur-sm"
          onClick={onClose}
        />
      )}

      <div
        className={cn(
          'flex w-full h-full overflow-hidden border border-[var(--color-border)] bg-[var(--color-background)]',
          isOverlay
            ? 'relative z-10 m-4 rounded-xl shadow-2xl'
            : 'rounded-none border-0'
        )}
      >
        {/* Left sidebar - Navigation */}
        <div className="w-72 flex-shrink-0 border-r border-[var(--color-border)] bg-[var(--color-bg-secondary)]/30 flex flex-col">
          {/* Header */}
          <div className="flex items-center justify-between px-4 py-3 border-b border-[var(--color-border)]">
            <h2 className="text-sm font-semibold text-[var(--color-text-heading)]">
              Skills & MCP
            </h2>
            <span className="text-[10px] font-medium px-1.5 py-0.5 rounded-full bg-[var(--color-accent-primary)]/10 text-[var(--color-accent-primary)]">
              {enabledCount}/{totalCount}
            </span>
          </div>

          {/* Navigation content */}
          <div className="flex-1 overflow-y-auto p-2">
            <div className="grid grid-cols-3 gap-1.5 mb-3 p-1 rounded-lg border border-[var(--color-border)] bg-[var(--color-bg-secondary)]/40">
              <button
                onClick={() => handleSelectTab('system_prompt')}
                className={cn(
                  'rounded-md px-2 py-2 text-xs font-semibold transition-colors border',
                  activeTab === 'system_prompt'
                    ? 'bg-[var(--color-accent-primary)]/15 border-[var(--color-accent-primary)]/40 text-[var(--color-accent-primary)] shadow-sm'
                    : 'border-transparent text-[var(--color-text-muted)] hover:border-[var(--color-border)] hover:bg-[var(--color-bg-secondary)] hover:text-[var(--color-text-primary)]'
                )}
              >
                System Prompt
              </button>
              <button
                onClick={() => handleSelectTab('skills')}
                className={cn(
                  'rounded-md px-2 py-2 text-xs font-semibold transition-colors border',
                  activeTab === 'skills'
                    ? 'bg-[var(--color-accent-primary)]/15 border-[var(--color-accent-primary)]/40 text-[var(--color-accent-primary)] shadow-sm'
                    : 'border-transparent text-[var(--color-text-muted)] hover:border-[var(--color-border)] hover:bg-[var(--color-bg-secondary)] hover:text-[var(--color-text-primary)]'
                )}
              >
                Skills
              </button>
              <button
                onClick={() => handleSelectTab('mcp_tools')}
                className={cn(
                  'rounded-md px-2 py-2 text-xs font-semibold transition-colors border',
                  activeTab === 'mcp_tools'
                    ? 'bg-[var(--color-accent-primary)]/15 border-[var(--color-accent-primary)]/40 text-[var(--color-accent-primary)] shadow-sm'
                    : 'border-transparent text-[var(--color-text-muted)] hover:border-[var(--color-border)] hover:bg-[var(--color-bg-secondary)] hover:text-[var(--color-text-primary)]'
                )}
              >
                MCP Tools
              </button>
            </div>

            {activeTab === 'system_prompt' && (
              <>
                <button
                  onClick={handleSelectSystemPrompt}
                  className={cn(
                    'flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left text-xs transition-colors mb-1',
                    selectedType === 'system_prompt'
                      ? 'bg-[var(--color-accent-primary)]/10 text-[var(--color-accent-primary)]'
                      : 'text-[var(--color-text-secondary)] hover:bg-[var(--color-bg-secondary)] hover:text-[var(--color-text-primary)]'
                  )}
                >
                  <Sparkles className="h-3.5 w-3.5 flex-shrink-0" />
                  <span className="font-medium">System Prompt</span>
                </button>
                <button
                  onClick={handleSelectClaudeMd}
                  className={cn(
                    'flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left text-xs transition-colors mb-1',
                    selectedType === 'claude_md'
                      ? 'bg-[var(--color-accent-primary)]/10 text-[var(--color-accent-primary)]'
                      : 'text-[var(--color-text-secondary)] hover:bg-[var(--color-bg-secondary)] hover:text-[var(--color-text-primary)]'
                  )}
                >
                  <FileText className="h-3.5 w-3.5 flex-shrink-0" />
                  <span className="font-medium">Project CLAUDE.md</span>
                </button>
              </>
            )}

            {activeTab === 'skills' && (
              <>
                <div className="flex gap-1.5 mb-3">
                  <button
                    onClick={handleReloadSkills}
                    disabled={isReloading}
                    className="flex flex-1 items-center justify-center gap-1.5 rounded-lg px-2 py-1.5 text-[10px] font-medium bg-[var(--color-accent-primary)] text-white hover:bg-[var(--color-accent-secondary)] transition-colors disabled:opacity-50 disabled:cursor-not-allowed shadow-sm"
                  >
                    <RefreshCw className={cn('h-3 w-3 flex-shrink-0', isReloading && 'animate-spin')} />
                    <span>{isReloading ? 'Reloading...' : 'Reload'}</span>
                  </button>
                  <button
                    onClick={() => handleToggleAll(true)}
                    disabled={isUpdatingSkills || enabledCount === totalCount}
                    className="flex items-center justify-center gap-1 rounded-lg px-2 py-1.5 text-[10px] font-medium border border-[var(--color-border)] text-[var(--color-text-secondary)] hover:bg-[var(--color-bg-secondary)] transition-colors disabled:opacity-40 disabled:cursor-not-allowed"
                  >
                    All on
                  </button>
                  <button
                    onClick={() => handleToggleAll(false)}
                    disabled={isUpdatingSkills || enabledCount <= 1}
                    className="flex items-center justify-center gap-1 rounded-lg px-2 py-1.5 text-[10px] font-medium border border-[var(--color-border)] text-[var(--color-text-secondary)] hover:bg-[var(--color-bg-secondary)] transition-colors disabled:opacity-40 disabled:cursor-not-allowed"
                  >
                    Min
                  </button>
                </div>

                <div className="px-2 py-1 text-[10px] font-semibold uppercase tracking-wider text-[var(--color-text-muted)]">
                  Skills
                </div>
                {isLoadingTree ? (
                  <div className="flex items-center justify-center py-8">
                    <Loader2 className="h-4 w-4 animate-spin text-[var(--color-text-muted)]" />
                  </div>
                ) : availableSkills.length === 0 ? (
                  <div className="px-2 py-4 text-xs text-[var(--color-text-muted)]">
                    No skills available
                  </div>
                ) : (
                  <div className="space-y-0.5">
                    {availableSkills.map((skill) => (
                      <div
                        key={skill.name}
                        className={cn(
                          'flex items-center gap-2 rounded-md px-2 py-1.5 text-xs transition-colors group',
                          !skill.enabled && 'opacity-50'
                        )}
                      >
                        <Toggle
                          checked={skill.enabled}
                          onChange={(checked) => handleToggleSkill(skill.name, checked)}
                          disabled={isUpdatingSkills}
                        />
                        <div className="flex-1 min-w-0">
                          <div className="font-medium text-[var(--color-text-primary)] truncate text-[11px]">
                            {skill.name}
                          </div>
                          <div className="text-[var(--color-text-muted)] truncate text-[10px] leading-tight">
                            {skill.description}
                          </div>
                        </div>
                      </div>
                    ))}
                  </div>
                )}

                {tree.length > 0 && (
                  <>
                    <div className="my-3 border-t border-[var(--color-border)]" />
                    <div className="px-2 py-1 text-[10px] font-semibold uppercase tracking-wider text-[var(--color-text-muted)]">
                      Skill Files
                    </div>
                    <div className="space-y-0.5">
                      {tree.map((node) => (
                        <TreeNode
                          key={node.path}
                          node={node}
                          level={0}
                          selectedPath={selectedPath}
                          expandedPaths={expandedPaths}
                          onSelect={handleSelectSkill}
                          onToggle={handleToggle}
                        />
                      ))}
                    </div>
                  </>
                )}

                {(personalTree.length > 0 || isLoadingPersonalTree) && (
                  <>
                    <div className="my-3 border-t border-[var(--color-border)]" />
                    <div className="flex items-center gap-1 px-2 py-1">
                      <User className="h-3 w-3 text-[var(--color-text-muted)]" />
                      <span className="text-[10px] font-semibold uppercase tracking-wider text-[var(--color-text-muted)]">
                        Personal Skills
                      </span>
                    </div>
                    {isLoadingPersonalTree ? (
                      <div className="flex items-center justify-center py-4">
                        <Loader2 className="h-3 w-3 animate-spin text-[var(--color-text-muted)]" />
                      </div>
                    ) : (
                      <div className="space-y-0.5">
                        {personalTree.map((node) => (
                          <TreeNode
                            key={node.path}
                            node={node}
                            level={0}
                            selectedPath={activePersonalPath}
                            expandedPaths={personalExpandedPaths}
                            onSelect={handleSelectPersonalSkillFile}
                            onToggle={handlePersonalToggle}
                          />
                        ))}
                      </div>
                    )}
                  </>
                )}
              </>
            )}

            {activeTab === 'mcp_tools' && (
              <>
                <div className="flex items-center gap-1 px-2 py-1 mb-1">
                  <Plug className="h-3 w-3 text-[var(--color-text-muted)]" />
                  <span className="text-[10px] font-semibold uppercase tracking-wider text-[var(--color-text-muted)]">
                    MCP Tools
                  </span>
                </div>
                {isLoadingMcpTools ? (
                  <div className="flex items-center justify-center py-4">
                    <Loader2 className="h-3 w-3 animate-spin text-[var(--color-text-muted)]" />
                  </div>
                ) : (
                  <div className="space-y-0.5">
                    {mcpTools.map((tool) => {
                      const toolKey = `${tool.server}/${tool.name}`;
                      const isSelected = selectedType === 'mcp_tool' && selectedMcpTool?.server === tool.server && selectedMcpTool?.name === tool.name;
                      return (
                        <button
                          key={toolKey}
                          onClick={() => handleSelectMcpTool(tool)}
                          className={cn(
                            'flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left text-xs transition-colors',
                            isSelected
                              ? 'bg-[var(--color-accent-primary)]/10 text-[var(--color-accent-primary)]'
                              : 'text-[var(--color-text-secondary)] hover:bg-[var(--color-bg-secondary)] hover:text-[var(--color-text-primary)]'
                          )}
                          title={tool.description || tool.name}
                        >
                          <Plug className="h-3.5 w-3.5 flex-shrink-0 text-[var(--color-accent-secondary)]" />
                          <div className="min-w-0">
                            <div className="truncate font-medium text-[11px]">{tool.name}</div>
                            <div className="truncate text-[10px] text-[var(--color-text-muted)]">{tool.server}</div>
                          </div>
                        </button>
                      );
                    })}
                    {mcpTools.length === 0 && (
                      <div className="px-2 py-3 text-xs text-[var(--color-text-muted)]">
                        No MCP tools discovered.
                      </div>
                    )}
                  </div>
                )}
              </>
            )}
          </div>
        </div>

        {/* Right panel - Content */}
        <div className="flex-1 flex flex-col min-w-0">
          {/* Header */}
          <div className="flex items-center justify-between px-5 py-3 border-b border-[var(--color-border)]">
            <div className="flex items-center gap-2 min-w-0">
              {selectedType === 'system_prompt' ? (
                <>
                  <Sparkles className="h-4 w-4 flex-shrink-0 text-[var(--color-accent-primary)]" />
                  <div className="min-w-0">
                    <h3 className="text-sm font-semibold text-[var(--color-text-heading)] truncate flex items-center gap-2">
                      System Prompt
                      {customSystemPrompt != null && (
                        <span className="text-[10px] font-medium px-1.5 py-0.5 rounded-full bg-[var(--color-accent-primary)]/10 text-[var(--color-accent-primary)]">
                          Custom
                        </span>
                      )}
                    </h3>
                    <p className="text-xs text-[var(--color-text-muted)]">
                      {customSystemPrompt != null
                        ? 'Custom instructions — click Edit to modify'
                        : 'Auto-generated — click Edit to customize'}
                    </p>
                  </div>
                </>
              ) : selectedType === 'claude_md' ? (
                <>
                  <FileText className="h-4 w-4 flex-shrink-0 text-[var(--color-accent-primary)]" />
                  <div className="min-w-0">
                    <h3 className="text-sm font-semibold text-[var(--color-text-heading)] truncate">
                      Project CLAUDE.md
                    </h3>
                    <p className="text-xs text-[var(--color-text-muted)]">
                      Project-specific instructions stored in Lakebase
                    </p>
                  </div>
                </>
              ) : selectedType === 'personal_skill' ? (
                <>
                  <FileText className="h-4 w-4 flex-shrink-0 text-[var(--color-accent-secondary)]" />
                  <div className="min-w-0">
                    <h3 className="text-sm font-semibold text-[var(--color-text-heading)] truncate flex items-center gap-2">
                      {activePersonalPath?.split('/').pop() || 'Personal Skill File'}
                      <span className="text-[10px] font-medium px-1.5 py-0.5 rounded-full bg-[var(--color-text-muted)]/10 text-[var(--color-text-muted)]">
                        personal
                      </span>
                    </h3>
                    <p className="text-xs text-[var(--color-text-muted)] truncate">
                      {activePersonalPath || ''}
                    </p>
                  </div>
                </>
              ) : selectedType === 'mcp_tool' ? (
                <>
                  <Plug className="h-4 w-4 flex-shrink-0 text-[var(--color-accent-secondary)]" />
                  <div className="min-w-0">
                    <h3 className="text-sm font-semibold text-[var(--color-text-heading)] truncate flex items-center gap-2">
                      {selectedMcpTool?.name || 'MCP Tool'}
                    </h3>
                    <p className="text-xs text-[var(--color-text-muted)] truncate">
                      {selectedMcpTool?.server || ''}
                    </p>
                  </div>
                </>
              ) : (
                <>
                  <FileText className="h-4 w-4 flex-shrink-0 text-[var(--color-accent-secondary)]" />
                  <div className="min-w-0">
                    <h3 className="text-sm font-semibold text-[var(--color-text-heading)] truncate">
                      {selectedPath?.split('/').pop() || 'Select a file'}
                    </h3>
                    <p className="text-xs text-[var(--color-text-muted)] truncate">
                      {selectedPath || 'Choose a skill file from the sidebar'}
                    </p>
                  </div>
                </>
              )}
            </div>

            <div className="flex items-center gap-2">
              {/* System prompt editing controls */}
              {selectedType === 'system_prompt' && !isEditing && (
                <button
                  onClick={handleStartEditing}
                  className="flex items-center gap-1 px-2 py-1 rounded-md text-xs text-[var(--color-text-muted)] hover:text-[var(--color-text-primary)] hover:bg-[var(--color-bg-secondary)] transition-colors"
                >
                  <Pencil className="h-3 w-3" />
                  Edit
                </button>
              )}
              {selectedType === 'system_prompt' && isEditing && (
                <>
                  {customSystemPrompt != null && (
                    <button
                      onClick={handleResetSystemPrompt}
                      disabled={isSavingPrompt}
                      className="flex items-center gap-1 px-2 py-1 rounded-md text-xs text-[var(--color-text-muted)] hover:text-[var(--color-warning)] hover:bg-[var(--color-bg-secondary)] transition-colors disabled:opacity-50"
                      title="Reset to auto-generated default"
                    >
                      <RotateCcw className="h-3 w-3" />
                      Reset
                    </button>
                  )}
                  <button
                    onClick={handleSaveSystemPrompt}
                    disabled={isSavingPrompt || editedPrompt === (customSystemPrompt ?? defaultPrompt)}
                    className="flex items-center gap-1 px-2.5 py-1 rounded-md text-xs font-medium bg-[var(--color-accent-primary)] text-white hover:bg-[var(--color-accent-secondary)] transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
                  >
                    {isSavingPrompt ? (
                      <Loader2 className="h-3 w-3 animate-spin" />
                    ) : (
                      <Save className="h-3 w-3" />
                    )}
                    Save
                  </button>
                </>
              )}
              {selectedType === 'claude_md' && !isEditingClaudeMd && (
                <button
                  onClick={() => {
                    setEditedClaudeMd(claudeMd ?? '');
                    setIsEditingClaudeMd(true);
                  }}
                  className="flex items-center gap-1 px-2 py-1 rounded-md text-xs text-[var(--color-text-muted)] hover:text-[var(--color-text-primary)] hover:bg-[var(--color-bg-secondary)] transition-colors"
                >
                  <Pencil className="h-3 w-3" />
                  Edit
                </button>
              )}
              {selectedType === 'claude_md' && isEditingClaudeMd && (
                <>
                  <button
                    onClick={() => setIsEditingClaudeMd(false)}
                    disabled={isSavingClaudeMd}
                    className="px-2 py-1 rounded-md text-xs text-[var(--color-text-muted)] hover:text-[var(--color-text-primary)] hover:bg-[var(--color-bg-secondary)] transition-colors disabled:opacity-50"
                  >
                    Cancel
                  </button>
                  <button
                    onClick={handleSaveClaudeMd}
                    disabled={isSavingClaudeMd || editedClaudeMd === (claudeMd ?? '')}
                    className="flex items-center gap-1 px-2.5 py-1 rounded-md text-xs font-medium bg-[var(--color-accent-primary)] text-white hover:bg-[var(--color-accent-secondary)] transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
                  >
                    {isSavingClaudeMd ? (
                      <Loader2 className="h-3 w-3 animate-spin" />
                    ) : (
                      <Save className="h-3 w-3" />
                    )}
                    Save
                  </button>
                </>
              )}

              {/* Personal workspace editing controls */}
              {isPersonalEditable && !isEditingPersonal && (
                <button
                  onClick={() => {
                    setIsEditingPersonal(true);
                    setEditedPersonalContent(content);
                  }}
                  className="flex items-center gap-1 px-2 py-1 rounded-md text-xs text-[var(--color-text-muted)] hover:text-[var(--color-text-primary)] hover:bg-[var(--color-bg-secondary)] transition-colors"
                >
                  <Pencil className="h-3 w-3" />
                  Edit
                </button>
              )}
              {isPersonalEditable && isEditingPersonal && (
                <>
                  <button
                    onClick={() => setIsEditingPersonal(false)}
                    disabled={isSavingPersonal}
                    className="flex items-center gap-1 px-2 py-1 rounded-md text-xs text-[var(--color-text-muted)] hover:text-[var(--color-text-primary)] hover:bg-[var(--color-bg-secondary)] transition-colors disabled:opacity-50"
                  >
                    Cancel
                  </button>
                  <button
                    onClick={handleSavePersonalSkillFile}
                    disabled={isSavingPersonal || editedPersonalContent === content}
                    className="flex items-center gap-1 px-2.5 py-1 rounded-md text-xs font-medium bg-[var(--color-accent-primary)] text-white hover:bg-[var(--color-accent-secondary)] transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
                  >
                    {isSavingPersonal ? (
                      <Loader2 className="h-3 w-3 animate-spin" />
                    ) : (
                      <Save className="h-3 w-3" />
                    )}
                    Save to Workspace
                  </button>
                </>
              )}

              {/* Toggle raw/rendered for markdown */}
              {isMarkdownFile && !isEditing && !isEditingPersonal && !isEditingClaudeMd && (
                <button
                  onClick={() => setShowRawCode(!showRawCode)}
                  className={cn(
                    'flex items-center gap-1 px-2 py-1 rounded-md text-xs transition-colors',
                    showRawCode
                      ? 'bg-[var(--color-accent-primary)]/10 text-[var(--color-accent-primary)]'
                      : 'text-[var(--color-text-muted)] hover:text-[var(--color-text-primary)] hover:bg-[var(--color-bg-secondary)]'
                  )}
                >
                  {showRawCode ? (
                    <>
                      <Eye className="h-3 w-3" />
                      Rendered
                    </>
                  ) : (
                    <>
                      <Code className="h-3 w-3" />
                      Raw
                    </>
                  )}
                </button>
              )}

              {/* Close button */}
              <button
                onClick={onClose}
                className="p-1 rounded-md text-[var(--color-text-muted)] hover:text-[var(--color-text-primary)] hover:bg-[var(--color-bg-secondary)] transition-colors"
              >
                <X className="h-4 w-4" />
              </button>
            </div>
          </div>

          {/* Content area */}
          <div className="flex-1 overflow-y-auto p-5 flex flex-col">
            {isLoadingContent ? (
              <div className="flex items-center justify-center py-20">
                <div className="flex flex-col items-center gap-3">
                  <Loader2 className="h-6 w-6 animate-spin text-[var(--color-accent-primary)]" />
                  <p className="text-xs text-[var(--color-text-muted)]">Loading...</p>
                </div>
              </div>
            ) : selectedType === 'system_prompt' ? (
              <div className="flex-1 flex flex-col gap-4">
                {isEditing ? (
                  <div className="flex-1 flex flex-col gap-2">
                    {customSystemPrompt != null && (
                      <div className="flex items-center gap-1.5 px-2 py-1 rounded-md bg-[var(--color-accent-primary)]/5 border border-[var(--color-accent-primary)]/20 text-[10px] text-[var(--color-accent-primary)]">
                        <Pencil className="h-3 w-3" />
                        Custom system prompt active — this overrides the auto-generated default
                      </div>
                    )}
                    <textarea
                      value={editedPrompt}
                      onChange={(e) => setEditedPrompt(e.target.value)}
                      className="flex-1 w-full resize-none rounded-lg border border-[var(--color-border)] bg-[var(--color-bg-secondary)]/30 p-4 text-xs font-mono text-[var(--color-text-primary)] placeholder:text-[var(--color-text-muted)] focus:outline-none focus:ring-2 focus:ring-[var(--color-accent-primary)]/50 focus:border-[var(--color-accent-primary)] transition-colors"
                      placeholder="Enter your custom system prompt..."
                      spellCheck={false}
                    />
                  </div>
                ) : showRawCode || !isMarkdownFile ? (
                  <pre className="text-xs font-mono text-[var(--color-text-primary)] whitespace-pre-wrap break-words bg-[var(--color-bg-secondary)]/50 p-4 rounded-lg border border-[var(--color-border)]">
                    {content}
                  </pre>
                ) : (
                  <div className="prose prose-xs max-w-none text-[var(--color-text-primary)] text-xs leading-relaxed">
                    <ReactMarkdown remarkPlugins={[remarkGfm]}>{content}</ReactMarkdown>
                  </div>
                )}
              </div>
            ) : selectedType === 'claude_md' ? (
              isEditingClaudeMd ? (
                <textarea
                  value={editedClaudeMd}
                  onChange={(e) => setEditedClaudeMd(e.target.value)}
                  className="w-full min-h-[320px] flex-1 resize-y rounded-lg border border-[var(--color-border)] bg-[var(--color-bg-secondary)]/30 p-4 text-xs font-mono text-[var(--color-text-primary)] placeholder:text-[var(--color-text-muted)] focus:outline-none focus:ring-2 focus:ring-[var(--color-accent-primary)]/50 focus:border-[var(--color-accent-primary)] transition-colors"
                  placeholder="Enter project CLAUDE.md content..."
                  spellCheck={false}
                />
              ) : showRawCode || !isMarkdownFile ? (
                <pre className="text-xs font-mono text-[var(--color-text-primary)] whitespace-pre-wrap break-words bg-[var(--color-bg-secondary)]/50 p-4 rounded-lg border border-[var(--color-border)] min-h-[120px]">
                  {claudeMd || '(empty)'}
                </pre>
              ) : (
                <div className="prose prose-xs max-w-none text-[var(--color-text-primary)] text-xs leading-relaxed">
                  <ReactMarkdown remarkPlugins={[remarkGfm]}>{claudeMd || '(empty)'}</ReactMarkdown>
                </div>
              )
            ) : selectedType === 'mcp_tool' ? (
              <div className="space-y-4">
                <div>
                  <h4 className="text-xs font-semibold uppercase tracking-wider text-[var(--color-text-muted)] mb-2">
                    Description
                  </h4>
                  <div className="rounded-lg border border-[var(--color-border)] bg-[var(--color-bg-secondary)]/30 p-3 text-xs text-[var(--color-text-primary)] whitespace-pre-wrap">
                    {selectedMcpTool?.description || 'No description available.'}
                  </div>
                </div>
                <div>
                  <h4 className="text-xs font-semibold uppercase tracking-wider text-[var(--color-text-muted)] mb-2">
                    Input Spec
                  </h4>
                  <pre className="text-xs font-mono text-[var(--color-text-primary)] whitespace-pre-wrap break-words bg-[var(--color-bg-secondary)]/50 p-4 rounded-lg border border-[var(--color-border)]">
                    {JSON.stringify(selectedMcpTool?.arguments ?? {}, null, 2)}
                  </pre>
                </div>
                <div>
                  <h4 className="text-xs font-semibold uppercase tracking-wider text-[var(--color-text-muted)] mb-2">
                    Output Spec
                  </h4>
                  <pre className="text-xs font-mono text-[var(--color-text-primary)] whitespace-pre-wrap break-words bg-[var(--color-bg-secondary)]/50 p-4 rounded-lg border border-[var(--color-border)]">
                    {JSON.stringify(selectedMcpTool?.output_schema ?? {}, null, 2)}
                  </pre>
                </div>
              </div>
            ) : isPersonalEditable && isEditingPersonal ? (
              <div className="flex-1 flex flex-col gap-2">
                <div className="flex items-center gap-1.5 px-2 py-1 rounded-md bg-[var(--color-accent-primary)]/5 border border-[var(--color-accent-primary)]/20 text-[10px] text-[var(--color-accent-primary)]">
                  <User className="h-3 w-3" />
                  Editing personal skill file — saved to your Databricks workspace
                </div>
                <textarea
                  value={editedPersonalContent}
                  onChange={(e) => setEditedPersonalContent(e.target.value)}
                  className="flex-1 w-full resize-none rounded-lg border border-[var(--color-border)] bg-[var(--color-bg-secondary)]/30 p-4 text-xs font-mono text-[var(--color-text-primary)] placeholder:text-[var(--color-text-muted)] focus:outline-none focus:ring-2 focus:ring-[var(--color-accent-primary)]/50 focus:border-[var(--color-accent-primary)] transition-colors"
                  placeholder="Edit skill file content..."
                  spellCheck={false}
                />
              </div>
            ) : showRawCode || !isMarkdownFile ? (
              <pre className="text-xs font-mono text-[var(--color-text-primary)] whitespace-pre-wrap break-words bg-[var(--color-bg-secondary)]/50 p-4 rounded-lg border border-[var(--color-border)]">
                {content}
              </pre>
            ) : (
              <div className="prose prose-xs max-w-none text-[var(--color-text-primary)] text-xs leading-relaxed">
                <ReactMarkdown remarkPlugins={[remarkGfm]}>{content}</ReactMarkdown>
              </div>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}
