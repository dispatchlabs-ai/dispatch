#!/usr/bin/env python3
"""Preserve workflow source and results while excluding repository-ignored caches."""
import json
import os
from pathlib import Path
import subprocess
import sys
import tarfile

ROOT = Path('/workspace')


def git(path, *args):
    return subprocess.check_output(['git', '-C', str(path), *args])


def inventory():
    repositories, selected, common_directories, visited = [], set(), set(), set()
    def visit(path):
        if path.name.startswith('.dispatch-'): return
        if path.is_dir() and not path.is_symlink() and (path / '.git').exists():
            trees = [Path(os.fsdecode(field[9:])) for field in git(path, 'worktree', 'list', '--porcelain', '-z').split(b'\0') if field.startswith(b'worktree ')]
            common = Path(git(path, 'rev-parse', '--path-format=absolute', '--git-common-dir').decode().strip())
            working_tree = Path(git(path, 'rev-parse', '--show-toplevel').decode().strip())
            # Submodules and separate-git-dir repositories can list their Git
            # directory as the primary worktree. Use the actual checkout.
            trees = list(dict.fromkeys([working_tree, *(working_tree if tree == common else tree for tree in trees)]))
            common.relative_to(ROOT); selected.add(common); common_directories.add(common)
            for tree in trees:
                tree.relative_to(ROOT)
                if tree in visited: continue
                visited.add(tree)
                files = {tree / os.fsdecode(name) for name in git(tree, 'ls-files', '-co', '--exclude-standard', '-z').split(b'\0') if name}
                selected.update(files)
                if (tree / '.git').is_file(): selected.add(tree / '.git')
                origin = subprocess.run(['git', '-C', str(tree), 'remote', 'get-url', 'origin'], capture_output=True, text=True)
                repositories.append({'path': str(tree), 'repository': origin.stdout.strip() if not origin.returncode else None,
                    'head': git(tree, 'rev-parse', 'HEAD').decode().strip(), 'dirty': bool(git(tree, 'status', '--porcelain', '--untracked-files=all'))})
                # Git lists a submodule as a directory, not the files it owns.
                # Re-enter each initialized repository so its own ignore rules
                # and nested submodules apply, preserving dirty/untracked work.
                for child in sorted(files):
                    if child.is_dir() and not child.is_symlink(): visit(child)
        elif path.is_dir() and not path.is_symlink():
            selected.add(path)
            for child in path.iterdir(): visit(child)
        else: selected.add(path)
    for child in ROOT.iterdir(): visit(child)
    return repositories, selected, common_directories


def validate(archive):
    # Archives are checksum-verified before entering the guest. Still reject
    # path/link escapes so old or externally supplied archives cannot cross roots.
    members = archive.getmembers()
    for member in members:
        tarfile.data_filter(member, str(ROOT))
        target = ROOT / member.name
        target.resolve().relative_to(ROOT)
        if member.issym(): (target.parent / member.linkname).resolve().relative_to(ROOT)
        if member.islnk(): (ROOT / member.linkname).resolve().relative_to(ROOT)
        if not (member.isfile() or member.isdir() or member.issym() or member.islnk()): raise ValueError('Unsupported archive entry')
    return members


def restore(path):
    with tarfile.open(path, 'r:gz') as archive:
        archive.extractall(ROOT, members=validate(archive), filter='data')
    downloads = ROOT / '.dispatch-downloads'
    if downloads.exists():
        import shutil
        shutil.copytree(downloads, '/home/cua/Downloads', dirs_exist_ok=True); shutil.rmtree(downloads)


def main():
    if sys.argv[1] == 'restore': restore(sys.argv[2])
    else:
        repositories, files, common_directories = inventory()
        if sys.argv[1] == 'save':
            with tarfile.open(sys.argv[2], 'w:gz', dereference=False) as archive:
                for path in sorted(files):
                    if any(parent in common_directories for parent in path.parents): continue
                    if path.exists() or path.is_symlink():
                        archive.add(path, arcname=str(path.relative_to(ROOT)), recursive=path in common_directories)
                downloads = Path('/home/cua/Downloads')
                if downloads.exists(): archive.add(downloads, arcname='.dispatch-downloads')
            with tarfile.open(sys.argv[2], 'r:gz') as archive: validate(archive)
        print(json.dumps({'repositories': repositories}))


if __name__ == '__main__': main()
