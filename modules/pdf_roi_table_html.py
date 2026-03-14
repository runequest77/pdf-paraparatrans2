#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""PDF ページ内の指定領域（ROI）からテーブルを抽出し HTML として返すモジュール。

行・列の推定処理は :func:`estimate_grid` として独立して呼び出せる。
この関数は PDF への罫線描画など、段落抽出以外の処理でも利用できる。
"""

from __future__ import annotations

import bisect
from dataclasses import dataclass
from html import escape as _html_escape
from typing import Any, List, Optional, Tuple

import fitz


@dataclass
class GridInfo:
    """テーブル領域のグリッド情報。

    Attributes:
        row_edges: 行境界の Y 座標リスト（長さ = 行数 + 1）。
        col_edges: 列境界の X 座標リスト（長さ = 列数 + 1）。
        row_groups: 行ごとに分類された単語タプルのリスト。
            各要素は PyMuPDF の ``get_text("words")`` が返す
            ``(x0, y0, x1, y1, word, ...)`` タプルのリスト。
        clip_rect: テーブル領域の矩形（PDF ポイント単位）。
    """

    row_edges: List[float]
    col_edges: List[float]
    row_groups: List[List[Tuple[Any, ...]]]
    clip_rect: fitz.Rect

    @property
    def num_rows(self) -> int:
        """推定行数。"""
        return max(1, len(self.row_edges) - 1)

    @property
    def num_cols(self) -> int:
        """推定列数。"""
        return max(1, len(self.col_edges) - 1)


# ---------------------------------------------------------------------------
# 内部ユーティリティ
# ---------------------------------------------------------------------------

def _median(values: List[float], default: float = 0.0) -> float:
    if not values:
        return default
    arr = sorted(values)
    n = len(arr)
    m = n // 2
    return float(arr[m]) if n % 2 == 1 else float((arr[m - 1] + arr[m]) / 2.0)


def _percentile(values: List[float], p: float, default: float = 0.0) -> float:
    if not values:
        return default
    arr = sorted(values)
    if len(arr) == 1:
        return float(arr[0])
    idx = max(0.0, min(1.0, p)) * (len(arr) - 1)
    lo = int(idx)
    hi = min(lo + 1, len(arr) - 1)
    t = idx - lo
    return float(arr[lo] * (1.0 - t) + arr[hi] * t)


def _kmeans_1d(values: List[float], k: int, iterations: int = 20) -> List[float]:
    if not values:
        return []
    uniq = sorted(set(float(v) for v in values))
    k = max(1, min(int(k), len(uniq)))
    if k == 1:
        return [_median(uniq, 0.0)]

    centers = [_percentile(uniq, i / (k - 1), uniq[0]) for i in range(k)]

    for _ in range(max(1, iterations)):
        buckets: List[List[float]] = [[] for _ in range(k)]
        for v in values:
            dist = [abs(float(v) - c) for c in centers]
            buckets[dist.index(min(dist))].append(float(v))

        new_centers = [
            sum(b) / len(b) if b else centers[i]
            for i, b in enumerate(buckets)
        ]
        if all(abs(new_centers[i] - centers[i]) <= 1e-6 for i in range(k)):
            centers = new_centers
            break
        centers = new_centers

    return sorted(float(c) for c in centers)


def _cluster_1d_points(points: List[float], tolerance: float) -> List[float]:
    if not points:
        return []
    arr = sorted(float(p) for p in points)
    tolerance = max(1.0, float(tolerance))

    out: List[List[float]] = [[arr[0]]]
    for p in arr[1:]:
        cur = out[-1]
        if abs(p - (sum(cur) / len(cur))) <= tolerance:
            cur.append(p)
        else:
            out.append([p])
    return [sum(c) / len(c) for c in out]


def _cluster_rows(words: List[Tuple[Any, ...]]) -> List[List[Tuple[Any, ...]]]:
    """単語リストを Y 座標のギャップで行グループに自動分割する。"""
    if not words:
        return []

    heights = [max(1.0, float(w[3]) - float(w[1])) for w in words]
    median_h = sorted(heights)[len(heights) // 2]
    y_tol = max(2.0, median_h * 0.55)

    words_sorted = sorted(
        words,
        key=lambda w: ((float(w[1]) + float(w[3])) / 2.0, float(w[0])),
    )

    rows: List[List[Tuple[Any, ...]]] = []
    for w in words_sorted:
        yc = (float(w[1]) + float(w[3])) / 2.0
        if not rows:
            rows.append([w])
            continue
        last_row = rows[-1]
        last_y = sum((float(x[1]) + float(x[3])) / 2.0 for x in last_row) / len(last_row)
        if abs(yc - last_y) <= y_tol:
            last_row.append(w)
        else:
            rows.append([w])

    for row in rows:
        row.sort(key=lambda w: float(w[0]))
    return rows


def _build_row_groups(
    words: List[Tuple[Any, ...]],
    desired_rows: Optional[int] = None,
) -> List[List[Tuple[Any, ...]]]:
    """desired_rows が指定された場合は k-means で、なければ自動クラスタリングで
    行グループを構築する。"""
    if not words:
        return []

    if desired_rows is None:
        return _cluster_rows(words)

    k = max(1, int(desired_rows))
    y_centers = [(float(w[1]) + float(w[3])) / 2.0 for w in words]
    centers = _kmeans_1d(y_centers, k)
    if not centers:
        return _cluster_rows(words)

    groups: List[List[Tuple[Any, ...]]] = [[] for _ in range(len(centers))]
    for w in words:
        yc = (float(w[1]) + float(w[3])) / 2.0
        idx = min(range(len(centers)), key=lambda i: abs(yc - centers[i]))
        groups[idx].append(w)

    indexed = [
        (
            sum((float(x[1]) + float(x[3])) / 2.0 for x in g) / len(g)
            if g else centers[i],
            g,
        )
        for i, g in enumerate(groups)
    ]
    indexed.sort(key=lambda it: it[0])

    sorted_groups = [g for _, g in indexed]
    for g in sorted_groups:
        g.sort(key=lambda w: float(w[0]))
    return sorted_groups


def _build_row_edges_from_groups(
    row_groups: List[List[Tuple[Any, ...]]],
    clip_rect: fitz.Rect,
) -> List[float]:
    """行グループの中心 Y 座標から行境界リストを計算する。"""
    if not row_groups:
        return [float(clip_rect.y0), float(clip_rect.y1)]

    centers: List[float] = []
    for group in row_groups:
        if group:
            centers.append(
                sum((float(w[1]) + float(w[3])) / 2.0 for w in group) / len(group)
            )
        else:
            centers.append(float(clip_rect.y0))

    if len(centers) == 1:
        return [float(clip_rect.y0), float(clip_rect.y1)]

    centers = sorted(centers)
    edges = [float(clip_rect.y0)]
    for i in range(1, len(centers)):
        edges.append(float((centers[i - 1] + centers[i]) / 2.0))
    edges.append(float(clip_rect.y1))

    deduped = [edges[0]]
    for y in edges[1:]:
        if y - deduped[-1] < 1.0:
            y = deduped[-1] + 1.0
        deduped.append(y)
    return deduped


def _estimate_column_edges(
    words: List[Tuple[Any, ...]],
    clip_rect: fitz.Rect,
    row_groups: List[List[Tuple[Any, ...]]],
    desired_cols: Optional[int] = None,
) -> List[float]:
    """単語の X 座標ギャップから列境界リストを推定する。"""
    if not words:
        return [float(clip_rect.x0), float(clip_rect.x1)]

    if desired_cols is not None:
        cols = max(1, int(desired_cols))
        x_centers = [(float(w[0]) + float(w[2])) / 2.0 for w in words]
        centers = _kmeans_1d(x_centers, cols)
        if len(centers) <= 1:
            return [float(clip_rect.x0), float(clip_rect.x1)]
        edges = [float(clip_rect.x0)]
        for i in range(1, len(centers)):
            edges.append(float((centers[i - 1] + centers[i]) / 2.0))
        edges.append(float(clip_rect.x1))
        return sorted(edges)

    separators: List[float] = []
    word_widths = [max(1.0, float(w[2]) - float(w[0])) for w in words]
    base_tol = max(6.0, _median(word_widths, 8.0) * 0.6)

    for row_words in row_groups:
        if len(row_words) < 2:
            continue
        row = sorted(row_words, key=lambda w: float(w[0]))
        gaps = [
            max(0.0, float(row[i][0]) - float(row[i - 1][2]))
            for i in range(1, len(row))
        ]
        if not gaps:
            continue
        q2 = _percentile(gaps, 0.5, 0.0)
        q3 = _percentile(gaps, 0.75, q2)
        iqr = max(0.0, q3 - q2)
        threshold = max(12.0, q2 + 1.2 * iqr)

        for i in range(1, len(row)):
            prev = row[i - 1]
            curr = row[i]
            gap = max(0.0, float(curr[0]) - float(prev[2]))
            if gap >= threshold:
                separators.append(float((float(prev[2]) + float(curr[0])) / 2.0))

    clustered_sep = _cluster_1d_points(separators, tolerance=base_tol)
    clustered_sep = [s for s in clustered_sep if clip_rect.x0 < s < clip_rect.x1]

    if not clustered_sep:
        return [float(clip_rect.x0), float(clip_rect.x1)]

    edges = [float(clip_rect.x0)] + sorted(clustered_sep) + [float(clip_rect.x1)]
    deduped = [edges[0]]
    for x in edges[1:]:
        if abs(x - deduped[-1]) >= 1.0:
            deduped.append(x)
    if len(deduped) < 2:
        return [float(clip_rect.x0), float(clip_rect.x1)]
    return deduped


# ---------------------------------------------------------------------------
# 公開 API
# ---------------------------------------------------------------------------

def estimate_grid(
    page: fitz.Page,
    clip_rect: fitz.Rect,
    hint_rows: Optional[int] = None,
    hint_cols: Optional[int] = None,
) -> GridInfo:
    """PDF ページの指定領域からテーブルのグリッド情報を推定する。

    行・列の境界座標と行グループを含む :class:`GridInfo` を返す。
    この関数はパラグラフ抽出処理から独立して呼び出すことができるため、
    PDF への罫線描画など他の用途でも利用できる。

    Args:
        page: PyMuPDF のページオブジェクト。
        clip_rect: テーブル領域を表す矩形（PDF ポイント単位）。
        hint_rows: 行数のヒント。指定すると k-means でその行数に分割する。
            ``None`` または ``0`` 以下の場合は自動推定。
        hint_cols: 列数のヒント。指定すると k-means でその列数に分割する。
            ``None`` または ``0`` 以下の場合は自動推定。

    Returns:
        グリッド情報を持つ :class:`GridInfo` オブジェクト。
    """
    words = page.get_text("words", clip=clip_rect)

    desired_rows = max(1, int(hint_rows)) if hint_rows and int(hint_rows) > 0 else None
    desired_cols = max(1, int(hint_cols)) if hint_cols and int(hint_cols) > 0 else None

    row_groups = _build_row_groups(words, desired_rows=desired_rows)
    row_edges = _build_row_edges_from_groups(row_groups, clip_rect)
    col_edges = _estimate_column_edges(words, clip_rect, row_groups, desired_cols=desired_cols)

    return GridInfo(
        row_edges=row_edges,
        col_edges=col_edges,
        row_groups=row_groups,
        clip_rect=clip_rect,
    )


def extract_table_html(
    page: fitz.Page,
    clip_rect: fitz.Rect,
    hint_rows: Optional[int] = None,
    hint_cols: Optional[int] = None,
) -> str:
    """PDF ページの指定領域からテーブルを抽出し HTML 文字列として返す。

    内部で :func:`estimate_grid` を呼び出してグリッドを推定し、
    各セルに単語を割り当てて ``<table>`` 要素を構築する。

    Args:
        page: PyMuPDF のページオブジェクト。
        clip_rect: テーブル領域を表す矩形（PDF ポイント単位）。
        hint_rows: 行数のヒント。
        hint_cols: 列数のヒント。

    Returns:
        HTML テーブル文字列（``<table>...</table>``）。
        単語が見つからない場合は空文字列を返す。
    """
    grid = estimate_grid(page, clip_rect, hint_rows=hint_rows, hint_cols=hint_cols)

    if not grid.row_groups:
        return ""

    col_count = grid.num_cols
    col_edges = grid.col_edges

    rows_html: List[str] = []
    for row_idx, group in enumerate(grid.row_groups):
        cell_words: List[List[str]] = [[] for _ in range(col_count)]
        for word in group:
            xc = (float(word[0]) + float(word[2])) / 2.0
            c = bisect.bisect_right(col_edges, xc) - 1
            c = min(max(0, c), col_count - 1)
            cell_words[c].append(str(word[4]))

        tag = "th" if row_idx == 0 else "td"
        cells_html = "".join(
            f"<{tag}>{_html_escape(' '.join(ws))}</{tag}>"
            for ws in cell_words
        )
        rows_html.append(f"<tr>{cells_html}</tr>")

    return "<table>" + "".join(rows_html) + "</table>"
