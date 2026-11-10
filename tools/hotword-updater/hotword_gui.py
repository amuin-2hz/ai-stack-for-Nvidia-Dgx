#!/usr/bin/env python3
"""AI Stack 热词更新器 —— GTK4 桌面小工具。

标签页：
  · ASR 热词：单列热词
  · TTS 读音：词/读音/备注
  · 设置：配置两个热词文件的路径

默认路径：
  ASR  ~/.local/share/ai-stack/cache/asr_hotwords.txt
  TTS  ~/.local/share/ai-stack/cache/lexicon.json
两个文件都通过 bind mount 进入容器，服务端按 mtime 热更新，保存后立即生效。
"""
from __future__ import annotations

import json
import os
import pathlib
import re
import zipfile
from xml.etree import ElementTree as ET
from xml.sax.saxutils import escape as xml_escape

import gi

gi.require_version("Gtk", "4.0")
gi.require_version("Gdk", "4.0")
from gi.repository import Gdk, Gio, GLib, Gtk  # noqa: E402

APP_ID = "ai.amuin.hotwords"
NL = chr(10)

WORKSPACE = pathlib.Path(
    os.environ.get("AI_STACK_BASE", pathlib.Path.home() / ".local/share/ai-stack")
)
CACHE_DIR = WORKSPACE / "cache"
DEFAULT_ASR_FILE = pathlib.Path(
    os.environ.get("AI_STACK_ASR_HOTWORDS", CACHE_DIR / "asr_hotwords.txt")
)
DEFAULT_TTS_FILE = pathlib.Path(
    os.environ.get("QWEN3_TTS_LEXICON", CACHE_DIR / "lexicon.json")
)

CONFIG_DIR = pathlib.Path(os.environ.get("XDG_CONFIG_HOME", pathlib.Path.home() / ".config")) / "hotword-updater"
CONFIG_FILE = CONFIG_DIR / "settings.json"

# 运行期生效的路径（设置页可改）
ASR_FILE = DEFAULT_ASR_FILE
TTS_FILE = DEFAULT_TTS_FILE

SPLIT_RE = re.compile(r"[,，、;；" + re.escape(NL) + r"]+")

XLSX_NS = "http://schemas.openxmlformats.org/spreadsheetml/2006/main"
XLSX_T = "{" + XLSX_NS + "}t"
ASR_HEADERS = {"热词", "词", "词语", "term", "word", "asr", "asr热词"}
TTS_HEADERS = {"词", "词语", "热词", "term", "word", "原文"}


# ---------------------------------------------------------------- 配置
def expand_path(value: str, fallback: pathlib.Path) -> pathlib.Path:
    text = (value or "").strip()
    if not text:
        return fallback
    return pathlib.Path(os.path.expanduser(text)).absolute()


def load_settings() -> tuple[pathlib.Path, pathlib.Path]:
    try:
        data = json.loads(CONFIG_FILE.read_text(encoding="utf-8"))
    except Exception:  # noqa: BLE001
        return DEFAULT_ASR_FILE, DEFAULT_TTS_FILE
    return (
        expand_path(str(data.get("asr_file", "")), DEFAULT_ASR_FILE),
        expand_path(str(data.get("tts_file", "")), DEFAULT_TTS_FILE),
    )


def save_settings(asr_path: pathlib.Path, tts_path: pathlib.Path) -> None:
    CONFIG_DIR.mkdir(parents=True, exist_ok=True)
    tmp = CONFIG_FILE.with_name(CONFIG_FILE.name + ".tmp")
    tmp.write_text(
        json.dumps({"asr_file": str(asr_path), "tts_file": str(tts_path)}, ensure_ascii=False, indent=2) + NL,
        encoding="utf-8",
    )
    os.replace(tmp, CONFIG_FILE)


def set_paths(asr_path: pathlib.Path, tts_path: pathlib.Path) -> None:
    global ASR_FILE, TTS_FILE
    ASR_FILE = asr_path
    TTS_FILE = tts_path


# ---------------------------------------------------------------- 工具函数
def split_terms(raw: str) -> list[str]:
    return list(dict.fromkeys(t.strip() for t in SPLIT_RE.split(raw) if t.strip()))


def atomic_write(path: pathlib.Path, text: str) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    tmp = path.with_name(path.name + ".tmp")
    tmp.write_text(text, encoding="utf-8")
    os.replace(tmp, path)


def load_asr() -> list[str]:
    try:
        return split_terms(ASR_FILE.read_text(encoding="utf-8"))
    except Exception:  # noqa: BLE001
        return []


def save_asr(terms: list[str]) -> None:
    atomic_write(ASR_FILE, NL.join(terms) + (NL if terms else ""))


def load_tts() -> list[dict]:
    try:
        data = json.loads(TTS_FILE.read_text(encoding="utf-8"))
    except Exception:  # noqa: BLE001
        return []
    out = []
    for item in data.get("entries", []) if isinstance(data, dict) else []:
        term = str(item.get("term", "")).strip()
        say = str(item.get("say", "")).strip()
        if term and say:
            out.append({"term": term, "say": say, "note": str(item.get("note", "")).strip()})
    return out


def save_tts(entries: list[dict]) -> None:
    atomic_write(
        TTS_FILE,
        json.dumps({"entries": entries}, ensure_ascii=False, indent=2) + NL,
    )


def col_index(letters: str) -> int:
    n = 0
    for ch in letters:
        n = n * 26 + (ord(ch) - 64)
    return n - 1


def read_xlsx_rows(path: str) -> list[list[str]]:
    rows: list[list[str]] = []
    with zipfile.ZipFile(path) as z:
        names = z.namelist()
        shared: list[str] = []
        if "xl/sharedStrings.xml" in names:
            root = ET.fromstring(z.read("xl/sharedStrings.xml"))
            for si in root.findall("{" + XLSX_NS + "}si"):
                shared.append("".join(t.text or "" for t in si.iter(XLSX_T)))
        sheets = sorted(n for n in names if re.fullmatch(r"xl/worksheets/sheet\d+\.xml", n))
        if not sheets:
            return []
        root = ET.fromstring(z.read(sheets[0]))
        sheet_data = root.find("{" + XLSX_NS + "}sheetData")
        if sheet_data is None:
            return []
        for row in sheet_data.findall("{" + XLSX_NS + "}row"):
            cells: dict[int, str] = {}
            for c in row.findall("{" + XLSX_NS + "}c"):
                ref = c.get("r") or ""
                m = re.match(r"([A-Z]+)", ref)
                if not m:
                    continue
                idx = col_index(m.group(1))
                ctype = c.get("t")
                val = ""
                if ctype == "inlineStr":
                    is_el = c.find("{" + XLSX_NS + "}is")
                    if is_el is not None:
                        val = "".join(t.text or "" for t in is_el.iter(XLSX_T))
                else:
                    v = c.find("{" + XLSX_NS + "}v")
                    if v is not None and v.text is not None:
                        if ctype == "s":
                            try:
                                val = shared[int(v.text)]
                            except (ValueError, IndexError):
                                val = ""
                        else:
                            val = v.text
                cells[idx] = val.strip()
            if cells:
                rows.append([cells.get(i, "") for i in range(max(cells) + 1)])
    return rows


def _cell_xml(ref: str, text: str) -> str:
    return (
        '<c r="' + ref + '" t="inlineStr"><is><t xml:space="preserve">'
        + xml_escape(text)
        + "</t></is></c>"
    )


def write_sample_xlsx(path: str, headers: list[str], rows: list[list[str]]) -> None:
    letters = "ABCDEFGH"
    sheet_rows = []
    all_rows = [headers] + rows
    for r_idx, row in enumerate(all_rows, start=1):
        cells = "".join(
            _cell_xml(letters[c_idx] + str(r_idx), value)
            for c_idx, value in enumerate(row)
            if value != ""
        )
        sheet_rows.append('<row r="' + str(r_idx) + '">' + cells + "</row>")
    sheet = (
        '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>'
        '<worksheet xmlns="' + XLSX_NS + '"><sheetData>'
        + "".join(sheet_rows)
        + "</sheetData></worksheet>"
    )
    content_types = (
        '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>'
        '<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">'
        '<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>'
        '<Default Extension="xml" ContentType="application/xml"/>'
        '<Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/>'
        '<Override PartName="/xl/worksheets/sheet1.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/>'
        "</Types>"
    )
    rels = (
        '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>'
        '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">'
        '<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/>'
        "</Relationships>"
    )
    workbook = (
        '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>'
        '<workbook xmlns="' + XLSX_NS + '" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships">'
        '<sheets><sheet name="Sheet1" sheetId="1" r:id="rId1"/></sheets></workbook>'
    )
    wb_rels = (
        '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>'
        '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">'
        '<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet1.xml"/>'
        "</Relationships>"
    )
    with zipfile.ZipFile(path, "w", zipfile.ZIP_DEFLATED) as z:
        z.writestr("[Content_Types].xml", content_types)
        z.writestr("_rels/.rels", rels)
        z.writestr("xl/workbook.xml", workbook)
        z.writestr("xl/_rels/workbook.xml.rels", wb_rels)
        z.writestr("xl/worksheets/sheet1.xml", sheet)


# ---------------------------------------------------------------- 热词标签页
class HotwordTab(Gtk.Box):
    def __init__(self, mode: str):
        super().__init__(orientation=Gtk.Orientation.VERTICAL, spacing=0)
        self.mode = mode  # "asr" | "tts"
        self.records: list = []
        self.search_text = ""
        self.monitor = None

        paned = Gtk.Paned(orientation=Gtk.Orientation.HORIZONTAL)
        paned.set_wide_handle(True)
        paned.set_position(430)
        paned.set_vexpand(True)
        paned.set_resize_start_child(True)
        paned.set_shrink_start_child(False)

        # ---------------- 左：已有列表
        left = Gtk.Box(orientation=Gtk.Orientation.VERTICAL, spacing=10)
        left.set_margin_top(16)
        left.set_margin_bottom(16)
        left.set_margin_start(16)
        left.set_margin_end(8)

        toolbar = Gtk.Box(orientation=Gtk.Orientation.HORIZONTAL, spacing=8)
        self.count_label = Gtk.Label(label="")
        self.count_label.set_xalign(0)
        self.count_label.add_css_class("muted")
        toolbar.append(self.count_label)
        spacer = Gtk.Box()
        spacer.set_hexpand(True)
        toolbar.append(spacer)
        reload_btn = Gtk.Button(label="重新载入")
        reload_btn.add_css_class("flat")
        reload_btn.set_tooltip_text("从磁盘重新读取（外部修改后使用）")
        reload_btn.connect("clicked", lambda *_: self.reload_data())
        toolbar.append(reload_btn)
        left.append(toolbar)

        self.search = Gtk.SearchEntry()
        self.search.set_placeholder_text("搜索已有热词")
        self.search.connect("search-changed", self.on_search)
        left.append(self.search)

        self.list_box = Gtk.ListBox()
        self.list_box.set_selection_mode(Gtk.SelectionMode.SINGLE)
        self.list_box.add_css_class("card-list")
        self.list_box.connect("row-selected", lambda *_: self.update_delete_state())
        scrolled = Gtk.ScrolledWindow()
        scrolled.set_child(self.list_box)
        scrolled.set_vexpand(True)
        scrolled.add_css_class("card")
        left.append(scrolled)

        self.delete_btn = Gtk.Button(label="删除选中")
        self.delete_btn.set_halign(Gtk.Align.END)
        self.delete_btn.add_css_class("destructive-action")
        self.delete_btn.connect("clicked", self.on_delete)
        self.delete_btn.set_sensitive(False)
        left.append(self.delete_btn)

        # ---------------- 右：输入区
        right = Gtk.Box(orientation=Gtk.Orientation.VERTICAL, spacing=14)
        right.set_margin_top(16)
        right.set_margin_bottom(16)
        right.set_margin_start(8)
        right.set_margin_end(16)

        add_card = Gtk.Box(orientation=Gtk.Orientation.VERTICAL, spacing=12)
        add_card.add_css_class("card")
        add_title = Gtk.Label(label="添加")
        add_title.set_xalign(0)
        add_title.add_css_class("section-title")
        add_card.append(add_title)

        grid = Gtk.Grid()
        grid.set_column_spacing(10)
        grid.set_row_spacing(8)
        grid.set_hexpand(True)
        if mode == "asr":
            self.entry_a = Gtk.Entry()
            self.entry_a.set_placeholder_text("例如：网络安全等级保护")
            self.entry_a.set_hexpand(True)
            self.entry_a.connect("activate", lambda *_: self.on_add())
            grid.attach(self._field_label("热词"), 0, 0, 1, 1)
            grid.attach(self.entry_a, 1, 0, 1, 1)
            self.entry_b = None
            self.entry_note = None
        else:
            self.entry_a = Gtk.Entry()
            self.entry_a.set_placeholder_text("例如：AI")
            self.entry_a.set_hexpand(True)
            self.entry_b = Gtk.Entry()
            self.entry_b.set_placeholder_text("例如：爱")
            self.entry_b.set_hexpand(True)
            self.entry_b.connect("activate", lambda *_: self.on_add())
            self.entry_note = Gtk.Entry()
            self.entry_note.set_placeholder_text("可不填")
            self.entry_note.set_hexpand(True)
            self.entry_note.connect("activate", lambda *_: self.on_add())
            grid.attach(self._field_label("词"), 0, 0, 1, 1)
            grid.attach(self.entry_a, 1, 0, 1, 1)
            grid.attach(self._field_label("读音"), 0, 1, 1, 1)
            grid.attach(self.entry_b, 1, 1, 1, 1)
            grid.attach(self._field_label("备注"), 0, 2, 1, 1)
            grid.attach(self.entry_note, 1, 2, 1, 1)
        add_card.append(grid)

        add_row = Gtk.Box(orientation=Gtk.Orientation.HORIZONTAL, spacing=8)
        add_row.set_halign(Gtk.Align.END)
        self.add_btn = Gtk.Button(label="添加")
        self.add_btn.add_css_class("suggested-action")
        self.add_btn.set_size_request(96, -1)
        self.add_btn.connect("clicked", self.on_add)
        add_row.append(self.add_btn)
        add_card.append(add_row)
        right.append(add_card)

        import_card = Gtk.Box(orientation=Gtk.Orientation.VERTICAL, spacing=10)
        import_card.add_css_class("card")
        import_title = Gtk.Label(label="从 Excel 批量导入")
        import_title.set_xalign(0)
        import_title.add_css_class("section-title")
        import_card.append(import_title)

        self.drop_zone = Gtk.Box(orientation=Gtk.Orientation.VERTICAL, spacing=6)
        self.drop_zone.add_css_class("drop-zone")
        self.drop_zone.set_size_request(-1, 132)
        self.drop_zone.set_valign(Gtk.Align.CENTER)
        icon = Gtk.Image.new_from_icon_name("document-open-symbolic")
        icon.set_pixel_size(28)
        icon.add_css_class("muted")
        drop_label = Gtk.Label(label="把 .xlsx 文件拖到这里")
        drop_hint = Gtk.Label(label=self._sample_hint())
        drop_hint.add_css_class("muted")
        drop_hint.set_wrap(True)
        drop_hint.set_justify(Gtk.Justification.CENTER)
        self.drop_zone.append(icon)
        self.drop_zone.append(drop_label)
        self.drop_zone.append(drop_hint)
        import_card.append(self.drop_zone)

        target = Gtk.DropTarget.new(Gdk.FileList, Gdk.DragAction.COPY)
        target.connect("drop", self.on_drop)
        target.connect("enter", lambda *_: self._drag_highlight(True))
        target.connect("leave", lambda *_: self._drag_highlight(False))
        self.drop_zone.add_controller(target)

        sample_row = Gtk.Box(orientation=Gtk.Orientation.HORIZONTAL, spacing=8)
        sample_row.set_halign(Gtk.Align.END)
        self.sample_btn = Gtk.Button(label="下载样例文件")
        self.sample_btn.add_css_class("flat")
        self.sample_btn.connect("clicked", self.on_download_sample)
        sample_row.append(self.sample_btn)
        import_card.append(sample_row)
        right.append(import_card)

        right_spacer = Gtk.Box()
        right_spacer.set_vexpand(True)
        right.append(right_spacer)

        paned.set_start_child(left)
        paned.set_end_child(right)
        self.append(paned)

        status_bar = Gtk.Box(orientation=Gtk.Orientation.HORIZONTAL, spacing=8)
        status_bar.add_css_class("status-bar")
        status_bar.set_size_request(-1, 42)
        self.status = Gtk.Label(label="")
        self.status.set_xalign(0)
        self.status.set_ellipsize(3)
        self.status.set_hexpand(True)
        status_bar.append(self.status)
        self.append(status_bar)

        self.start_monitor()
        self.reload_data()

    # ---------------- 小部件
    def _field_label(self, text: str) -> Gtk.Label:
        label = Gtk.Label(label=text)
        label.set_xalign(1)
        label.set_valign(Gtk.Align.CENTER)
        label.add_css_class("muted")
        label.set_size_request(52, -1)
        return label

    # ---------------- 数据
    def data_path(self) -> pathlib.Path:
        return ASR_FILE if self.mode == "asr" else TTS_FILE

    def rebind(self):
        """设置页改了路径后调用：换监听目录并重新载入。"""
        if self.monitor is not None:
            try:
                self.monitor.cancel()
            except Exception:  # noqa: BLE001
                pass
            self.monitor = None
        self.search.set_text("")
        self.search_text = ""
        self.start_monitor()
        self.reload_data()

    def reload_data(self):
        self.records = load_asr() if self.mode == "asr" else load_tts()
        self.refresh()
        self.set_status("已载入 " + str(self.data_path()))

    def persist(self):
        if self.mode == "asr":
            save_asr(self.records)
        else:
            save_tts(self.records)

    def _sample_hint(self) -> str:
        if self.mode == "asr":
            return "样例格式：单列，表头「热词」"
        return "样例格式：三列，表头「词 / 读音 / 备注」"

    # ---------------- 文件监听
    def start_monitor(self):
        try:
            path = self.data_path()
            self._basename = path.name
            directory = Gio.File.new_for_path(str(path.parent))
            self.monitor = directory.monitor_directory(Gio.FileMonitorFlags.NONE, None)
            self.monitor.connect("changed", self.on_file_changed)
        except Exception:  # noqa: BLE001
            self.monitor = None

    def on_file_changed(self, _monitor, file, _other, event):
        if file.get_basename() != getattr(self, "_basename", None):
            return
        if event in (
            Gio.FileMonitorEvent.CHANGED,
            Gio.FileMonitorEvent.CHANGES_DONE_HINT,
            Gio.FileMonitorEvent.CREATED,
            Gio.FileMonitorEvent.DELETED,
            Gio.FileMonitorEvent.MOVED_IN,
            Gio.FileMonitorEvent.MOVED_OUT,
            Gio.FileMonitorEvent.RENAMED,
        ):
            GLib.idle_add(self._reload_silent)

    def _reload_silent(self):
        self.records = load_asr() if self.mode == "asr" else load_tts()
        self.refresh()
        return False

    # ---------------- 列表
    def record_text(self, rec) -> str:
        if self.mode == "asr":
            return rec
        note = ("  · " + rec["note"]) if rec.get("note") else ""
        return rec["term"] + "  →  " + rec["say"] + note

    def update_delete_state(self):
        self.delete_btn.set_sensitive(self.list_box.get_selected_row() is not None)

    def refresh(self):
        child = self.list_box.get_first_child()
        while child is not None:
            nxt = child.get_next_sibling()
            self.list_box.remove(child)
            child = nxt
        needle = self.search_text.strip().lower()
        shown = 0
        for rec in self.records:
            text = self.record_text(rec)
            if needle and needle not in text.lower():
                continue
            row = Gtk.ListBoxRow()
            label = Gtk.Label(label=text, xalign=0)
            label.set_ellipsize(3)
            label.set_margin_top(9)
            label.set_margin_bottom(9)
            label.set_margin_start(12)
            label.set_margin_end(12)
            row.set_child(label)
            self.list_box.append(row)
            shown += 1
        total = len(self.records)
        if needle:
            self.count_label.set_text(f"共 {total} 条 · 匹配 {shown} 条")
        else:
            self.count_label.set_text(f"共 {total} 条")
        self.update_delete_state()

    def on_search(self, entry):
        self.search_text = entry.get_text()
        self.refresh()

    def on_delete(self):
        row = self.list_box.get_selected_row()
        if row is None:
            return
        row_text = row.get_child().get_text()
        for i, rec in enumerate(self.records):
            if self.record_text(rec) == row_text:
                del self.records[i]
                break
        self.persist()
        self.refresh()
        self.set_status("已删除并保存", ok=True)

    # ---------------- 添加
    def on_add(self):
        if self.mode == "asr":
            term = self.entry_a.get_text().strip()
            if not term:
                self.set_status("请输入热词", err=True)
                return
            added = 0
            for t in split_terms(term):
                if t not in self.records:
                    self.records.append(t)
                    added += 1
            self.entry_a.set_text("")
            msg = f"已添加 {added} 个热词" if added else "该热词已存在"
        else:
            term = self.entry_a.get_text().strip()
            say = self.entry_b.get_text().strip()
            note = self.entry_note.get_text().strip()
            if not term or not say:
                self.set_status("「词」和「读音」都必须填写", err=True)
                return
            for rec in self.records:
                if rec["term"] == term:
                    rec["say"] = say
                    rec["note"] = note
                    msg = "已更新已有词条：" + term
                    break
            else:
                self.records.append({"term": term, "say": say, "note": note})
                msg = "已添加：" + term + " → " + say
            self.entry_a.set_text("")
            self.entry_b.set_text("")
            self.entry_note.set_text("")
            self.entry_a.grab_focus()
        self.persist()
        self.refresh()
        self.set_status(msg + " · 已保存", ok=True)

    # ---------------- xlsx
    def _drag_highlight(self, on: bool):
        if on:
            self.drop_zone.add_css_class("drag-over")
        else:
            self.drop_zone.remove_css_class("drag-over")

    def on_drop(self, _target, value, _x, _y):
        self._drag_highlight(False)
        try:
            files = value.get_files()
        except Exception:  # noqa: BLE001
            return False
        if not files:
            return False
        path = files[0].get_path()
        if not path or not path.lower().endswith(".xlsx"):
            self.set_status("只支持 .xlsx 文件", err=True)
            return False
        self.import_xlsx(path)
        return True

    def import_xlsx(self, path: str):
        try:
            rows = read_xlsx_rows(path)
        except Exception as exc:  # noqa: BLE001
            self.set_status(f"读取 xlsx 失败：{exc}", err=True)
            return
        if not rows:
            self.set_status("xlsx 里没有可读取的数据", err=True)
            return
        header = [c.strip().lower() for c in rows[0]]
        expected = ASR_HEADERS if self.mode == "asr" else TTS_HEADERS
        start = 1 if header and header[0] in {h.lower() for h in expected} else 0
        added = updated = skipped = 0
        for row in rows[start:]:
            if self.mode == "asr":
                term = row[0].strip() if row else ""
                if not term:
                    skipped += 1
                    continue
                if term in self.records:
                    skipped += 1
                else:
                    self.records.append(term)
                    added += 1
            else:
                term = row[0].strip() if len(row) > 0 else ""
                say = row[1].strip() if len(row) > 1 else ""
                note = row[2].strip() if len(row) > 2 else ""
                if not term or not say:
                    skipped += 1
                    continue
                for rec in self.records:
                    if rec["term"] == term:
                        rec["say"] = say
                        rec["note"] = note
                        updated += 1
                        break
                else:
                    self.records.append({"term": term, "say": say, "note": note})
                    added += 1
        self.persist()
        self.refresh()
        self.set_status(f"导入完成：新增 {added}，更新 {updated}，跳过 {skipped} · 已保存", ok=True)

    def on_download_sample(self, _btn):
        dialog = Gtk.FileDialog(title="保存样例文件")
        dialog.set_initial_name("ASR热词样例.xlsx" if self.mode == "asr" else "TTS读音样例.xlsx")
        dialog.save(self.get_root(), None, self._on_sample_saved, dialog)

    def _on_sample_saved(self, dialog, result, _data):
        try:
            gfile = dialog.save_finish(result)
        except GLib.Error:
            return
        path = gfile.get_path()
        if not path:
            return
        if not path.lower().endswith(".xlsx"):
            path += ".xlsx"
        if self.mode == "asr":
            write_sample_xlsx(path, ["热词"], [["广东信息科技"], ["网络安全等级保护"], ["数据安全法"]])
        else:
            write_sample_xlsx(
                path,
                ["词", "读音", "备注"],
                [["AI", "爱", "缩写"], ["2026", "二零二六", "年份"], ["LLM", "艾勒姆", "模型"]],
            )
        self.set_status("样例已保存：" + path, ok=True)

    # ---------------- 状态
    def set_status(self, text: str, ok: bool = False, err: bool = False):
        self.status.set_text(text)
        self.status.set_tooltip_text(text)
        self.status.remove_css_class("error")
        self.status.remove_css_class("success")
        if ok:
            self.status.add_css_class("success")
        if err:
            self.status.add_css_class("error")


# ---------------------------------------------------------------- 设置页
class SettingsTab(Gtk.Box):
    def __init__(self, on_apply):
        super().__init__(orientation=Gtk.Orientation.VERTICAL, spacing=0)
        self.on_apply = on_apply

        scroll = Gtk.ScrolledWindow()
        scroll.set_vexpand(True)
        scroll.set_policy(Gtk.PolicyType.NEVER, Gtk.PolicyType.AUTOMATIC)

        content = Gtk.Box(orientation=Gtk.Orientation.VERTICAL, spacing=14)
        content.set_margin_top(20)
        content.set_margin_bottom(20)
        content.set_margin_start(20)
        content.set_margin_end(20)

        title = Gtk.Label(label="热词文件位置")
        title.set_xalign(0)
        title.add_css_class("section-title")
        content.append(title)

        hint = Gtk.Label(
            label=(
                "两个文件需要位于容器挂载的目录内（默认 "
                + str(CACHE_DIR)
                + "，映射为容器里的 /cache），否则容器内服务读不到。"
            )
        )
        hint.set_xalign(0)
        hint.set_wrap(True)
        hint.add_css_class("muted")
        content.append(hint)

        card = Gtk.Box(orientation=Gtk.Orientation.VERTICAL, spacing=12)
        card.add_css_class("card")

        self.asr_entry = Gtk.Entry()
        self.asr_entry.set_text(str(ASR_FILE))
        self.asr_entry.set_hexpand(True)
        self.tts_entry = Gtk.Entry()
        self.tts_entry.set_text(str(TTS_FILE))
        self.tts_entry.set_hexpand(True)

        card.append(self._row("ASR 热词文件", self.asr_entry, "asr"))
        card.append(self._row("TTS 读音词典", self.tts_entry, "tts"))

        actions = Gtk.Box(orientation=Gtk.Orientation.HORIZONTAL, spacing=8)
        actions.set_halign(Gtk.Align.END)
        reset_btn = Gtk.Button(label="恢复默认")
        reset_btn.add_css_class("flat")
        reset_btn.connect("clicked", self.on_reset)
        actions.append(reset_btn)
        self.save_btn = Gtk.Button(label="保存设置")
        self.save_btn.add_css_class("suggested-action")
        self.save_btn.connect("clicked", self.on_save)
        actions.append(self.save_btn)
        card.append(actions)
        content.append(card)

        defaults = Gtk.Label(
            label="默认：ASR " + str(DEFAULT_ASR_FILE) + "\nTTS " + str(DEFAULT_TTS_FILE)
        )
        defaults.set_xalign(0)
        defaults.set_wrap(True)
        defaults.add_css_class("muted")
        content.append(defaults)

        scroll.set_child(content)
        self.append(scroll)

        status_bar = Gtk.Box(orientation=Gtk.Orientation.HORIZONTAL, spacing=8)
        status_bar.add_css_class("status-bar")
        status_bar.set_size_request(-1, 42)
        self.status = Gtk.Label(label="")
        self.status.set_xalign(0)
        self.status.set_ellipsize(3)
        self.status.set_hexpand(True)
        status_bar.append(self.status)
        self.append(status_bar)

    def _row(self, label_text: str, entry: Gtk.Entry, key: str) -> Gtk.Box:
        row = Gtk.Box(orientation=Gtk.Orientation.VERTICAL, spacing=6)
        label = Gtk.Label(label=label_text)
        label.set_xalign(0)
        label.add_css_class("muted")
        row.append(label)
        line = Gtk.Box(orientation=Gtk.Orientation.HORIZONTAL, spacing=8)
        line.append(entry)
        browse = Gtk.Button(label="选择…")
        browse.add_css_class("flat")
        browse.connect("clicked", self.on_browse, entry)
        line.append(browse)
        row.append(line)
        return row

    def on_browse(self, _btn, entry):
        dialog = Gtk.FileDialog(title="选择热词文件")
        current = pathlib.Path(entry.get_text().strip()).expanduser()
        if current.parent.exists():
            dialog.set_initial_folder(Gio.File.new_for_path(str(current.parent)))
        if current.name:
            dialog.set_initial_name(current.name)
        dialog.save(self.get_root(), None, self._on_browsed, entry)

    def _on_browsed(self, dialog, result, entry):
        try:
            gfile = dialog.save_finish(result)
        except GLib.Error:
            return
        path = gfile.get_path()
        if path:
            entry.set_text(path)

    def on_reset(self, _btn):
        self.asr_entry.set_text(str(DEFAULT_ASR_FILE))
        self.tts_entry.set_text(str(DEFAULT_TTS_FILE))

    def on_save(self, _btn):
        asr_text = self.asr_entry.get_text().strip()
        tts_text = self.tts_entry.get_text().strip()
        if not asr_text or not tts_text:
            self.set_status("两个路径都不能为空", err=True)
            return
        asr_path = pathlib.Path(os.path.expanduser(asr_text)).absolute()
        tts_path = pathlib.Path(os.path.expanduser(tts_text)).absolute()
        try:
            self.on_apply(asr_path, tts_path)
        except Exception as exc:  # noqa: BLE001
            self.set_status(f"保存失败：{exc}", err=True)
            return
        self.asr_entry.set_text(str(asr_path))
        self.tts_entry.set_text(str(tts_path))
        self.set_status("设置已保存，两个热词页已切换", ok=True)

    def set_status(self, text: str, ok: bool = False, err: bool = False):
        self.status.set_text(text)
        self.status.set_tooltip_text(text)
        self.status.remove_css_class("error")
        self.status.remove_css_class("success")
        if ok:
            self.status.add_css_class("success")
        if err:
            self.status.add_css_class("error")


# ---------------------------------------------------------------- 应用
class HotwordWindow(Gtk.ApplicationWindow):
    def __init__(self, app: Gtk.Application):
        super().__init__(application=app, title="热词更新器")
        self.set_default_size(1120, 760)

        header = Gtk.HeaderBar()
        title_box = Gtk.Box(orientation=Gtk.Orientation.VERTICAL, spacing=0)
        title = Gtk.Label(label="热词更新器")
        title.add_css_class("title")
        subtitle = Gtk.Label(label="ASR 热词 · TTS 读音")
        subtitle.add_css_class("subtitle")
        subtitle.add_css_class("muted")
        title_box.append(title)
        title_box.append(subtitle)
        header.set_title_widget(title_box)
        self.set_titlebar(header)

        notebook = Gtk.Notebook()
        notebook.set_tab_pos(Gtk.PositionType.TOP)
        self.asr_tab = HotwordTab("asr")
        self.tts_tab = HotwordTab("tts")
        self.settings_tab = SettingsTab(self.apply_paths)
        notebook.append_page(self.asr_tab, Gtk.Label(label="ASR 热词"))
        notebook.append_page(self.tts_tab, Gtk.Label(label="TTS 读音"))
        notebook.append_page(self.settings_tab, Gtk.Label(label="设置"))
        self.set_child(notebook)

        css = Gtk.CssProvider()
        css.load_from_data(
            (
                "window { background-color: #14161b; }\n"
                ".card { background-color: rgba(255,255,255,0.045);"
                " border: 1px solid rgba(255,255,255,0.08); border-radius: 12px; padding: 14px; }\n"
                ".card-list { background-color: transparent; }\n"
                ".status-bar { background-color: rgba(255,255,255,0.03);"
                " border-top: 1px solid rgba(255,255,255,0.07); padding: 0 16px; }\n"
                ".drop-zone { border: 2px dashed rgba(255,255,255,0.18); border-radius: 12px; padding: 16px; }\n"
                ".drop-zone.drag-over { border-color: #3584e4; background-color: rgba(53,132,228,0.12); }\n"
                ".section-title { font-weight: 600; }\n"
                ".muted { opacity: 0.65; font-size: 12px; }\n"
                ".success { color: #2ec27e; }\n"
                ".error { color: #ff6b6b; }\n"
                "entry { min-height: 34px; }\n"
                "button.destructive-action { background-color: #c01c28; color: #ffffff; }\n"
                "button.destructive-action:hover { background-color: #e01b24; }\n"
            ).encode("utf-8")
        )
        display = Gdk.Display.get_default()
        if display is not None:
            Gtk.StyleContext.add_provider_for_display(
                display, css, Gtk.STYLE_PROVIDER_PRIORITY_APPLICATION
            )

    def apply_paths(self, asr_path: pathlib.Path, tts_path: pathlib.Path):
        save_settings(asr_path, tts_path)
        set_paths(asr_path, tts_path)
        self.asr_tab.rebind()
        self.tts_tab.rebind()


class HotwordApp(Gtk.Application):
    def __init__(self):
        super().__init__(application_id=APP_ID, flags=Gio.ApplicationFlags.DEFAULT_FLAGS)
        self.window = None

    def do_activate(self):
        settings = Gtk.Settings.get_default()
        if settings is not None:
            settings.set_property("gtk-application-prefer-dark-theme", True)
        if self.window is None:
            self.window = HotwordWindow(self)
        self.window.present()


if __name__ == "__main__":
    set_paths(*load_settings())
    raise SystemExit(HotwordApp().run(None))
