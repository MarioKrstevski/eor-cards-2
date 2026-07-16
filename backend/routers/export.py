import csv
import io
import re
from fastapi import APIRouter, Depends
from fastapi.responses import StreamingResponse
from sqlalchemy.orm import Session, joinedload
from typing import Optional
from backend.db import get_db
from backend.models import Card, CardStatus, Section, TopicTree, Curriculum

router = APIRouter()


def _safe_filename(name: str) -> str:
    """Turn a section/topic name into a safe CSV filename stem."""
    name = (name or "").strip()
    name = re.sub(r"[^\w\s-]", "", name)      # drop punctuation/symbols
    name = re.sub(r"\s+", "_", name).strip("_")
    return name or "cards"


@router.get("/cards")
def export_cards(
    topic_tree_id: Optional[int] = None,
    section_id: Optional[int] = None,
    curriculum_id: Optional[int] = None,
    topic_path: Optional[str] = None,  # curriculum_topic_path string
    card_ids: Optional[str] = None,  # comma-separated IDs
    tag_set: Optional[str] = None,  # 'old' → tags column, 'new' → tags_mapped
    card_version: Optional[str] = None,  # base (default) / v1 / v2 / v3
    db: Session = Depends(get_db),
):
    # Rejected cards never export — they're soft-deleted from the deck's view.
    q = db.query(Card).options(joinedload(Card.section)).filter(Card.status == CardStatus.active)

    # Name the download after the scope (section heading / topic leaf / tree name).
    download_name = "cards"
    if card_ids:
        ids = [int(i) for i in card_ids.split(",") if i.strip().isdigit()]
        q = q.filter(Card.id.in_(ids))
        download_name = "selected-cards"
    elif section_id:
        q = q.filter(Card.section_id == section_id)
        sec = db.get(Section, section_id)
        if sec:
            download_name = sec.heading
    elif topic_tree_id:
        q = q.join(Card.section).filter(Section.topic_tree_id == topic_tree_id)
        tt = db.get(TopicTree, topic_tree_id)
        if tt:
            download_name = tt.name
    elif topic_path:
        q = q.join(Card.section).filter(
            (Section.curriculum_topic_path == topic_path) |
            Section.curriculum_topic_path.startswith(topic_path + " > ")
        )
        download_name = topic_path.split(" > ")[-1]
    elif curriculum_id:
        node = db.get(Curriculum, curriculum_id)
        if node:
            q = q.join(Card.section).filter(
                (Section.curriculum_topic_path == node.path) |
                Section.curriculum_topic_path.startswith(node.path + " > ")
            )
            download_name = node.name

    cards = q.all()

    # Export the CURRENTLY SELECTED version. v1/v2/v3 live in their own columns;
    # a card with no content for that version falls back to base so nothing is lost.
    from backend.services.generator import strip_card_html

    def _versioned(card):
        if card_version in ("v1", "v2", "v3"):
            fh = getattr(card, f"front_html_{card_version}", None)
            if fh:
                ex = getattr(card, f"extra_{card_version}", None)
                return fh, strip_card_html(fh), (ex or "")
        return card.front_html, card.front_text, (card.extra or "")

    tree_names = {t.id: t.name for t in db.query(TopicTree).all()}

    output = io.StringIO()
    writer = csv.DictWriter(output, fieldnames=[
        "note_id", "id", "front_text", "front_html", "tags", "extra",
        "vignette", "teaching_case", "ref_img_position",
        "source_ref", "status", "needs_review", "section_heading",
        "topic_tree", "curriculum_topic_path",
    ])
    writer.writeheader()
    for card in cards:
        section = card.section
        v_front_html, v_front_text, v_extra = _versioned(card)
        writer.writerow({
            "note_id": card.note_id or "",
            "id": card.id,
            "front_text": v_front_text,
            "front_html": v_front_html,
            # Tags follow the header's selected tag set, matching the table:
            # 'new' → tags_mapped, otherwise ('old') → tags. Fall back to the
            # other column if the selected one is empty.
            # Joined with "::" (Anki-style, no spaces): individual curriculum
            # tags contain commas (e.g. "Gynecologic, Sexual, and Reproductive
            # Health"), so a comma delimiter would be ambiguous. "::" never
            # appears in a tag.
            "tags": "::".join(
                (card.tags_mapped or card.tags or [])
                if tag_set == "new"
                else (card.tags or card.tags_mapped or [])
            ),
            "extra": v_extra,
            "vignette": card.vignette or "",
            "teaching_case": card.teaching_case or "",
            "ref_img_position": card.ref_img_position or "",
            "source_ref": card.source_ref or "",
            "status": card.status,
            "needs_review": card.needs_review,
            "section_heading": section.heading if section else "",
            "topic_tree": tree_names.get(section.topic_tree_id, "") if section else "",
            "curriculum_topic_path": section.curriculum_topic_path if section else "",
        })
    filename = f"{_safe_filename(download_name)}.csv"
    # Emit UTF-8 with a BOM so Excel/Anki read ≤, –, β etc. correctly instead of
    # decoding as Windows-1252 (which produced mojibake like "â‰¤" / "â€“").
    body = ("﻿" + output.getvalue()).encode("utf-8")
    return StreamingResponse(
        io.BytesIO(body),
        media_type="text/csv; charset=utf-8",
        headers={"Content-Disposition": f"attachment; filename={filename}"},
    )
