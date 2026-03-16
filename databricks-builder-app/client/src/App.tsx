import { Routes, Route, Navigate } from "react-router-dom";
import { Toaster } from "sonner";
import { UserProvider } from "./contexts/UserContext";
import { ProjectsProvider } from "./contexts/ProjectsContext";
import HomePage from "./pages/HomePage";
import ProjectPage from "./pages/ProjectPage";
import ProjectSkillsPage from "./pages/ProjectSkillsPage";
import DocPage from "./pages/DocPage";
import SettingsPage from "./pages/SettingsPage";

function App() {
  return (
    <UserProvider>
      <ProjectsProvider>
        <div className="min-h-screen bg-background">
          <Routes>
            <Route path="/" element={<HomePage />} />
            <Route path="/doc" element={<DocPage />} />
            <Route path="/settings" element={<SettingsPage />} />
            <Route path="/projects/:projectId" element={<ProjectPage />} />
            <Route path="/projects/:projectId/skills" element={<ProjectSkillsPage />} />
            <Route path="*" element={<Navigate to="/" replace />} />
          </Routes>
          <Toaster position="bottom-right" />
        </div>
      </ProjectsProvider>
    </UserProvider>
  );
}

export default App;
