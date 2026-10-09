import { ArrowDownToLine, ArrowUpFromLine } from "lucide-react";
import { useState } from "react";
import type { ChatSummary, Project } from "../shared/contracts";
import { ProjectArchiveExportForm } from "./project-archives";
import { Button, Field, Modal, Select } from "./ui";

export function ImportExportPage({ projects, chats, onImport }: {
  projects: Project[];
  chats: ChatSummary[];
  onImport: () => void;
}) {
  const [exportBusy, setExportBusy] = useState(false);
  const [exportOpen, setExportOpen] = useState(false);
  const [projectId, setProjectId] = useState("");
  const managedProjects = projects.filter(project => project.canManage);
  const project = managedProjects.find(project => project.id === projectId);
  return <section className="agent-view connections-page">
    <header className="view-heading"><h1>Import &amp; export</h1></header>
    <div className="agent-content"><section className="archive-settings" aria-labelledby="archive-projects-heading">
      <h2 id="archive-projects-heading">Projects</h2>
      <div className="archive-settings-row">
        <ArrowDownToLine size={22} aria-hidden="true" />
        <div><h3>Import project</h3><p>Create a project from a Dispatch archive.</p></div>
        <Button variant="secondary" onClick={onImport}>Choose file</Button>
      </div>
      <div className="archive-settings-row">
        <ArrowUpFromLine size={22} aria-hidden="true" />
        <div><h3>Export project</h3><p>Save a project and its history.</p></div>
        <Button variant="secondary" disabled={!managedProjects.length} onClick={() => setExportOpen(true)}>Select project</Button>
      </div>
      {!managedProjects.length ? <p className="field-hint">No projects available to export.</p> : null}
    </section></div>
    <Modal title="Export project" open={exportOpen} onOpenChange={setExportOpen} keepMounted>
      <div className="project-archive-panel">
        <Field label="Project">{props => <Select {...props} value={project?.id ?? ""} disabled={exportBusy} onChange={event => setProjectId(event.target.value)}>
          <option value="">Choose a project</option>
          {managedProjects.map(item => <option key={item.id} value={item.id}>{item.name}</option>)}
        </Select>}</Field>
        {project ? <ProjectArchiveExportForm key={project.id} project={project} chats={chats} onBusyChange={setExportBusy} /> : null}
      </div>
    </Modal>
  </section>;
}
