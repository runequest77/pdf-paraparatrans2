from __future__ import annotations

"""PDF ROI table extractor.

Strategy:
1. Use PyMuPDF's lines-based table detection to get candidate cell rectangles.
2. Keep only cells inside or intersecting a user-provided ROI.
3. Cluster x/y borders from those cells.
4. Rebuild a clean grid from clustered x/y positions.
5. Assign words to rebuilt cells and emit HTML.

This library is aimed at pages where `find_tables(... lines ...)` finds useful cell
boundaries, but the caller wants to control which region should be treated as a
single table.

Requirements:
    pip install pymupdf

Example:
    from pdf_roi_table_html import extract_table_html

    html = extract_table_html(
        pdf_path="sample.pdf",
        page_number=0,
        roi=(90, 180, 760, 1220),
        cluster_tolerance=4.0,
    )
    print(html)
"""

from dataclasses import dataclass
from html import escape
from typing import Iterable, Sequence

import fitz


BBox = tuple[float, float, float, float]


@dataclass(frozen=True)
class ExtractOptions:
    cluster_tolerance: float = 4.0
    include_partial: bool = True
    table_border: int = 1
    html_class: str = "pdf-extracted-table"
    preserve_linebreaks: bool = True


@dataclass(frozen=True)
class TableExtractionResult:
    page_number: int
    roi: BBox
    clustered_x: tuple[float, ...]
    clustered_y: tuple[float, ...]
    matrix: tuple[tuple[str, ...], ...]
    html: str

    @property
    def row_count(self) -> int:
        return len(self.matrix)

    @property
    def col_count(self) -> int:
        return len(self.matrix[0]) if self.matrix else 0


@dataclass(frozen=True)
class _Word:
    x0: float
    y0: float
    x1: float
    y1: float
    text: str
    block_no: int
    line_no: int
    word_no: int

    @property
    def xc(self) -> float:
        return (self.x0 + self.x1) / 2.0

    @property
    def yc(self) -> float:
        return (self.y0 + self.y1) / 2.0


@dataclass(frozen=True)
class _Cell:
    bbox: BBox


def normalize_roi(roi: Sequence[float]) -> BBox:
    if len(roi) != 4:
        raise ValueError("roi must contain exactly 4 numbers: (x0, y0, x1, y1)")
    x0, y0, x1, y1 = map(float, roi)
    if x0 == x1 or y0 == y1:
        raise ValueError("roi must have non-zero width and height")
    return min(x0, x1), min(y0, y1), max(x0, x1), max(y0, y1)


def _inside_roi(rect: BBox, roi: BBox, tol: float = 0.0) -> bool:
    rx0, ry0, rx1, ry1 = roi
    x0, y0, x1, y1 = rect
    return x0 >= rx0 - tol and y0 >= ry0 - tol and x1 <= rx1 + tol and y1 <= ry1 + tol


def _intersects_roi(rect: BBox, roi: BBox) -> bool:
    ax0, ay0, ax1, ay1 = rect
    bx0, by0, bx1, by1 = roi
    return not (ax1 < bx0 or bx1 < ax0 or ay1 < by0 or by1 < ay0)


def _cluster_positions(values: Iterable[float], tol: float) -> list[float]:
    vals = sorted(float(v) for v in values)
    if not vals:
        return []
    groups: list[list[float]] = [[vals[0]]]
    for v in vals[1:]:
        if abs(v - groups[-1][-1]) <= tol:
            groups[-1].append(v)
        else:
            groups.append([v])
    return [sum(g) / len(g) for g in groups]


def _find_line_cells(page: fitz.Page) -> list[_Cell]:
    tabs = page.find_tables(vertical_strategy="lines", horizontal_strategy="lines")
    cells: list[_Cell] = []
    for table in tabs.tables:
        for cell in table.cells:
            if cell:
                cells.append(_Cell(tuple(float(v) for v in cell)))
    return cells


def _select_cells(cells: Sequence[_Cell], roi: BBox, include_partial: bool) -> list[_Cell]:
    selected: list[_Cell] = []
    for cell in cells:
        ok = _intersects_roi(cell.bbox, roi) if include_partial else _inside_roi(cell.bbox, roi)
        if ok:
            selected.append(cell)
    return selected


def _rebuild_grid_from_cells(cells: Sequence[_Cell], roi: BBox, cluster_tolerance: float) -> tuple[list[float], list[float]]:
    if not cells:
        raise ValueError("No lines-based cells found in the ROI. Try a wider ROI or a different page.")

    xs: list[float] = []
    ys: list[float] = []
    for cell in cells:
        x0, y0, x1, y1 = cell.bbox
        xs.extend([x0, x1])
        ys.extend([y0, y1])

    rx0, ry0, rx1, ry1 = roi
    cx = _cluster_positions(xs + [rx0, rx1], cluster_tolerance)
    cy = _cluster_positions(ys + [ry0, ry1], cluster_tolerance)

    cx = sorted(x for x in cx if rx0 <= x <= rx1)
    cy = sorted(y for y in cy if ry0 <= y <= ry1)

    if len(cx) < 2 or len(cy) < 2:
        raise ValueError("Grid reconstruction failed: clustered borders are insufficient.")

    return cx, cy


def _extract_words(page: fitz.Page, roi: BBox | None = None) -> list[_Word]:
    kwargs = {"clip": fitz.Rect(roi)} if roi is not None else {}
    raw = page.get_text("words", **kwargs)
    out: list[_Word] = []
    for item in raw:
        x0, y0, x1, y1, text, block_no, line_no, word_no = item
        text = str(text).strip()
        if not text:
            continue
        out.append(
            _Word(
                x0=float(x0),
                y0=float(y0),
                x1=float(x1),
                y1=float(y1),
                text=text,
                block_no=int(block_no),
                line_no=int(line_no),
                word_no=int(word_no),
            )
        )
    return out


def _assign_words_to_matrix(words: Sequence[_Word], xs: Sequence[float], ys: Sequence[float]) -> list[list[list[_Word]]]:
    rows = len(ys) - 1
    cols = len(xs) - 1
    buckets: list[list[list[_Word]]] = [[[] for _ in range(cols)] for _ in range(rows)]

    for word in words:
        col = None
        row = None
        for i in range(cols):
            if xs[i] <= word.xc < xs[i + 1] or (i == cols - 1 and xs[i] <= word.xc <= xs[i + 1]):
                col = i
                break
        for j in range(rows):
            if ys[j] <= word.yc < ys[j + 1] or (j == rows - 1 and ys[j] <= word.yc <= ys[j + 1]):
                row = j
                break
        if row is not None and col is not None:
            buckets[row][col].append(word)

    return buckets


def _words_to_text(words: Sequence[_Word], preserve_linebreaks: bool) -> str:
    if not words:
        return ""
    ordered = sorted(words, key=lambda w: (w.block_no, w.line_no, w.word_no, w.y0, w.x0))
    if not preserve_linebreaks:
        return " ".join(w.text for w in ordered)

    lines: list[list[_Word]] = []
    current_key = (ordered[0].block_no, ordered[0].line_no)
    current: list[_Word] = []
    for word in ordered:
        key = (word.block_no, word.line_no)
        if key != current_key:
            lines.append(current)
            current = [word]
            current_key = key
        else:
            current.append(word)
    if current:
        lines.append(current)
    return "\n".join(" ".join(w.text for w in line) for line in lines)


def _matrix_to_strings(buckets: Sequence[Sequence[Sequence[_Word]]], preserve_linebreaks: bool) -> list[list[str]]:
    matrix: list[list[str]] = []
    for row in buckets:
        matrix.append([_words_to_text(cell_words, preserve_linebreaks) for cell_words in row])
    return matrix


def matrix_to_html(
    matrix: Sequence[Sequence[str]],
    *,
    border: int = 1,
    html_class: str = "pdf-extracted-table",
    preserve_linebreaks: bool = True,
) -> str:
    lines = [f'<table border="{int(border)}" class="{escape(html_class, quote=True)}">']
    lines.append("  <tbody>")
    for row in matrix:
        lines.append("    <tr>")
        for cell in row:
            content = escape(cell)
            if preserve_linebreaks:
                content = content.replace("\n", "<br />")
            lines.append(f"      <td>{content}</td>")
        lines.append("    </tr>")
    lines.append("  </tbody>")
    lines.append("</table>")
    return "\n".join(lines)


def extract_table(
    page: fitz.Page,
    roi: Sequence[float],
    *,
    options: ExtractOptions | None = None,
) -> TableExtractionResult:
    opts = options or ExtractOptions()
    normalized_roi = normalize_roi(roi)

    line_cells = _find_line_cells(page)
    selected_cells = _select_cells(line_cells, normalized_roi, opts.include_partial)
    xs, ys = _rebuild_grid_from_cells(selected_cells, normalized_roi, opts.cluster_tolerance)

    words = _extract_words(page, normalized_roi)
    buckets = _assign_words_to_matrix(words, xs, ys)
    matrix = _matrix_to_strings(buckets, preserve_linebreaks=opts.preserve_linebreaks)
    html = matrix_to_html(
        matrix,
        border=opts.table_border,
        html_class=opts.html_class,
        preserve_linebreaks=opts.preserve_linebreaks,
    )

    return TableExtractionResult(
        page_number=page.number,
        roi=normalized_roi,
        clustered_x=tuple(xs),
        clustered_y=tuple(ys),
        matrix=tuple(tuple(row) for row in matrix),
        html=html,
    )


def extract_table_from_pdf(
    pdf_path: str,
    page_number: int,
    roi: Sequence[float],
    *,
    options: ExtractOptions | None = None,
) -> TableExtractionResult:
    doc = fitz.open(pdf_path)
    try:
        if not 0 <= page_number < len(doc):
            raise IndexError(f"page_number out of range: {page_number} (document has {len(doc)} pages)")
        return extract_table(doc[page_number], roi, options=options)
    finally:
        doc.close()


def extract_table_html(
    pdf_path: str,
    page_number: int,
    roi: Sequence[float],
    *,
    cluster_tolerance: float = 4.0,
    include_partial: bool = True,
    table_border: int = 1,
    html_class: str = "pdf-extracted-table",
    preserve_linebreaks: bool = True,
) -> str:
    result = extract_table_from_pdf(
        pdf_path,
        page_number,
        roi,
        options=ExtractOptions(
            cluster_tolerance=cluster_tolerance,
            include_partial=include_partial,
            table_border=table_border,
            html_class=html_class,
            preserve_linebreaks=preserve_linebreaks,
        ),
    )
    return result.html


def extract_table_html_1based(
    pdf_path: str,
    page_number: int,
    roi: Sequence[float],
    **kwargs,
) -> str:
    if page_number < 1:
        raise ValueError("page_number must be 1 or greater for the 1-based API")
    return extract_table_html(pdf_path, page_number - 1, roi, **kwargs)


__all__ = [
    "ExtractOptions",
    "TableExtractionResult",
    "extract_table",
    "extract_table_from_pdf",
    "extract_table_html",
    "extract_table_html_1based",
    "matrix_to_html",
    "normalize_roi",
]


if __name__ == "__main__":
    import argparse
    import sys

    parser = argparse.ArgumentParser(description="Extract an ROI-based table from a PDF page as HTML.")
    parser.add_argument("pdf_path", help="Path to the PDF file")
    parser.add_argument("page_number", type=int, help="Zero-based page number")
    parser.add_argument("x0", type=float)
    parser.add_argument("y0", type=float)
    parser.add_argument("x1", type=float)
    parser.add_argument("y1", type=float)
    parser.add_argument("--cluster-tolerance", type=float, default=4.0)
    parser.add_argument("--inside-only", action="store_true", help="Use only cells fully inside the ROI")
    parser.add_argument("--border", type=int, default=1)
    parser.add_argument("--html-class", default="pdf-extracted-table")
    parser.add_argument("--no-linebreaks", action="store_true")
    parser.add_argument("--output", help="Write HTML to this file instead of stdout")
    args = parser.parse_args()

    result = extract_table_from_pdf(
        args.pdf_path,
        args.page_number,
        (args.x0, args.y0, args.x1, args.y1),
        options=ExtractOptions(
            cluster_tolerance=args.cluster_tolerance,
            include_partial=not args.inside_only,
            table_border=args.border,
            html_class=args.html_class,
            preserve_linebreaks=not args.no_linebreaks,
        ),
    )

    if args.output:
        with open(args.output, "w", encoding="utf-8") as f:
            f.write(result.html)
    else:
        sys.stdout.write(result.html)
        sys.stdout.write("\n")
