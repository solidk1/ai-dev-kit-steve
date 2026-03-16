import { useCallback, useEffect, useState } from 'react';
import { Cpu, Eye, EyeOff, Key, Loader2, Save, Settings, User } from 'lucide-react';
import { toast } from 'sonner';
import { MainLayout } from '@/components/layout/MainLayout';
import { useUser } from '@/contexts/UserContext';
import { deletePat, fetchUserSettings, savePat, saveUserSettings } from '@/lib/api';
import type { UserSettings } from '@/lib/types';
import { cn } from '@/lib/utils';

/** Format email prefix into display name: "steve.shao" -> "Steve Shao" */
function emailToDisplayName(email: string): string {
  const prefix = email.includes('@') ? email.split('@')[0] : email;
  return prefix
    .split('.')
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
    .join(' ');
}

function Section({
  icon: Icon,
  title,
  children,
}: {
  icon: React.ElementType;
  title: string;
  children: React.ReactNode;
}) {
  return (
    <div className="rounded-xl border border-[var(--color-border)] bg-[var(--color-bg-secondary)]/30 overflow-hidden">
      <div className="flex items-center gap-2.5 px-5 py-3.5 border-b border-[var(--color-border)]/60 bg-[var(--color-bg-secondary)]/50">
        <Icon className="h-4 w-4 text-[var(--color-accent-primary)]" />
        <h2 className="text-sm font-semibold text-[var(--color-text-heading)]">{title}</h2>
      </div>
      <div className="px-5 py-1">{children}</div>
    </div>
  );
}

function InfoRow({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex items-center justify-between py-3 border-b border-[var(--color-border)]/40 last:border-0">
      <span className="text-sm text-[var(--color-text-muted)]">{label}</span>
      <span className="text-sm font-mono text-[var(--color-text-primary)] text-right max-w-[60%] truncate">
        {value || '\u2014'}
      </span>
    </div>
  );
}

function ConfigField({
  label,
  value,
  placeholder,
  onChange,
  disabled,
  type = 'text',
  trailing,
}: {
  label: string;
  value: string;
  placeholder?: string;
  onChange: (v: string) => void;
  disabled?: boolean;
  type?: string;
  trailing?: React.ReactNode;
}) {
  return (
    <div className="flex items-center gap-4 py-3 border-b border-[var(--color-border)]/40 last:border-0">
      <label className="text-sm text-[var(--color-text-muted)] w-36 flex-shrink-0">{label}</label>
      <div className="relative flex-1">
        <input
          type={type}
          value={value}
          placeholder={placeholder ?? ''}
          onChange={(e) => onChange(e.target.value)}
          disabled={disabled}
          className={cn(
            'w-full rounded-lg border border-[var(--color-border)] bg-[var(--color-bg-secondary)]/50 px-3 py-1.5 text-sm font-mono text-[var(--color-text-primary)]',
            trailing && 'pr-9',
            'placeholder:text-[var(--color-text-muted)]/50',
            'focus:outline-none focus:ring-2 focus:ring-[var(--color-accent-primary)]/40 focus:border-[var(--color-accent-primary)]',
            'transition-colors disabled:opacity-50 disabled:cursor-not-allowed'
          )}
        />
        {trailing && (
          <div className="absolute right-2 top-1/2 -translate-y-1/2">
            {trailing}
          </div>
        )}
      </div>
    </div>
  );
}

export default function SettingsPage() {
  const { user: userEmail } = useUser();
  const [settings, setSettings] = useState<UserSettings | null>(null);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);

  // Editable fields
  const [defaultCatalog, setDefaultCatalog] = useState('');
  const [defaultSchema, setDefaultSchema] = useState('');
  const [workspaceFolder, setWorkspaceFolder] = useState('');
  const [model, setModel] = useState('');
  const [modelMini, setModelMini] = useState('');
  const [patInput, setPatInput] = useState('');
  const [savedPat, setSavedPat] = useState(''); // tracks what's in the DB
  const [showPat, setShowPat] = useState(false);

  useEffect(() => {
    fetchUserSettings()
      .then((data) => {
        setSettings(data);
        setDefaultCatalog(data.default_catalog ?? '');
        setDefaultSchema(data.default_schema ?? '');
        setWorkspaceFolder(data.workspace_folder ?? '');
        setModel(data.model ?? '');
        setModelMini(data.model_mini ?? '');
        setPatInput(data.databricks_pat ?? '');
        setSavedPat(data.databricks_pat ?? '');
      })
      .catch((err) => {
        console.error('Failed to load settings:', err);
        toast.error('Failed to load settings');
      })
      .finally(() => setLoading(false));
  }, []);

  const handleSave = useCallback(async () => {
    // Validate PAT format if entered
    const trimmedPat = patInput.trim();
    if (trimmedPat && !trimmedPat.startsWith('dapi')) {
      toast.error('PAT must start with "dapi"');
      return;
    }

    setSaving(true);
    try {
      // Save config settings
      await saveUserSettings({
        defaultCatalog: defaultCatalog || null,
        defaultSchema: defaultSchema || null,
        workspaceFolder: workspaceFolder || null,
        model: model || null,
        modelMini: modelMini || null,
      });

      // Save or delete PAT if changed from what's in the DB
      if (trimmedPat !== savedPat) {
        if (trimmedPat) {
          await savePat(trimmedPat);
        } else {
          await deletePat();
        }
        setSavedPat(trimmedPat);
      }

      toast.success('Settings saved');
    } catch (err) {
      console.error('Failed to save settings:', err);
      toast.error(`Failed to save: ${err instanceof Error ? err.message : String(err)}`);
    } finally {
      setSaving(false);
    }
  }, [defaultCatalog, defaultSchema, workspaceFolder, model, modelMini, patInput, savedPat]);

  const displayName = userEmail ? emailToDisplayName(userEmail) : '';
  const email = userEmail ?? '';

  return (
    <MainLayout>
      <div className="flex-1 overflow-y-auto">
        <div className="max-w-2xl mx-auto px-6 py-10 space-y-6">
          {/* Header */}
          <div className="flex items-center gap-3 pb-2">
            <div className="w-10 h-10 rounded-xl bg-[var(--color-accent-primary)]/10 border border-[var(--color-accent-primary)]/20 flex items-center justify-center flex-shrink-0">
              <Settings className="h-5 w-5 text-[var(--color-accent-primary)]" />
            </div>
            <h1 className="text-2xl font-bold text-[var(--color-text-heading)]">Settings</h1>
          </div>

          {loading ? (
            <div className="flex items-center justify-center py-20">
              <Loader2 className="h-6 w-6 animate-spin text-[var(--color-accent-primary)]" />
            </div>
          ) : (
            <>
              {/* User Info (non-editable) */}
              <Section icon={User} title="User Info">
                <InfoRow label="Username" value={displayName} />
                <InfoRow label="Email" value={email} />
              </Section>

              {/* Databricks PAT */}
              <Section icon={Key} title="Databricks Personal Access Token">
                <ConfigField
                  label="Access Token"
                  value={patInput}
                  placeholder="dapi..."
                  onChange={setPatInput}
                  disabled={saving}
                  type={showPat ? 'text' : 'password'}
                  trailing={
                    <button
                      type="button"
                      onClick={() => setShowPat(!showPat)}
                      className="text-[var(--color-text-muted)] hover:text-[var(--color-text-primary)] transition-colors"
                    >
                      {showPat ? <EyeOff className="h-4 w-4" /> : <Eye className="h-4 w-4" />}
                    </button>
                  }
                />
                <p className="text-xs text-[var(--color-text-muted)]/70 leading-relaxed py-2">
                  Used for all Databricks resource access: clusters, warehouses, workspace files, and tool execution.
                  Stored encrypted. Generate at <span className="font-mono">Settings &gt; Developer &gt; Access Tokens</span> in your workspace.
                </p>
              </Section>

              {/* Configuration (editable) */}
              <Section icon={Cpu} title="Configuration">
                <ConfigField
                  label="Default Catalog"
                  value={defaultCatalog}
                  placeholder="e.g. main"
                  onChange={setDefaultCatalog}
                  disabled={saving}
                />
                <ConfigField
                  label="Default Schema"
                  value={defaultSchema}
                  placeholder="e.g. default"
                  onChange={setDefaultSchema}
                  disabled={saving}
                />
                <ConfigField
                  label="Workspace Folder"
                  value={workspaceFolder}
                  placeholder="/Workspace/Users/..."
                  onChange={setWorkspaceFolder}
                  disabled={saving}
                />
                <ConfigField
                  label="Primary Model"
                  value={model}
                  placeholder={settings?.server_model ?? 'server default'}
                  onChange={setModel}
                  disabled={saving}
                />
                <ConfigField
                  label="Mini Model"
                  value={modelMini}
                  placeholder={settings?.server_model_mini ?? 'server default'}
                  onChange={setModelMini}
                  disabled={saving}
                />
              </Section>

              {/* Save button */}
              <div className="flex justify-end">
                <button
                  onClick={handleSave}
                  disabled={saving}
                  className="flex items-center gap-2 px-4 py-2 rounded-lg text-sm font-medium bg-[var(--color-accent-primary)] text-white hover:bg-[var(--color-accent-secondary)] transition-colors disabled:opacity-50 disabled:cursor-not-allowed shadow-sm"
                >
                  {saving ? (
                    <Loader2 className="h-4 w-4 animate-spin" />
                  ) : (
                    <Save className="h-4 w-4" />
                  )}
                  {saving ? 'Saving...' : 'Save Changes'}
                </button>
              </div>
            </>
          )}
        </div>
      </div>
    </MainLayout>
  );
}
