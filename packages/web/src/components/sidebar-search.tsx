import { Search } from "lucide-react";

export function SidebarSearch({ label, value, onChange }: { label: string; value: string; onChange: (value: string) => void }) {
  return <label className="sidebar-search">
    <span className="sr-only">{label}</span>
    <Search size={15} aria-hidden="true" />
    <input type="search" value={value} onChange={event => onChange(event.target.value)} placeholder={label} />
  </label>;
}
