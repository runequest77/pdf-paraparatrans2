#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""ROI ベースのテーブル再抽出モジュール。

:mod:`pdf_roi_table_html` の :func:`~pdf_roi_table_html.estimate_grid` を使って
テーブル領域から行・列を自動検出し、paraparatrans 用の段落形式で追加する。

行列推定処理 :func:`estimate_grid_for_paragraphs` はパラグラフ抽出処理と独立して
呼び出し可能である。PDF に罫線を描画する処理などで再利用できる。
"""

from __future__ import annotations

import bisect
from html import escape
from typing import Any, Dict, Iterable, List, Optional, Tuple

import fitz

from modules.pdf_roi_table_html import GridInfo, estimate_grid


# ---------------------------------------------------------------------------
# 内部ユーティリティ
# ---------------------------------------------------------------------------

def _safe_int(value: Any, default: int = 0) -> int:
    try:
        return int(value)
    except Exception:
        return default


def _safe_float(value: Any, default: float = 0.0) -> float:
    try:
        return float(value)
    except Exception:
        return default


def _sorted_paragraph_items(
    page_paragraphs: Dict[str, Dict[str, Any]],
) -> List[Tuple[str, Dict[str, Any]]]:
    return sorted(
        page_paragraphs.items(),
        key=lambda kv: (
            _safe_int(kv[1].get("order"), 0),
            _safe_float((kv[1].get("bbox") or [0, 0, 0, 0])[1], 0.0),
            str(kv[0]),
        ),
    )


def _union_rect_from_paragraph_ids(
    page_paragraphs: Dict[str, Dict[str, Any]],
    paragraph_ids: Iterable[Any],
) -> Optional[fitz.Rect]:
    """選択段落の bbox の和集合矩形を返す。"""
    ids = {str(pid).strip() for pid in paragraph_ids if str(pid).strip()}
    if not ids:
        return None

    rect: Optional[fitz.Rect] = None
    for key, para in _sorted_paragraph_items(page_paragraphs):
        para_id = str(para.get("id") or key)
        if para_id not in ids:
            continue
        bbox = para.get("bbox")
        if not bbox or len(bbox) != 4:
            continue
        try:
            cur = fitz.Rect(
                float(bbox[0]), float(bbox[1]),
                float(bbox[2]), float(bbox[3]),
            )
        except Exception:
            continue
        rect = cur if rect is None else fitz.Rect(
            min(rect.x0, cur.x0), min(rect.y0, cur.y0),
            max(rect.x1, cur.x1), max(rect.y1, cur.y1),
        )
    return rect


# ---------------------------------------------------------------------------
# 公開 API
# ---------------------------------------------------------------------------

def estimate_grid_for_paragraphs(
    page: fitz.Page,
    page_paragraphs: Dict[str, Dict[str, Any]],
    paragraph_ids: Iterable[Any],
    hint_rows: Optional[int] = None,
    hint_cols: Optional[int] = None,
) -> Optional[GridInfo]:
    """選択段落の bbox 範囲全体をひとつの表領域としてグリッド情報を推定する。

    この関数は :func:`append_roi_table_rows_from_selection` から独立して
    呼び出し可能である。PDF に罫線を描画する処理などで再利用できる。

    Args:
        page: PyMuPDF のページオブジェクト。
        page_paragraphs: ページの段落辞書。
        paragraph_ids: 選択段落 ID のイテラブル。
        hint_rows: 行数のヒント（``None`` または ``0`` 以下で自動推定）。
        hint_cols: 列数のヒント（``None`` または ``0`` 以下で自動推定）。

    Returns:
        グリッド情報を持つ :class:`~pdf_roi_table_html.GridInfo`、
        または選択段落が見つからない場合は ``None``。
    """
    sel_rect = _union_rect_from_paragraph_ids(page_paragraphs, paragraph_ids)
    if sel_rect is None:
        return None

    pad = 1.5
    clip = fitz.Rect(
        sel_rect.x0 - pad,
        sel_rect.y0 - pad,
        sel_rect.x1 + pad,
        sel_rect.y1 + pad,
    )

    rows_hint = max(1, int(hint_rows)) if hint_rows and int(hint_rows) > 0 else None
    cols_hint = max(1, int(hint_cols)) if hint_cols and int(hint_cols) > 0 else None

    return estimate_grid(page, clip, hint_rows=rows_hint, hint_cols=cols_hint)


def append_roi_table_rows_from_selection(
    page: fitz.Page,
    page_number: int,
    page_paragraphs: Dict[str, Dict[str, Any]],
    paragraph_ids: Iterable[Any],
    table_id: str,
    hint_rows: Optional[int] = None,
    hint_cols: Optional[int] = None,
) -> int:
    """ROI ベースのグリッド推定でテーブル行を抽出し段落として追加する。

    選択段落の bbox 全体をひとつのテーブル領域として扱い、
    :func:`estimate_grid_for_paragraphs` でグリッドを推定した後、
    各セルのテキストを収集してマークダウン行形式の段落を追加する。

    Args:
        page: PyMuPDF のページオブジェクト。
        page_number: ページ番号（1始まり）。
        page_paragraphs: ページの段落辞書（更新される）。
        paragraph_ids: 選択段落 ID のイテラブル。
        table_id: テーブル ID（段落 ID 生成に使用）。
        hint_rows: 行数のヒント（省略時は自動推定）。
        hint_cols: 列数のヒント（省略時は自動推定）。

    Returns:
        追加した段落数。
    """
    grid = estimate_grid_for_paragraphs(
        page, page_paragraphs, paragraph_ids,
        hint_rows=hint_rows, hint_cols=hint_cols,
    )
    if grid is None:
        return 0

    if not grid.row_groups:
        return 0

    col_count = grid.num_cols
    col_edges = grid.col_edges
    row_edges = grid.row_edges

    current_max_order = 0
    for p in page_paragraphs.values():
        current_max_order = max(current_max_order, _safe_int(p.get("order"), 0))

    added_count = 0
    for row_idx, group in enumerate(grid.row_groups):
        row_num = row_idx + 1

        # 単語を列に分配
        cell_words: List[List[str]] = [[] for _ in range(col_count)]
        for word in group:
            xc = (float(word[0]) + float(word[2])) / 2.0
            c = bisect.bisect_right(col_edges, xc) - 1
            c = min(max(0, c), col_count - 1)
            cell_words[c].append(str(word[4]))

        cells = [" ".join(ws).strip() for ws in cell_words]
        md_row = "| " + " | ".join(c.replace("|", "\\|") for c in cells) + " |"

        # 行の bbox を row_edges から計算
        y0 = float(row_edges[row_idx]) if row_idx < len(row_edges) else float(grid.clip_rect.y0)
        y1 = (
            float(row_edges[row_idx + 1])
            if row_idx + 1 < len(row_edges)
            else float(grid.clip_rect.y1)
        )
        row_bbox = [float(grid.clip_rect.x0), y0, float(grid.clip_rect.x1), y1]

        current_max_order += 1
        para_id = f"tbl_{table_id}_r{row_num}"
        unique_key = para_id
        suffix = 2
        while unique_key in page_paragraphs:
            unique_key = f"{para_id}_{suffix}"
            suffix += 1

        block_tag = "th" if row_num == 1 else "tr"
        paragraph = {
            "id": unique_key,
            "src_text": md_row,
            "src_html": escape(md_row),
            "src_joined": md_row,
            "src_replaced": md_row,
            "trans_auto": md_row,
            "trans_text": md_row,
            "comment": "",
            "trans_status": "none",
            "block_tag": block_tag,
            "modified_at": "",
            "base_style": "",
            "bbox": row_bbox,
            "column_order": 999,
            "page_number": page_number,
            "order": current_max_order,
            "table_meta": {
                "table_id": table_id,
                "row": row_num,
                "source": "reextract_roi",
                "markdown_row": True,
                "rows": grid.num_rows,
                "cols": col_count,
            },
        }
        page_paragraphs[unique_key] = paragraph
        added_count += 1

    return added_count
