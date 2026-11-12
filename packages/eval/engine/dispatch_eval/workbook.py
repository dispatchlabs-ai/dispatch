"""Workbook publication shared by every use case.

The publisher owns only its named sheets: it replaces them and leaves every other sheet in the workbook as it is.
A "Notes" column on an owned sheet survives regeneration, keyed by the row's leading ID columns. Headers and rows are
sized to their wrapped text, because not every viewer auto-fits.
"""
from __future__ import annotations

import json
import os
import tempfile
from pathlib import Path


def lines(text, width) -> int:
    """Wrapped line count, including long unbroken text (JSON, hashes, timestamps) that breaks mid-word."""
    room = max(1, width - 1)
    n, used = 1, 0
    for word in str(text).split():
        if len(word) > room:  # an unbroken run starts its own line and wraps every `room` characters
            n += (1 if used else 0) + (len(word) - 1) // room
            used = len(word) % room or room
        elif used and used + 1 + len(word) > room:
            n, used = n + 1, len(word)
        else:
            used += (1 if used else 0) + len(word)
    return n


class Publisher:
    def __init__(self, path: str | Path, owned: list[str]):
        from openpyxl import Workbook, load_workbook
        self.path, self.owned = Path(path), owned
        self.keep: dict = {}
        if self.path.exists():
            old = load_workbook(self.path)
            for name in owned:
                if name in old.sheetnames:
                    ws = old[name]
                    hdr = [c.value for c in ws[3]]
                    if "Notes" in hdr:
                        for row in ws.iter_rows(min_row=4, values_only=True):
                            if row[hdr.index("Notes")]:
                                self.keep[(name, json.dumps([str(x) for x in row[:3]]))] = row[hdr.index("Notes")]
            self.wb = old
            for name in owned:
                if name in self.wb.sheetnames:
                    del self.wb[name]
        else:
            self.wb = Workbook()

    def sheet(self, name: str, note: str, cols: list[tuple[str, int]], rows: list[list], notes: bool = False):
        """Notes are kept by each row's first three cells (stable IDs first)."""
        from openpyxl.styles import Alignment, Font, PatternFill
        from openpyxl.utils import get_column_letter
        ws = self.wb.create_sheet(name)
        ws["A1"], ws["A1"].font = note, Font(italic=True)
        head, fill = Font(bold=True, color="FFFFFF"), PatternFill("solid", fgColor="1F4E78")
        if notes:
            cols = cols + [("Notes", 40)]
        for n, (h, w) in enumerate(cols, 1):
            cell = ws.cell(3, n, h)
            cell.font, cell.fill, cell.alignment = head, fill, Alignment(wrap_text=True, vertical="center")
            ws.column_dimensions[get_column_letter(n)].width = w
        ws.row_dimensions[3].height = max(30, 15 * max(lines(h, w) for h, w in cols) + 6)
        for r, vals in enumerate(rows, 4):
            vals = list(vals)
            if notes:
                vals.append(self.keep.get((name, json.dumps([str(x) for x in vals[:3]]))))
            for n, v in enumerate(vals, 1):
                v = v if not isinstance(v, (list, dict)) else json.dumps(v, ensure_ascii=False)
                cell = ws.cell(r, n, v)
                width = cols[n - 1][1] if n <= len(cols) else 30
                cell.alignment = Alignment(vertical="top", wrap_text=isinstance(v, str) and len(v) > width - 1)
            ws.row_dimensions[r].height = 15 * min(12, max([1] + [lines(v, cols[n - 1][1] if n <= len(cols) else 30)
                                                           for n, v in enumerate(vals, 1) if isinstance(v, str)])) + 3
        ws.freeze_panes = "B4"
        return ws

    def save(self, first: str | None = None) -> str:
        if "Sheet" in self.wb.sheetnames and self.wb["Sheet"].max_row == 1 and self.wb["Sheet"]["A1"].value is None:
            del self.wb["Sheet"]
        if first and first in self.wb.sheetnames:
            self.wb.move_sheet(first, offset=-self.wb.sheetnames.index(first))
            self.wb.active = 0
        self.path.parent.mkdir(parents=True, exist_ok=True)
        fd, tmp = tempfile.mkstemp(prefix=f".{self.path.stem}.", suffix=self.path.suffix, dir=self.path.parent)
        os.close(fd)
        self.wb.save(tmp)
        if self.path.exists():
            os.chmod(tmp, self.path.stat().st_mode & 0o777)
        os.replace(tmp, self.path)
        return str(self.path)
