from __future__ import annotations

import os
from typing import Callable, Tuple

from flask import Blueprint, current_app, jsonify, request

from app.services.paragraph_service import ParagraphService


def create_paragraph_blueprint(
    paragraph_service: ParagraphService,
    get_paths: Callable[[str], Tuple[str, str]],
) -> Blueprint:
    """段落管理・タグ付け API の Blueprint を生成して返す。

    依存オブジェクトはファクトリ引数で受け取り、クロージャ経由でルートハンドラに渡す。
    """

    bp = Blueprint("paragraph", __name__)

    # ------------------------------------------------------------------
    # /api/save_order/<path:pdf_name> — 段落の並び順・タグ保存
    # ------------------------------------------------------------------

    @bp.route("/api/save_order/<path:pdf_name>", methods=["POST"])
    def save_order_api(pdf_name):
        order_json = request.form.get("order_json")
        title = request.form.get("title")

        if not pdf_name or not order_json:
            return jsonify({"status": "error", "message": "pdf_name と order_json は必須です"}), 400

        _, json_path = get_paths(pdf_name)
        if not os.path.exists(json_path):
            return jsonify({"status": "error", "message": "JSONが存在しません"}), 404

        try:
            changed_count = paragraph_service.save_order(json_path, order_json, title)
        except Exception as e:
            return jsonify({"status": "error", "message": f"保存中のエラー: {str(e)}"}), 500

        return jsonify({"status": "ok", "changed": changed_count}), 200

    # ------------------------------------------------------------------
    # /api/auto_tagging/<path:pdf_name> — 自動タグ付け
    # ------------------------------------------------------------------

    @bp.route("/api/auto_tagging/<path:pdf_name>", methods=["POST"])
    def auto_tagging_api(pdf_name):
        _, json_path = get_paths(pdf_name)
        if not os.path.exists(json_path):
            return jsonify({"status": "error", "message": "JSONファイルが存在しません"}), 404
        try:
            current_page = request.form.get("current_page", type=int)
            delta = paragraph_service.auto_tagging(json_path, current_page)
        except Exception as e:
            return jsonify({"status": "error", "message": f"自動タグ付けエラー: {str(e)}"}), 500
        return jsonify({"status": "ok", "message": "自動タグ付け完了", "delta": delta}), 200

    # ------------------------------------------------------------------
    # /api/rebuild_src_text/<path:pdf_name> — src_text 再生成
    # ------------------------------------------------------------------

    @bp.route("/api/rebuild_src_text/<path:pdf_name>", methods=["POST"])
    def rebuild_src_text_api(pdf_name):
        """src_html から src_text を再生成し、シンボル置換（symbolfont_dict）を適用する。"""
        _, json_path = get_paths(pdf_name)
        if not os.path.exists(json_path):
            return jsonify({"status": "error", "message": "JSONファイルが存在しません"}), 404

        try:
            current_page = request.form.get("current_page", type=int)
            changed, delta = paragraph_service.rebuild_src_text(json_path, current_page)
        except Exception as e:
            return jsonify({"status": "error", "message": f"シンボル置換エラー: {str(e)}"}), 500

        return jsonify({"status": "ok", "message": f"シンボル置換完了 (更新: {changed}段落)", "changed": changed, "delta": delta}), 200

    # ------------------------------------------------------------------
    # /api/update_block_tags_by_style/<path:pdf_name> — スタイルによる block_tag 一括更新
    # ------------------------------------------------------------------

    @bp.route("/api/update_block_tags_by_style/<path:pdf_name>", methods=["POST"])
    def update_block_tags_by_style_api(pdf_name):
        data = request.get_json()
        target_style = data.get("target_style")
        target_tag = data.get("target_tag")
        current_page = data.get("current_page")

        if not target_style or not target_tag:
            return jsonify({"status": "error", "message": "target_style と target_tag は必須です"}), 400

        _, json_path = get_paths(pdf_name)
        if not os.path.exists(json_path):
            return jsonify({"status": "error", "message": "JSONファイルが存在しません"}), 404

        try:
            delta = paragraph_service.update_block_tags_by_style(json_path, target_style, target_tag, current_page)
            return jsonify({"status": "ok", "message": "スタイルによるblock_tag一括更新が完了しました", "delta": delta}), 200
        except Exception as e:
            current_app.logger.error(f"スタイルによるblock_tag一括更新エラー: {str(e)}")
            return jsonify({"status": "error", "message": f"スタイルによるblock_tag一括更新エラー: {str(e)}"}), 500

    # ------------------------------------------------------------------
    # /api/update_block_tags_by_style_y/<path:pdf_name> — スタイル+Y範囲による block_tag 更新
    # ------------------------------------------------------------------

    @bp.route("/api/update_block_tags_by_style_y/<path:pdf_name>", methods=["POST"])
    def update_block_tags_by_style_y_api(pdf_name):
        data = request.get_json() or {}
        target_style = data.get("target_style")
        y0 = data.get("y0")
        y1 = data.get("y1")
        action = data.get("action")
        current_page = data.get("current_page")

        if not target_style:
            return jsonify({"status": "error", "message": "target_style は必須です"}), 400
        if y0 is None or y1 is None:
            return jsonify({"status": "error", "message": "y0 と y1 は必須です"}), 400
        if action not in ["header", "footer", "remove"]:
            return jsonify({"status": "error", "message": "action は header/footer/remove のいずれかです"}), 400

        _, json_path = get_paths(pdf_name)
        if not os.path.exists(json_path):
            return jsonify({"status": "error", "message": "JSONファイルが存在しません"}), 404

        try:
            changed, delta = paragraph_service.update_block_tags_by_style_y(
                json_path, target_style, float(y0), float(y1), action, current_page
            )
            return jsonify({"status": "ok", "message": f"更新しました (変更: {changed}段落)", "changed": changed, "delta": delta}), 200
        except Exception as e:
            current_app.logger.error(f"スタイル+Y範囲によるblock_tag一括更新エラー: {str(e)}")
            return jsonify({"status": "error", "message": f"スタイル+Y範囲によるblock_tag一括更新エラー: {str(e)}"}), 500

    # ------------------------------------------------------------------
    # /api/join_replaced_paragraphs/<path:pdf_name> — 置換文結合
    # ------------------------------------------------------------------

    @bp.route("/api/join_replaced_paragraphs/<path:pdf_name>", methods=["POST"])
    def auto_join_replaced_paragraphs_api(pdf_name):
        _, json_path = get_paths(pdf_name)
        if not os.path.exists(json_path):
            return jsonify({"status": "error", "message": "JSONファイルが存在しません"}), 404
        try:
            current_page = request.form.get("current_page", type=int)
            book_data, delta = paragraph_service.join_replaced_paragraphs(json_path, current_page)
        except Exception as e:
            return jsonify({"status": "error", "message": f"置換文結合エラー: {str(e)}"}), 500
        return jsonify(
            {
                "status": "ok",
                "message": "置換文結合完了",
                "trans_status_counts": book_data.get("trans_status_counts"),
                "delta": delta,
            }
        ), 200

    # ------------------------------------------------------------------
    # /api/reextract_table_from_selection/<path:pdf_name> — テーブル再抽出
    # ------------------------------------------------------------------

    @bp.route("/api/reextract_table_from_selection/<path:pdf_name>", methods=["POST"])
    def reextract_table_from_selection_api(pdf_name):
        pdf_path, json_path = get_paths(pdf_name)
        if not os.path.exists(json_path):
            return jsonify({"status": "error", "message": "JSONファイルが存在しません"}), 404
        if not os.path.exists(pdf_path):
            return jsonify({"status": "error", "message": "PDFファイルが存在しません"}), 404

        data = request.get_json(silent=True) or {}
        page_number = data.get("current_page") or data.get("page_number")
        rows = data.get("rows")
        cols = data.get("cols")
        header_text = data.get("header_text")
        paragraph_ids = data.get("paragraph_ids") or []
        desired_rows = data.get("rows")
        desired_cols = data.get("cols")
        header_text = data.get("header_text")

        try:
            desired_rows = int(desired_rows) if desired_rows is not None and str(desired_rows).strip() else None
        except Exception:
            desired_rows = None

        try:
            desired_cols = int(desired_cols) if desired_cols is not None and str(desired_cols).strip() else None
        except Exception:
            desired_cols = None

        try:
            page_number = int(page_number)
        except Exception:
            return jsonify({"status": "error", "message": "current_page が不正です"}), 400

        if page_number <= 0:
            return jsonify({"status": "error", "message": "current_page は1以上で指定してください"}), 400

        if not isinstance(paragraph_ids, list):
            return jsonify({"status": "error", "message": "paragraph_ids は配列で指定してください"}), 400

        paragraph_ids = [str(pid).strip() for pid in paragraph_ids if str(pid).strip()]
        if len(paragraph_ids) < 1:
            return jsonify({"status": "error", "message": "1行以上選択してください"}), 400

        try:
            added, delta = paragraph_service.reextract_table_from_selection(
                pdf_name=pdf_name,
                json_path=json_path,
                pdf_path=pdf_path,
                page_number=page_number,
                paragraph_ids=paragraph_ids,
                rows=rows,
                cols=cols,
                header_text=header_text,
            )

            if added <= 0:
                return jsonify({"status": "error", "message": "再抽出結果が0件でした"}), 200

            return jsonify(
                {
                    "status": "ok",
                    "message": f"テーブル行を{added}件追加しました",
                    "added": added,
                    "delta": delta,
                }
            ), 200
        except ValueError as e:
            return jsonify({"status": "error", "message": str(e)}), 400
        except LookupError as e:
            return jsonify({"status": "error", "message": str(e)}), 404
        except Exception as e:
            current_app.logger.error(f"table reextract error: {str(e)}")
            return jsonify({"status": "error", "message": f"テーブル再抽出エラー: {str(e)}"}), 500

    # ------------------------------------------------------------------
    # /api/reextract_table_ai/<path:pdf_name> — AI による表再抽出
    # ------------------------------------------------------------------

    @bp.route("/api/reextract_table_ai/<path:pdf_name>", methods=["POST"])
    def reextract_table_ai_api(pdf_name):
        """AI（Gemini 等）を使って表領域を画像キャプチャし HTML テーブルとして再抽出する。

        Request JSON:
            current_page (int): 対象ページ番号（1始まり）。
            paragraph_ids (list[str]): 選択段落 ID のリスト。
            scale (float, optional): PNG レンダリング倍率（デフォルト 2.0）。
            margin (float, optional): 領域拡張マージン・ポイント単位（デフォルト 12.0）。

        Response JSON (ok):
            status: "ok"
            message: 追加件数を含むメッセージ。
            added (int): 追加した行数。
            delta (dict): 更新されたページデータ。

        Response JSON (error):
            status: "error"
            message: エラーメッセージ。
        """
        from app.services.ai.exceptions import AIError

        pdf_path, json_path = get_paths(pdf_name)
        if not os.path.exists(json_path):
            return jsonify({"status": "error", "message": "JSONファイルが存在しません"}), 404
        if not os.path.exists(pdf_path):
            return jsonify({"status": "error", "message": "PDFファイルが存在しません"}), 404

        data = request.get_json(silent=True) or {}
        page_number = data.get("current_page") or data.get("page_number")
        paragraph_ids = data.get("paragraph_ids") or []

        try:
            scale = float(data.get("scale", 2.0))
        except Exception:
            scale = 2.0
        try:
            margin = float(data.get("margin", 12.0))
        except Exception:
            margin = 12.0

        hint_rows = 0
        hint_cols = 0
        try:
            v = data.get("rows")
            if v is not None:
                hint_rows = max(0, int(v))
        except Exception:
            pass
        try:
            v = data.get("cols")
            if v is not None:
                hint_cols = max(0, int(v))
        except Exception:
            pass

        try:
            page_number = int(page_number)
        except Exception:
            return jsonify({"status": "error", "message": "current_page が不正です"}), 400

        if page_number <= 0:
            return jsonify({"status": "error", "message": "current_page は1以上で指定してください"}), 400

        if not isinstance(paragraph_ids, list):
            return jsonify({"status": "error", "message": "paragraph_ids は配列で指定してください"}), 400

        paragraph_ids = [str(pid).strip() for pid in paragraph_ids if str(pid).strip()]
        if len(paragraph_ids) < 1:
            return jsonify({"status": "error", "message": "1行以上選択してください"}), 400

        try:
            added, delta = paragraph_service.reextract_table_from_selection_ai(
                pdf_name=pdf_name,
                json_path=json_path,
                pdf_path=pdf_path,
                page_number=page_number,
                paragraph_ids=paragraph_ids,
                scale=scale,
                margin=margin,
                hint_rows=hint_rows,
                hint_cols=hint_cols,
            )

            if added <= 0:
                return jsonify({"status": "error", "message": "AI 再抽出結果が0件でした"}), 200

            return jsonify(
                {
                    "status": "ok",
                    "message": f"AI 表再抽出でテーブル行を{added}件追加しました",
                    "added": added,
                    "delta": delta,
                }
            ), 200
        except AIError as e:
            return jsonify({"status": "error", "message": str(e)}), 503
        except ValueError as e:
            return jsonify({"status": "error", "message": str(e)}), 400
        except LookupError as e:
            return jsonify({"status": "error", "message": str(e)}), 404
        except Exception as e:
            current_app.logger.error(f"table AI reextract error: {str(e)}")
            return jsonify({"status": "error", "message": f"AI 表再抽出エラー: {str(e)}"}), 500

    # ------------------------------------------------------------------
    # /api/reextract_table_roi/<path:pdf_name> — ROI ベース表再抽出
    # ------------------------------------------------------------------

    @bp.route("/api/reextract_table_roi/<path:pdf_name>", methods=["POST"])
    def reextract_table_roi_api(pdf_name):
        """ROI ベースのグリッド推定で表領域を自動検出し段落として再抽出する。

        選択段落の bbox 全体をひとつのテーブル領域として扱い、
        行・列を自動検出してマークダウン行形式の段落を追加する。

        Request JSON:
            current_page (int): 対象ページ番号（1始まり）。
            paragraph_ids (list[str]): 選択段落 ID のリスト。
            rows (int, optional): 行数のヒント（0 または省略で自動推定）。
            cols (int, optional): 列数のヒント（0 または省略で自動推定）。

        Response JSON (ok):
            status: "ok"
            message: 追加件数を含むメッセージ。
            added (int): 追加した行数。
            delta (dict): 更新されたページデータ。

        Response JSON (error):
            status: "error"
            message: エラーメッセージ。
        """
        pdf_path, json_path = get_paths(pdf_name)
        if not os.path.exists(json_path):
            return jsonify({"status": "error", "message": "JSONファイルが存在しません"}), 404
        if not os.path.exists(pdf_path):
            return jsonify({"status": "error", "message": "PDFファイルが存在しません"}), 404

        data = request.get_json(silent=True) or {}
        page_number = data.get("current_page") or data.get("page_number")
        paragraph_ids = data.get("paragraph_ids") or []

        hint_rows = 0
        hint_cols = 0
        try:
            v = data.get("rows")
            if v is not None:
                hint_rows = max(0, int(v))
        except Exception:
            pass
        try:
            v = data.get("cols")
            if v is not None:
                hint_cols = max(0, int(v))
        except Exception:
            pass

        try:
            page_number = int(page_number)
        except Exception:
            return jsonify({"status": "error", "message": "current_page が不正です"}), 400

        if page_number <= 0:
            return jsonify({"status": "error", "message": "current_page は1以上で指定してください"}), 400

        if not isinstance(paragraph_ids, list):
            return jsonify({"status": "error", "message": "paragraph_ids は配列で指定してください"}), 400

        paragraph_ids = [str(pid).strip() for pid in paragraph_ids if str(pid).strip()]
        if len(paragraph_ids) < 1:
            return jsonify({"status": "error", "message": "1行以上選択してください"}), 400

        try:
            added, delta = paragraph_service.reextract_table_from_selection_roi(
                pdf_name=pdf_name,
                json_path=json_path,
                pdf_path=pdf_path,
                page_number=page_number,
                paragraph_ids=paragraph_ids,
                hint_rows=hint_rows,
                hint_cols=hint_cols,
            )

            if added <= 0:
                return jsonify({"status": "error", "message": "ROI 再抽出結果が0件でした"}), 200

            return jsonify(
                {
                    "status": "ok",
                    "message": f"ROI 表再抽出でテーブル行を{added}件追加しました",
                    "added": added,
                    "delta": delta,
                }
            ), 200
        except ValueError as e:
            return jsonify({"status": "error", "message": str(e)}), 400
        except LookupError as e:
            return jsonify({"status": "error", "message": str(e)}), 404
        except Exception as e:
            current_app.logger.error(f"table ROI reextract error: {str(e)}")
            return jsonify({"status": "error", "message": f"ROI 表再抽出エラー: {str(e)}"}), 500

    # ------------------------------------------------------------------
    # /api/ai_providers — 利用可能な AI プロバイダ一覧
    # ------------------------------------------------------------------

    @bp.route("/api/ai_providers", methods=["GET"])
    def ai_providers_api():
        """登録済み AI プロバイダ名と現在の選択プロバイダを返す。

        UI がダイアログで「AI 抽出」モードを表示するときのヒントとして使用する。

        Response JSON:
            providers (list[str]): 登録済みプロバイダ名のリスト（例: ["ollama", "gemini"]）。
            current (str): AI_PROVIDER 環境変数の値（デフォルト "ollama"）。
        """
        import os

        from app.services.ai.registry import ensure_defaults_registered, registered_names

        try:
            ensure_defaults_registered()
            names = registered_names()
        except Exception:
            names = []

        current = os.getenv("AI_PROVIDER", "ollama")
        return jsonify({"status": "ok", "providers": names, "current": current})

    # ------------------------------------------------------------------
    # /api/table_grid_suggest/<path:pdf_name> — テーブルグリッド推測
    # ------------------------------------------------------------------

    @bp.route("/api/table_grid_suggest/<path:pdf_name>", methods=["POST"])
    def table_grid_suggest_api(pdf_name):
        pdf_path, json_path = get_paths(pdf_name)
        if not os.path.exists(json_path):
            return jsonify({"status": "error", "message": "JSONファイルが存在しません"}), 404
        if not os.path.exists(pdf_path):
            return jsonify({"status": "error", "message": "PDFファイルが存在しません"}), 404

        data = request.get_json(silent=True) or {}
        page_number = data.get("current_page") or data.get("page_number")
        paragraph_ids = data.get("paragraph_ids") or []
        desired_rows = data.get("rows")
        desired_cols = data.get("cols")
        header_text = data.get("header_text")

        try:
            desired_rows = int(desired_rows) if desired_rows is not None and str(desired_rows).strip() else None
        except Exception:
            desired_rows = None

        try:
            desired_cols = int(desired_cols) if desired_cols is not None and str(desired_cols).strip() else None
        except Exception:
            desired_cols = None

        try:
            page_number = int(page_number)
        except Exception:
            return jsonify({"status": "error", "message": "current_page が不正です"}), 400

        if page_number <= 0:
            return jsonify({"status": "error", "message": "current_page は1以上で指定してください"}), 400

        if not isinstance(paragraph_ids, list):
            return jsonify({"status": "error", "message": "paragraph_ids は配列で指定してください"}), 400

        paragraph_ids = [str(pid).strip() for pid in paragraph_ids if str(pid).strip()]
        if len(paragraph_ids) < 1:
            return jsonify({"status": "error", "message": "1行以上選択してください"}), 400

        try:
            suggestion = paragraph_service.table_grid_suggest(
                pdf_name=pdf_name,
                json_path=json_path,
                pdf_path=pdf_path,
                page_number=page_number,
                paragraph_ids=paragraph_ids,
                desired_rows=desired_rows,
                desired_cols=desired_cols,
                header_text=header_text,
            )

            if not suggestion.get("ok"):
                return jsonify({"status": "error", "message": suggestion.get("message") or "推測に失敗しました"}), 200

            return jsonify(
                {
                    "status": "ok",
                    "rows": suggestion.get("rows"),
                    "cols": suggestion.get("cols"),
                    "clip_rect": suggestion.get("clip_rect"),
                    "preview_cell_rects": suggestion.get("preview_cell_rects") or [],
                    "header_text": suggestion.get("header_text") or "",
                }
            ), 200
        except ValueError as e:
            return jsonify({"status": "error", "message": str(e)}), 400
        except LookupError as e:
            return jsonify({"status": "error", "message": str(e)}), 404
        except Exception as e:
            current_app.logger.error(f"table grid suggest error: {str(e)}")
            return jsonify({"status": "error", "message": f"テーブルグリッド推測エラー: {str(e)}"}), 500

    # ------------------------------------------------------------------
    # /api/update_book_info/<path:pdf_name> — ブック情報更新
    # ------------------------------------------------------------------

    @bp.route("/api/update_book_info/<path:pdf_name>", methods=["POST"])
    def update_book_info_api(pdf_name):
        data = request.get_json()
        new_title = data.get("title")
        new_page_count = data.get("page_count")
        new_trans_status_counts = data.get("trans_status_counts")

        if not new_title:
            return jsonify({"status": "error", "message": "titleが指定されていません"}), 400

        try:
            paragraph_service.update_book_info(pdf_name, new_title, new_page_count, new_trans_status_counts)
            return jsonify({"status": "ok", "message": "文書情報が更新されました"}), 200
        except FileNotFoundError as e:
            return jsonify({"status": "error", "message": str(e)}), 404
        except LookupError as e:
            return jsonify({"status": "error", "message": str(e)}), 404
        except Exception as e:
            return jsonify({"status": "error", "message": f"文書情報更新中にエラーが発生しました: {str(e)}"}), 500

    # ------------------------------------------------------------------
    # /api/update_paragraph/<path:pdf_name> — 単一段落の翻訳保存
    # ------------------------------------------------------------------

    @bp.route("/api/update_paragraph/<path:pdf_name>", methods=["POST"])
    def update_paragraph_api(pdf_name):
        data = request.get_json()
        page_number = str(data.get("page_number"))
        paragraph_id = str(data["id"])
        new_src_text = data["src_text"]
        new_trans_auto = data["trans_auto"]
        new_trans_text = data["trans_text"]
        new_comment = data.get("comment")
        new_status = data["trans_status"]
        new_block_tag = data["block_tag"]
        new_join = data.get("join")
        new_markup = data.get("markup")

        print("update_paragraph_api:" + __import__("json").dumps(data, indent=2, ensure_ascii=False))

        _, json_path = get_paths(pdf_name)
        if not os.path.exists(json_path):
            return jsonify({"status": "error", "message": "(update_paragraph_api 1)JSONが存在しません"}), 400

        try:
            trans_status_counts, reload_book_data = paragraph_service.update_paragraph(
                json_path=json_path,
                page_number=page_number,
                paragraph_id=paragraph_id,
                src_text=new_src_text,
                trans_auto=new_trans_auto,
                trans_text=new_trans_text,
                comment=new_comment,
                status=new_status,
                block_tag=new_block_tag,
                new_join=new_join,
                markup=new_markup,
            )
            return jsonify(
                {
                    "status": "ok",
                    "trans_status_counts": trans_status_counts,
                    "reload_book_data": reload_book_data,
                }
            ), 200
        except LookupError as e:
            return jsonify({"status": "error", "message": f"(update_paragraph_api 2){str(e)}"}), 404
        except ValueError as ve:
            return jsonify({"status": "error", "message:": "(update_paragraph_api 3)" + str(ve)}), 400
        except Exception as e:
            return jsonify({"status": "error", "message": f"(update_paragraph_api 4): {str(e)}"}), 500

    # ------------------------------------------------------------------
    # /api/update_paragraphs/<path:pdf_name> — 複数段落の一括更新
    # ------------------------------------------------------------------

    @bp.route("/api/update_paragraphs/<path:pdf_name>", methods=["POST"])
    def update_paragraphs_api(pdf_name):
        _, json_path = get_paths(pdf_name)
        if not os.path.exists(json_path):
            return jsonify({"status": "error", "message": "JSONファイルが存在しません"}), 404

        request_data = request.get_json()
        if not request_data or "title" not in request_data:
            return jsonify({"status": "error", "message": "title がありません"}), 400

        print("update_paragraphs_api:" + __import__("json").dumps(request_data, indent=2, ensure_ascii=False))

        try:
            request_title = request_data.get("title")
            request_paragraphs = request_data.get("paragraphs")
            trans_status_counts, reload_book_data = paragraph_service.update_paragraphs(
                json_path=json_path,
                title=request_title,
                paragraphs=request_paragraphs,
            )
            return jsonify(
                {
                    "status": "ok",
                    "trans_status_counts": trans_status_counts,
                    "reload_book_data": reload_book_data,
                }
            ), 200
        except ValueError as ve:
            return jsonify({"status": "error", "message": str(ve)}), 400
        except Exception as e:
            return jsonify({"status": "error", "message": f"更新中にエラーが発生しました: {str(e)}"}), 500

    # ------------------------------------------------------------------
    # /api/delete_paragraphs/<path:pdf_name> — 段落削除
    # ------------------------------------------------------------------

    @bp.route("/api/delete_paragraphs/<path:pdf_name>", methods=["POST"])
    def delete_paragraphs_api(pdf_name):
        """選択したパラグラフを削除"""
        _, json_path = get_paths(pdf_name)
        if not os.path.exists(json_path):
            return jsonify({"status": "error", "message": "JSONファイルが存在しません"}), 404

        request_data = request.get_json()
        if not request_data or "paragraphs" not in request_data:
            return jsonify({"status": "error", "message": "paragraphs がありません"}), 400

        request_paragraphs = request_data.get("paragraphs")
        if not request_paragraphs:
            return jsonify({"status": "error", "message": "削除対象がありません"}), 400

        try:
            deleted_count, trans_status_counts = paragraph_service.delete_paragraphs(
                json_path=json_path,
                paragraphs=request_paragraphs,
            )
            return jsonify(
                {
                    "status": "ok",
                    "message": f"{deleted_count}個のパラグラフを削除しました",
                    "deleted_count": deleted_count,
                    "trans_status_counts": trans_status_counts,
                }
            ), 200
        except Exception as e:
            current_app.logger.error(f"delete_paragraphs error: {str(e)}")
            return jsonify({"status": "error", "message": f"削除中にエラーが発生しました: {str(e)}"}), 500

    return bp
