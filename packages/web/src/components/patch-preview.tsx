import { parsePatchFiles } from "@pierre/diffs";
import { useMemo } from "react";
import FileDiff from "./file-diff";

export default function PatchPreview({ patch, path }: { patch: string; path: string }) {
  useMemo(() => {
    const parsed = parsePatchFiles(patch, undefined, true);
    if (!parsed.some(commit => commit.files.length > 0)) throw new Error("No diff files found");
  }, [patch]);
  return <FileDiff kind="edit" path={path} patch={patch} showFileHeader />;
}
