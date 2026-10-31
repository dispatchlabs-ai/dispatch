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
    repositories, selected = [], set()
    def visit(path):
        if path.name.startswith('.dispatch-'): return
        if path.is_dir() and not path.is_symlink() and (path / '.git').exists():
            trees = [Path(line[9:]) for line in git(path, 'worktree', 'list', '--porcelain').decode().splitlines() if line.startswith('worktree ')]
            common = Path(git(path, 'rev-parse', '--path-format=absolute', '--git-common-dir').decode().strip())
            common.relative_to(ROOT); selected.add(common)
            for tree in trees:
                tree.relative_to(ROOT)
                selected.update(tree / name.decode() for name in git(tree, 'ls-files', '-co', '--exclude-standard', '-z').split(b'\0') if name)
                if (tree / '.git').is_file(): selected.add(tree / '.git')
                origin = subprocess.run(['git', '-C', str(tree), 'remote', 'get-url', 'origin'], capture_output=True, text=True)
                repositories.append({'path': str(tree), 'repository': origin.stdout.strip() if not origin.returncode else None,
                    'head': git(tree, 'rev-parse', 'HEAD').decode().strip(), 'dirty': bool(git(tree, 'status', '--porcelain', '--untracked-files=all'))})
        elif path.is_dir() and not path.is_symlink():
            selected.add(path)
            for child in path.iterdir(): visit(child)
        else: selected.add(path)
    for child in ROOT.iterdir(): visit(child)
    return repositories, selected


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


if sys.argv[1] == 'restore': restore(sys.argv[2])
else:
    repositories, files = inventory()
    if sys.argv[1] == 'save':
        with tarfile.open(sys.argv[2], 'w:gz', dereference=False) as archive:
            for path in sorted(files):
                if path.exists() or path.is_symlink(): archive.add(path, arcname=str(path.relative_to(ROOT)), recursive=not path.is_dir() or path.name == '.git')
            downloads = Path('/home/cua/Downloads')
            if downloads.exists(): archive.add(downloads, arcname='.dispatch-downloads')
        with tarfile.open(sys.argv[2], 'r:gz') as archive: validate(archive)
    print(json.dumps({'repositories': repositories}))
