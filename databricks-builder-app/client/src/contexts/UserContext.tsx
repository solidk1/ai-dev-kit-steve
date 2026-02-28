import {
  createContext,
  useContext,
  useEffect,
  useState,
  type ReactNode,
} from "react";
import { fetchUserInfo } from "@/lib/api";
import type { UserInfo } from "@/lib/types";

interface UserContextType {
  user: string | null;
  workspaceUrl: string | null;
  lakebaseConfigured: boolean;
  lakebaseError: string | null;
  appName: string | null;
  appVersion: string | null;
  model: string | null;
  modelMini: string | null;
  loading: boolean;
  error: Error | null;
}

const UserContext = createContext<UserContextType | null>(null);

export function UserProvider({ children }: { children: ReactNode }) {
  const [userInfo, setUserInfo] = useState<UserInfo | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<Error | null>(null);

  useEffect(() => {
    const loadUser = async () => {
      try {
        const info = await fetchUserInfo();
        setUserInfo(info);
      } catch (err) {
        setError(err instanceof Error ? err : new Error(String(err)));
      } finally {
        setLoading(false);
      }
    };

    loadUser();
  }, []);

  const value: UserContextType = {
    user: userInfo?.user || null,
    workspaceUrl: userInfo?.workspace_url || null,
    lakebaseConfigured: userInfo?.lakebase_configured || false,
    lakebaseError: userInfo?.lakebase_error || null,
    appName: userInfo?.app_name || null,
    appVersion: userInfo?.app_version || null,
    model: userInfo?.model || null,
    modelMini: userInfo?.model_mini || null,
    loading,
    error,
  };

  return <UserContext.Provider value={value}>{children}</UserContext.Provider>;
}

export function useUser() {
  const context = useContext(UserContext);
  if (!context) {
    throw new Error("useUser must be used within a UserProvider");
  }
  return context;
}
