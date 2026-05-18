import csv
import io
from fastapi import APIRouter, Depends
from fastapi.responses import StreamingResponse
from sqlalchemy.orm import Session, joinedload
from typing import Optional
from backend.db import get_db
from backend.models import Card, Section, TopicTree, Curriculum

router = APIRouter()


@router.get("/cards")
def export_cards(
    topic_tree_id: Optional[int] = None,
    section_id: Optional[int] = None,
    curriculum_id: Optional[int] = None,
    card_ids: Optional[str] = None,  # comma-separated IDs
    db: Session = Depends(get_db),
):
    q = db.query(Card).options(joinedload(Card.section))

    if card_ids:
        ids = [int(i) for i in card_ids.split(",") if i.strip().isdigit()]
        q = q.filter(Card.id.in_(ids))
    elif section_id:
        q = q.filter(Card.section_id == section_id)
    elif topic_tree_id:
        q = q.join(Card.section).filter(Section.topic_tree_id == topic_tree_id)
    elif curriculum_id:
        node = db.get(Curriculum, curriculum_id)
        if node:
            q = q.join(Card.section).filter(
                (Section.curriculum_topic_path == node.path) |
                Section.curriculum_topic_path.startswith(node.path + " > ")
            )

    cards = q.all()

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
        writer.writerow({
            "note_id": card.note_id or "",
            "id": card.id,
            "front_text": card.front_text,
            "front_html": card.front_html,
            "tags": ",".join(card.tags or []),
            "extra": card.extra or "",
            "vignette": card.vignette or "",
            "teaching_case": card.teaching_case or "",
            "ref_img_position": card.ref_img_position or "",
            "source_ref": card.source_ref or "",
            "status": card.status,
            "needs_review": card.needs_review,
            "section_heading": section.heading if section else "",
            "topic_tree": "",
            "curriculum_topic_path": section.curriculum_topic_path if section else "",
        })
    output.seek(0)
    return StreamingResponse(
        output,
        media_type="text/csv",
        headers={"Content-Disposition": "attachment; filename=cards.csv"},
    )
