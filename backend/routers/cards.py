from __future__ import annotations
import csv
import io
import json
import logging
import anthropic
from fastapi import APIRouter, Depends, HTTPException, Query
from sqlalchemy import cast, String, func, or_
from sqlalchemy.orm import Session, joinedload
from pydantic import BaseModel
from typing import Optional
from backend.db import get_db
from backend.models import Card, CardStatus, Section, SectionImage, RuleSet, AIUsageLog, Curriculum, utcnow
from backend.services.generator import strip_card_html, regenerate_single_card, parse_card_output
from backend.services.ai_utils import response_text
from backend.services.card_ops import assign_note_ids, score_new_cards
from backend.services.manual_card_parser import parse_pasted_cards
from backend.config import ANTHROPIC_API_KEY, DEFAULT_MODEL, compute_cost, resolve_model, effort_kwargs

logger = logging.getLogger(__name__)

router = APIRouter()


class RegenerateCardRequest(BaseModel):
    model: str = DEFAULT_MODEL
    prompt: Optional[str] = None
    card_version: str = "base"  # base | v1 | v2 | v3 — which front column to edit


# Which Card column holds the front for a given card version.
_VERSION_FIELD = {"v1": "front_html_v1", "v2": "front_html_v2", "v3": "front_html_v3"}


def _front_field(card_version: str) -> str:
    return _VERSION_FIELD.get(card_version, "front_html")


def _read_front(card: "Card", card_version: str) -> str:
    """The active version's front, falling back to base if that version is empty."""
    return getattr(card, _front_field(card_version), None) or card.front_html or ""


def _write_front(card: "Card", card_version: str, front_html: str) -> None:
    """Write the front to the active version's column (base also updates front_text)."""
    field = _front_field(card_version)
    setattr(card, field, front_html)
    if field == "front_html":
        card.front_text = strip_card_html(front_html)


_EXTRA_FIELD = {"v1": "extra_v1", "v2": "extra_v2", "v3": "extra_v3"}


def _extra_field(card_version: str) -> str:
    return _EXTRA_FIELD.get(card_version, "extra")


def _read_extra(card: "Card", card_version: str):
    """The active version's extra, falling back to base when that version is empty."""
    return getattr(card, _extra_field(card_version), None) or card.extra


def _write_extra(card: "Card", card_version: str, extra) -> None:
    """Write extra to the active version's column."""
    setattr(card, _extra_field(card_version), extra)


# Per-version accuracy/yield score columns. Base scoring writes the unversioned trio.
_SCORE_FIELDS = {
    "v1": ("accuracy_score_v1", "accuracy_note_v1", "eor_yield_v1"),
    "v2": ("accuracy_score_v2", "accuracy_note_v2", "eor_yield_v2"),
    "v3": ("accuracy_score_v3", "accuracy_note_v3", "eor_yield_v3"),
}


def _score_fields(card_version: str):
    return _SCORE_FIELDS.get(card_version, ("accuracy_score", "accuracy_note", "eor_yield"))


def _write_score(card: "Card", card_version: str, accuracy, note, eor) -> None:
    fa, fn, fe = _score_fields(card_version)
    setattr(card, fa, accuracy)
    setattr(card, fn, note)
    setattr(card, fe, eor)


# Per-version validator (X/N correctness) columns.
_CORRECTNESS_FIELDS = {
    "v1": ("correctness_score_v1", "correctness_v1"),
    "v2": ("correctness_score_v2", "correctness_v2"),
    "v3": ("correctness_score_v3", "correctness_v3"),
}


def _correctness_fields(card_version: str):
    return _CORRECTNESS_FIELDS.get(card_version, ("correctness_score", "correctness"))


def _write_correctness(card: "Card", card_version: str, passed, corr) -> None:
    fs, fc = _correctness_fields(card_version)
    setattr(card, fs, passed)
    setattr(card, fc, corr)


# validation_change is stored as a per-version map: {"<version>": {action, prev_front_html, prev_extra, at}, ...}
# Each version (base/v1/v2/v3) keeps its OWN before/after so it can be reverted independently.
_VC_KEYS = ("action", "prev_front_html", "prev_extra", "at")


def _vc_map(vc) -> dict:
    """Normalize validation_change to the per-version map shape.

    Migrates the old flat shape ({action, prev_front_html, prev_extra, at, version})
    by re-keying it under its recorded version (defaulting to 'base')."""
    if not vc:
        return {}
    if "action" in vc:  # legacy flat record
        ver = vc.get("version") or "base"
        return {ver: {k: vc[k] for k in _VC_KEYS if k in vc}}
    return dict(vc)


class CardPatch(BaseModel):
    front_html: Optional[str] = None
    front_html_v1: Optional[str] = None
    front_html_v2: Optional[str] = None
    front_html_v3: Optional[str] = None
    tags: Optional[list[str]] = None
    tags_mapped: Optional[list[str]] = None
    extra: Optional[str] = None
    extra_v1: Optional[str] = None
    extra_v2: Optional[str] = None
    extra_v3: Optional[str] = None
    vignette: Optional[str] = None
    teaching_case: Optional[str] = None
    ref_img_id: Optional[int] = None
    ref_img_position: Optional[str] = None
    status: Optional[CardStatus] = None
    is_reviewed: Optional[bool] = None


def card_to_dict(card: Card, db: Session | None = None, img_cache: dict | None = None) -> dict:
    resolved_img = None
    ref_img_id = getattr(card, "ref_img_id", None)
    if ref_img_id:
        if img_cache is not None:
            resolved_img = img_cache.get(ref_img_id)
        elif db:
            section_img = db.get(SectionImage, ref_img_id)
            if section_img:
                resolved_img = section_img.data_uri
    return {
        "id": card.id,
        "section_id": card.section_id,
        "card_number": card.card_number,
        "front_html": card.front_html,
        "front_html_v1": card.front_html_v1,
        "front_html_v2": card.front_html_v2,
        "front_html_v3": card.front_html_v3,
        "front_text": card.front_text,
        "tags": card.tags,
        "tags_mapped": card.tags_mapped,
        "extra": card.extra,
        "extra_v1": card.extra_v1,
        "extra_v2": card.extra_v2,
        "extra_v3": card.extra_v3,
        "vignette": card.vignette,
        "teaching_case": card.teaching_case,
        "ref_img": resolved_img,
        "ref_img_id": ref_img_id,
        "ref_img_position": card.ref_img_position,
        "source_ref": card.source_ref,
        "note_id": card.note_id,
        "status": card.status,
        "is_reviewed": card.is_reviewed,
        "review_mark_id": card.review_mark_id if hasattr(card, 'review_mark_id') else None,
        "in_fix_batch": card.in_fix_batch if hasattr(card, 'in_fix_batch') else False,
        "manually_added": getattr(card, "manually_added", False),
        "accuracy_score": card.accuracy_score,
        "accuracy_note": card.accuracy_note,
        "eor_yield": card.eor_yield,
        "accuracy_score_v1": getattr(card, "accuracy_score_v1", None),
        "accuracy_score_v2": getattr(card, "accuracy_score_v2", None),
        "accuracy_score_v3": getattr(card, "accuracy_score_v3", None),
        "accuracy_note_v1": getattr(card, "accuracy_note_v1", None),
        "accuracy_note_v2": getattr(card, "accuracy_note_v2", None),
        "accuracy_note_v3": getattr(card, "accuracy_note_v3", None),
        "eor_yield_v1": getattr(card, "eor_yield_v1", None),
        "eor_yield_v2": getattr(card, "eor_yield_v2", None),
        "eor_yield_v3": getattr(card, "eor_yield_v3", None),
        "correctness_score": getattr(card, "correctness_score", None),
        "correctness": getattr(card, "correctness", None),
        "correctness_score_v1": getattr(card, "correctness_score_v1", None),
        "correctness_score_v2": getattr(card, "correctness_score_v2", None),
        "correctness_score_v3": getattr(card, "correctness_score_v3", None),
        "correctness_v1": getattr(card, "correctness_v1", None),
        "correctness_v2": getattr(card, "correctness_v2", None),
        "correctness_v3": getattr(card, "correctness_v3", None),
        "validation_change": getattr(card, "validation_change", None),
        "needs_review": card.needs_review if hasattr(card, 'needs_review') else False,
        "created_at": card.created_at.isoformat() if card.created_at else None,
        "updated_at": card.updated_at.isoformat() if card.updated_at else None,
        "section_heading": card.section.heading if card.section else None,
        "curriculum_topic_path": card.section.curriculum_topic_path if card.section else None,
    }


@router.get("")
def list_cards(
    section_id: Optional[int] = None,
    section_ids: Optional[str] = None,  # comma-separated
    topic_tree_id: Optional[int] = None,
    status: Optional[CardStatus] = None,
    is_reviewed: Optional[bool] = None,
    mark_type_id: Optional[int] = None,
    tag: Optional[str] = None,
    topic: Optional[str] = None,
    search_q: Optional[str] = None,
    modified_by_validator: Optional[bool] = None,
    version: Optional[str] = None,
    limit: int = Query(100, le=1000),
    offset: int = 0,
    db: Session = Depends(get_db),
):
    q = db.query(Card).options(
        joinedload(Card.section),
    )
    if topic_tree_id:
        q = q.join(Card.section).filter(Section.topic_tree_id == topic_tree_id)
    if section_id:
        q = q.filter(Card.section_id == section_id)
    if section_ids:
        ids = [int(x) for x in section_ids.split(',') if x.strip().isdigit()]
        if ids:
            q = q.filter(Card.section_id.in_(ids))
    if topic:
        if not topic_tree_id:
            q = q.join(Card.section)
        q = q.filter(Section.curriculum_topic_path.startswith(topic))
    if status:
        q = q.filter(Card.status == status)
    if is_reviewed is not None:
        q = q.filter(Card.is_reviewed == is_reviewed)
    if mark_type_id is not None:
        q = q.filter(Card.review_mark_id == mark_type_id)
    if tag:
        q = q.filter(cast(Card.tags, String).contains(json.dumps(tag)))
    if search_q:
        q = q.filter(Card.front_text.ilike(f"%{search_q}%"))
    if modified_by_validator:
        q = q.filter(Card.validation_change.isnot(None))
        if version:
            vc_str = cast(Card.validation_change, String)
            # New per-version map shape stores "<version>": {...}; legacy flat shape stores "version": "<v>".
            q = q.filter(or_(
                vc_str.contains(f'"{version}":'),
                vc_str.contains(f'"version": "{version}"'),
                vc_str.contains(f'"version":"{version}"'),
            ))

    # Order
    if section_id:
        q = q.order_by(Card.card_number)
    else:
        q = q.join(Card.section, isouter=True).order_by(Section.sort_order, Card.card_number)

    total = q.count()
    cards = q.offset(offset).limit(limit).all()

    # Batch-fetch ref images for the page in one query (avoids N+1)
    ref_img_ids = {c.ref_img_id for c in cards if c.ref_img_id}
    img_cache = {}
    if ref_img_ids:
        for img in db.query(SectionImage).filter(SectionImage.id.in_(ref_img_ids)).all():
            img_cache[img.id] = img.data_uri

    return {"cards": [card_to_dict(c, db, img_cache) for c in cards], "total": total, "limit": limit, "offset": offset}


@router.patch("/{card_id}")
def patch_card(card_id: int, body: CardPatch, db: Session = Depends(get_db)):
    card = db.get(Card, card_id)
    if not card:
        raise HTTPException(404)
    # Use the set of fields the client actually SENT (model_fields_set), not
    # "is not None" — otherwise an explicit null (clearing extra/vignette/
    # teaching_case to empty) is indistinguishable from "field omitted" and the
    # deletion silently doesn't persist.
    sent = body.model_fields_set
    if "front_html" in sent:
        card.front_html = body.front_html or ""
        card.front_text = strip_card_html(body.front_html or "")
    if "front_html_v1" in sent:
        card.front_html_v1 = body.front_html_v1
    if "front_html_v2" in sent:
        card.front_html_v2 = body.front_html_v2
    if "front_html_v3" in sent:
        card.front_html_v3 = body.front_html_v3
    if "tags" in sent:
        card.tags = body.tags
    if "tags_mapped" in sent:
        card.tags_mapped = body.tags_mapped
    if "extra" in sent:
        card.extra = body.extra
    if "extra_v1" in sent:
        card.extra_v1 = body.extra_v1
    if "extra_v2" in sent:
        card.extra_v2 = body.extra_v2
    if "extra_v3" in sent:
        card.extra_v3 = body.extra_v3
    if "vignette" in sent:
        card.vignette = body.vignette
    if "teaching_case" in sent:
        card.teaching_case = body.teaching_case
    if "ref_img_id" in sent:
        card.ref_img_id = body.ref_img_id or None  # 0 / null both mean "clear"
    if "ref_img_position" in sent:
        card.ref_img_position = body.ref_img_position
    if "status" in sent and body.status is not None:
        card.status = body.status
    if "is_reviewed" in sent:
        card.is_reviewed = body.is_reviewed
    db.commit()
    db.refresh(card)
    return card_to_dict(card, db)


@router.post("/{card_id}/regenerate")
def regenerate_card(card_id: int, body: RegenerateCardRequest, db: Session = Depends(get_db)):
    card = db.get(Card, card_id)
    if not card:
        raise HTTPException(404)
    section = db.get(Section, card.section_id)
    if not section:
        raise HTTPException(404, "Section not found")
    rs = db.query(RuleSet).filter_by(rule_type='generation', is_default=True).first()
    rules = rs.content if rs else "Generate cloze cards. Use {{c1::term}} format."
    client = anthropic.Anthropic(api_key=ANTHROPIC_API_KEY)
    cards_data, needs_review, usage = regenerate_single_card(
        client,
        section_data={
            "content_text": section.content_text,
            "content_html": section.content_html,
            "heading": section.heading,
            "curriculum_topic_path": section.curriculum_topic_path,
        },
        existing_card_html=_read_front(card, body.card_version),
        rules_text=rules,
        extra_prompt=body.prompt or None,
        model=body.model,
    )
    if cards_data:
        _write_front(card, body.card_version, cards_data[0]["front_html"])
        if cards_data[0].get("extra") is not None:
            _write_extra(card, body.card_version, cards_data[0]["extra"])
        card.source_ref = cards_data[0].get("source_ref")
        card.is_reviewed = False
    db.commit()
    if usage:
        db.add(AIUsageLog(
            operation="card_regen",
            model=body.model,
            input_tokens=usage.get("input_tokens", 0),
            output_tokens=usage.get("output_tokens", 0),
            cost_usd=compute_cost(body.model, usage.get("input_tokens", 0), usage.get("output_tokens", 0)),
            card_id=card_id,
            section_id=card.section_id,
        ))
        db.commit()
    db.refresh(card)
    return card_to_dict(card, db)


class CombinePreviewRequest(BaseModel):
    card_ids: list[int]
    prompt: Optional[str] = None
    model: str = DEFAULT_MODEL


class CombineApplyRequest(BaseModel):
    card_ids: list[int]
    front_html: str
    extra: Optional[str] = None
    tags: list[str] = []
    keep_original: bool = False
    model: str = DEFAULT_MODEL


_COMBINE_SYSTEM = (
    "You merge several Anki cloze flashcards covering related material into ONE consolidated cloze card. "
    "Keep the medically important facts, remove redundancy, and keep it answerable for a PA EOR exam. "
    "Use cloze deletions of the form {{c1::answer}} (always c1). Use <b>...</b> for bold — never markdown. "
    'Return ONLY JSON: {"front_html": "...", "extra": "... or null", "tags": ["..."]}.'
)


@router.post("/combine-preview")
def combine_preview(body: CombinePreviewRequest, db: Session = Depends(get_db)):
    """Propose a single card that merges the given cards (not persisted)."""
    cards = db.query(Card).filter(Card.id.in_(body.card_ids)).all()
    if len(cards) < 2:
        raise HTTPException(400, "Select at least two cards to combine")
    lines = []
    for i, c in enumerate(cards, 1):
        tags = (c.tags or c.tags_mapped) or []
        lines.append(f"Card {i}:\n  front: {c.front_text}\n  extra: {c.extra or '(none)'}\n  tags: {', '.join(tags)}")
    guidance = (body.prompt or "").strip() or "Combine them sensibly into one focused card."
    user = (
        "Combine the following flashcards into a single consolidated cloze card. "
        f"Goal/guidance: {guidance}\n\n" + "\n\n".join(lines) +
        "\n\nReturn the combined card as JSON only."
    )
    client = anthropic.Anthropic(api_key=ANTHROPIC_API_KEY)
    resp = client.messages.create(
        model=resolve_model(body.model)[0],
        **effort_kwargs(body.model),
        max_tokens=2048,
        temperature=0,
        system=_COMBINE_SYSTEM,
        messages=[{"role": "user", "content": user}],
    )
    raw = response_text(resp)
    try:
        data = json.loads(raw)
    except json.JSONDecodeError:
        s, e = raw.find("{"), raw.rfind("}") + 1
        if s >= 0 and e > s:
            data = json.loads(raw[s:e])
        else:
            raise HTTPException(502, "Could not parse the combined card")
    u = resp.usage
    db.add(AIUsageLog(
        operation="combine",
        model=body.model,
        input_tokens=u.input_tokens,
        output_tokens=u.output_tokens,
        cost_usd=compute_cost(body.model, u.input_tokens, u.output_tokens),
        section_id=cards[0].section_id if cards else None,
    ))
    db.commit()
    return {
        "front_html": data.get("front_html", ""),
        "extra": data.get("extra") or None,
        # Inherit the source tags (ignore AI-suggested tags) — combined card stays in place.
        "tags": (cards[0].tags or cards[0].tags_mapped) or [],
        "source_card_ids": [c.id for c in cards],
    }


@router.post("/combine-apply")
def combine_apply(body: CombineApplyRequest, db: Session = Depends(get_db)):
    """Create the combined card; reject the originals unless keep_original."""
    cards = db.query(Card).filter(Card.id.in_(body.card_ids)).all()
    if not cards:
        raise HTTPException(400, "No cards found")
    src = cards[0]
    # Inherit tags + the first available vignette / teaching case from the sources.
    vignette = next((c.vignette for c in cards if c.vignette), None)
    teaching_case = next((c.teaching_case for c in cards if c.teaching_case), None)
    new = Card(
        section_id=src.section_id,
        card_number=src.card_number,
        front_html=body.front_html,
        front_text=strip_card_html(body.front_html),
        tags=src.tags,
        tags_mapped=src.tags_mapped,
        extra=body.extra or None,
        vignette=vignette,
        teaching_case=teaching_case,
        status=CardStatus.active,
        is_reviewed=True,
    )
    db.add(new)
    assign_note_ids([new])
    if not body.keep_original:
        # Hard-delete the originals so they actually disappear (reject would keep
        # them visible under the default "All statuses" view).
        for c in cards:
            db.delete(c)
    db.commit()
    db.refresh(new)
    # Accuracy + EOR-yield score pass on the combined card (best-effort).
    sec = db.get(Section, new.section_id)
    client = anthropic.Anthropic(api_key=ANTHROPIC_API_KEY)
    score_new_cards(db, client, [new], sec.curriculum_topic_path if sec else "", body.model)
    return card_to_dict(new, db)


@router.post("/{card_id}/regenerate-preview")
def regenerate_card_preview(card_id: int, body: RegenerateCardRequest, db: Session = Depends(get_db)):
    """Generate a replacement card WITHOUT applying it — returns the proposed
    front/extra so the reviewer can accept, edit, or retry with a new prompt."""
    card = db.get(Card, card_id)
    if not card:
        raise HTTPException(404)
    section = db.get(Section, card.section_id)
    if not section:
        raise HTTPException(404, "Section not found")
    rs = db.query(RuleSet).filter_by(rule_type='generation', is_default=True).first()
    rules = rs.content if rs else "Generate cloze cards. Use {{c1::term}} format."
    client = anthropic.Anthropic(api_key=ANTHROPIC_API_KEY)
    cards_data, _needs_review, usage = regenerate_single_card(
        client,
        section_data={
            "content_text": section.content_text,
            "content_html": section.content_html,
            "heading": section.heading,
            "curriculum_topic_path": section.curriculum_topic_path,
        },
        existing_card_html=_read_front(card, body.card_version),
        rules_text=rules,
        extra_prompt=body.prompt or None,
        model=body.model,
    )
    if usage:
        db.add(AIUsageLog(
            operation="card_regen_preview",
            model=body.model,
            input_tokens=usage.get("input_tokens", 0),
            output_tokens=usage.get("output_tokens", 0),
            cost_usd=compute_cost(body.model, usage.get("input_tokens", 0), usage.get("output_tokens", 0)),
            card_id=card_id,
            section_id=card.section_id,
        ))
        db.commit()
    if not cards_data:
        raise HTTPException(502, "Regeneration produced no card")
    return {
        "front_html": cards_data[0]["front_html"],
        "extra": cards_data[0].get("extra"),
        "source_ref": cards_data[0].get("source_ref"),
    }


@router.post("/{card_id}/reject")
def reject_card(card_id: int, db: Session = Depends(get_db)):
    card = db.get(Card, card_id)
    if not card:
        raise HTTPException(404)
    card.status = CardStatus.rejected
    card.is_reviewed = True
    db.commit()
    db.refresh(card)
    return card_to_dict(card, db)


class BulkReviewRequest(BaseModel):
    card_ids: list[int]
    is_reviewed: bool = True


@router.post("/bulk-review")
def bulk_mark_reviewed(body: BulkReviewRequest, db: Session = Depends(get_db)):
    if body.card_ids:
        db.query(Card).filter(Card.id.in_(body.card_ids)).update(
            {"is_reviewed": body.is_reviewed}, synchronize_session=False
        )
        db.commit()
    return {"updated": len(body.card_ids)}


class BulkDeleteRequest(BaseModel):
    card_ids: Optional[list[int]] = None
    section_id: Optional[int] = None
    section_ids: Optional[list[int]] = None
    topic_tree_id: Optional[int] = None


@router.post("/bulk-delete", status_code=200)
def bulk_delete_cards(body: BulkDeleteRequest, db: Session = Depends(get_db)):
    q = db.query(Card)
    if body.card_ids:
        q = q.filter(Card.id.in_(body.card_ids))
    elif body.section_ids:
        q = q.filter(Card.section_id.in_(body.section_ids))
    elif body.section_id:
        q = q.filter(Card.section_id == body.section_id)
    elif body.topic_tree_id:
        q = q.join(Card.section).filter(Section.topic_tree_id == body.topic_tree_id)
    else:
        raise HTTPException(400, "Provide card_ids, section_id, section_ids, or topic_tree_id")

    count = q.count()
    q.delete(synchronize_session=False)
    db.commit()
    return {"deleted": count}


class BulkScoreRequest(BaseModel):
    card_ids: list[int]
    model: str = DEFAULT_MODEL
    card_version: str = "base"


@router.post("/bulk-score")
def bulk_score_cards(body: BulkScoreRequest, db: Session = Depends(get_db)):
    """Score cards for accuracy and EOR yield."""
    if not body.card_ids:
        raise HTTPException(400, "No card_ids provided")
    model_name = body.model
    ver = body.card_version

    def _ver_front_raw(c):
        # The version's own front (no base fallback) so we can skip cards that
        # don't have this version populated.
        return c.front_html if ver == "base" else getattr(c, _front_field(ver), None)

    from backend.services.scorer import score_cards

    client = anthropic.Anthropic(api_key=ANTHROPIC_API_KEY)
    cards = db.query(Card).filter(Card.id.in_(body.card_ids)).all()

    # Group by section for curriculum path context
    section_groups = {}
    for c in cards:
        section_groups.setdefault(c.section_id, []).append(c)

    # Batch-fetch sections in one query
    sections = {
        s.id: s for s in
        db.query(Section).filter(Section.id.in_(section_groups.keys())).all()
    }

    total_scored = 0
    failed_groups = 0

    for section_id, group_cards in section_groups.items():
        section = sections.get(section_id)
        path = section.curriculum_topic_path if section else ""
        cards_by_id = {c.id: c for c in group_cards}
        cards_for_scoring = [
            {
                "id": c.id,
                "front_text": c.front_text if ver == "base" else strip_card_html(_ver_front_raw(c) or ""),
                "extra": _read_extra(c, ver),
            }
            for c in group_cards if (_ver_front_raw(c) or "").strip()
        ]
        if not cards_for_scoring:
            continue

        try:
            scores, usage = score_cards(client, cards_for_scoring, path or "", model_name)
            for score in scores:
                card = cards_by_id.get(score.get("card_id"))
                if card:
                    _write_score(card, ver, score.get("accuracy"), score.get("accuracy_note"), score.get("eor_yield"))
                    total_scored += 1
            ti, to = usage.get("input_tokens", 0), usage.get("output_tokens", 0)
            if ti or to:
                db.add(AIUsageLog(
                    operation="card_scoring", model=model_name,
                    input_tokens=ti, output_tokens=to,
                    cost_usd=compute_cost(model_name, ti, to),
                    section_id=section_id,
                    topic_tree_id=section.topic_tree_id if section else None,
                ))
        except Exception:
            logger.exception("Error scoring cards for section %d", section_id)
            failed_groups += 1

    db.commit()

    return {"scored": total_scored, "failed_groups": failed_groups}


class ValidateRequest(BaseModel):
    card_ids: list[int]
    model: str = DEFAULT_MODEL
    auto_fix: bool = True
    card_version: str = "base"  # base | v1 | v2 | v3 — which front column to validate/fix


@router.get("/validation-rules")
def get_validation_rules():
    """The correctness rules + what each one checks (for the in-app reference)."""
    from backend.services.correctness_validator import RULES
    return [{"key": r["key"], "title": r["title"], "criteria": r["criteria"]} for r in RULES]


@router.post("/validate")
def validate_cards(body: ValidateRequest, db: Session = Depends(get_db)):
    """Grade cards against the correctness rubric and (optionally) auto-fix
    failing ones: regenerate single-card issues, or auto-split a card flagged
    as needing sibling cards (one level deep). Stores a per-rule scorecard."""
    if not body.card_ids:
        raise HTTPException(400, "No card_ids provided")
    from concurrent.futures import ThreadPoolExecutor, as_completed
    from backend.services.correctness_validator import judge_cards, summarize, fix_guidance, split_card, RULE_KEYS, ensure_cloze_styling
    from backend.services.generator import regenerate_single_card

    client = anthropic.Anthropic(api_key=ANTHROPIC_API_KEY)
    cards = db.query(Card).filter(Card.id.in_(body.card_ids)).all()
    cards_by_id = {c.id: c for c in cards}

    section_groups: dict[int, list] = {}
    for c in cards:
        section_groups.setdefault(c.section_id, []).append(c)
    sections = {s.id: s for s in db.query(Section).filter(Section.id.in_(section_groups.keys())).all()}

    rs = db.query(RuleSet).filter_by(rule_type="generation", is_default=True).first()
    rules_text = rs.content if rs else "Generate cloze cards. Use {{c1::term}} format."

    total_input = 0
    total_output = 0
    per_section_usage: dict[int, dict] = {}  # section_id -> {"i","o"} for cost attribution
    ver = body.card_version  # which front column to validate/fix

    def _acc_sec(sid, i, o):
        if sid is None:
            return
        d = per_section_usage.setdefault(sid, {"i": 0, "o": 0})
        d["i"] += i
        d["o"] += o

    def _ver_front(c):
        # The selected version's front WITHOUT base fallback (None/empty if that
        # version isn't populated — used to skip such cards in version mode).
        return c.front_html if ver == "base" else getattr(c, _front_field(ver), None)

    # 1) Batch-judge every card in each section (one call per section). In a
    #    non-base version, only judge cards that actually have that version.
    initial: dict[int, dict] = {}
    for sid, group in section_groups.items():
        payload = [
            {"id": c.id, "front_html": _ver_front(c), "extra": _read_extra(c, ver)}
            for c in group if (_ver_front(c) or "").strip()
        ]
        if not payload:
            continue
        sec = sections.get(sid)
        cpath = (sec.curriculum_topic_path or "") if sec else ""
        try:
            results, usage = judge_cards(client, payload, body.model, cpath)
            total_input += usage.get("input_tokens", 0)
            total_output += usage.get("output_tokens", 0)
            _acc_sec(sid, usage.get("input_tokens", 0), usage.get("output_tokens", 0))
            for r in results:
                initial[r["card_id"]] = r
        except Exception:
            logger.exception("Validation judge failed for section %d", sid)

    # Plain (thread-safe) snapshots — do NOT touch the ORM/session inside workers.
    section_data_by_card: dict[int, dict] = {}
    state_by_card: dict[int, dict] = {}
    for cid in initial:
        c = cards_by_id[cid]
        s = sections.get(c.section_id)
        section_data_by_card[cid] = {
            "content_text": s.content_text if s else "",
            "content_html": s.content_html if s else "",
            "heading": s.heading if s else "",
            "curriculum_topic_path": s.curriculum_topic_path if s else "",
        }
        state_by_card[cid] = {"front_html": _ver_front(c) or c.front_html, "extra": _read_extra(c, ver)}

    def _fixable(result: dict) -> list:
        # Everything failing except single-concept when a split is suggested
        # (that's handled by the split path / capped to avoid re-splitting).
        return [
            r for r in result["rules"]
            if not r["pass"] and not (r["key"] == "single_concept" and result.get("split_suggested"))
        ]

    def _passed(result):
        return summarize(result["rules"])[0] if result else -1

    def regen_fix_loop(front_html, extra, section_data, temp_id, initial_result, u):
        """Judge (if needed) then regenerate up to 3x, keeping the best-scoring
        attempt across rounds (not just the last). Never splits. Mutates u."""
        cpath = section_data.get("curriculum_topic_path", "")
        result = initial_result
        if result is None:
            try:
                rj, ju = judge_cards(client, [{"id": temp_id, "front_html": front_html, "extra": extra}], body.model, cpath)
                u["input_tokens"] += ju.get("input_tokens", 0)
                u["output_tokens"] += ju.get("output_tokens", 0)
                result = rj[0] if rj else None
            except Exception:
                logger.exception("Initial judge failed for temp %s", temp_id)
        best = (front_html, extra, result)
        best_passed = _passed(result)
        for _ in range(3):
            if not result:
                break
            failed = _fixable(result)
            if not failed:
                break
            try:
                cards_data, _nr, fu = regenerate_single_card(
                    client, section_data, front_html, rules_text, extra_prompt=fix_guidance(failed), model=body.model
                )
                u["input_tokens"] += fu.get("input_tokens", 0)
                u["output_tokens"] += fu.get("output_tokens", 0)
                if cards_data:
                    front_html = ensure_cloze_styling(cards_data[0]["front_html"])
                    extra = cards_data[0].get("extra")
                rj, ju = judge_cards(client, [{"id": temp_id, "front_html": front_html, "extra": extra}], body.model, cpath)
                u["input_tokens"] += ju.get("input_tokens", 0)
                u["output_tokens"] += ju.get("output_tokens", 0)
                if rj:
                    result = rj[0]
                    p = _passed(result)
                    if p > best_passed:
                        best, best_passed = (front_html, extra, result), p
                    if not _fixable(result):  # nothing left to fix — stop early
                        break
            except Exception:
                logger.exception("Fix loop failed for temp %s", temp_id)
                break
        return best

    def worker(cid: int) -> dict:
        result = initial[cid]
        front_html = state_by_card[cid]["front_html"]
        extra = state_by_card[cid]["extra"]
        section_data = section_data_by_card[cid]
        u = {"input_tokens": 0, "output_tokens": 0}

        if not body.auto_fix:
            return {"card_id": cid, "action": "fix", "front_html": front_html, "extra": extra, "result": result, "usage": u}

        # Split path: card flagged as needing sibling cards.
        # Split only in base mode — v1/v2/v3 are 1:1 rephrasings of base cards,
        # so changing the card count there would desync the versions.
        needs_split = ver == "base" and result.get("split_suggested") and any(
            r["key"] == "single_concept" and not r["pass"] for r in result["rules"]
        )
        if needs_split:
            try:
                siblings_raw, su = split_card(client, section_data, front_html, extra, rules_text, body.model)
                u["input_tokens"] += su.get("input_tokens", 0)
                u["output_tokens"] += su.get("output_tokens", 0)
                valid_sibs = [s for s in siblings_raw if (s.get("front_html") or "").strip()]
                if len(valid_sibs) >= 2:
                    processed = []
                    for i, sib in enumerate(valid_sibs):
                        fh, ex, sres = regen_fix_loop(ensure_cloze_styling(sib["front_html"]), sib.get("extra"), section_data, i + 1, None, u)
                        processed.append({"front_html": fh, "extra": ex, "result": sres})
                    return {"card_id": cid, "action": "split", "siblings": processed, "usage": u}
            except Exception:
                logger.exception("Auto-split failed for card %d", cid)
            # fall through to a normal regenerate if the split didn't yield >=2

        fh, ex, res = regen_fix_loop(front_html, extra, section_data, cid, result, u)
        return {"card_id": cid, "action": "fix", "front_html": fh, "extra": ex, "result": res, "usage": u}

    validated = 0
    fixed = 0
    split_count = 0
    all_new_cards: list = []  # note_ids minted once at the end to avoid same-ms collisions
    with ThreadPoolExecutor(max_workers=3) as ex:
        futures = [ex.submit(worker, cid) for cid in initial]
        for fut in as_completed(futures):
            out = fut.result()
            total_input += out["usage"]["input_tokens"]
            total_output += out["usage"]["output_tokens"]
            card = cards_by_id[out["card_id"]]
            _acc_sec(card.section_id, out["usage"]["input_tokens"], out["usage"]["output_tokens"])

            now_iso = utcnow().isoformat()
            if out["action"] == "split":
                sid = card.section_id
                inh_tags, inh_mapped = card.tags, card.tags_mapped
                vig, tc = card.vignette, card.teaching_case
                orig_front, orig_extra = card.front_html, card.extra
                split_change = {"base": {"action": "split", "prev_front_html": orig_front, "prev_extra": orig_extra, "at": now_iso}}
                db.delete(card)  # replace the original with its siblings
                db.flush()
                start_num = (
                    db.query(func.coalesce(func.max(Card.card_number), 0)).filter(Card.section_id == sid).scalar()
                ) or 0
                new_cards = []
                for j, sib in enumerate(out["siblings"]):
                    res = sib["result"]
                    if res:
                        passed, total = summarize(res["rules"])
                        corr = {"total": total, "rules": res["rules"], "split_suggested": res.get("split_suggested", False)}
                    else:
                        passed, corr = None, None
                    nc = Card(
                        section_id=sid,
                        card_number=start_num + 1 + j,
                        front_html=sib["front_html"],
                        front_text=strip_card_html(sib["front_html"]),
                        extra=sib.get("extra"),
                        tags=inh_tags,
                        tags_mapped=inh_mapped,
                        vignette=vig,
                        teaching_case=tc,
                        status=CardStatus.active,
                        correctness_score=passed,
                        correctness=corr,
                        validation_change=split_change,
                    )
                    db.add(nc)
                    new_cards.append(nc)
                db.flush()  # so the next split's max(card_number) query sees these
                all_new_cards.extend(new_cards)
                split_count += 1
                validated += len(new_cards)
            else:
                res = out["result"]
                cur_front = getattr(card, _front_field(ver), None) or card.front_html
                if out["front_html"] != cur_front:
                    vcmap = _vc_map(card.validation_change)
                    vcmap[ver] = {
                        "action": "fixed",
                        "prev_front_html": cur_front,
                        "prev_extra": _read_extra(card, ver),
                        "at": now_iso,
                    }
                    card.validation_change = vcmap
                    _write_front(card, ver, out["front_html"])
                    _write_extra(card, ver, out["extra"])
                    fixed += 1
                if res:
                    passed, total = summarize(res["rules"])
                    _write_correctness(card, ver, passed, {"total": total, "rules": res["rules"], "split_suggested": res.get("split_suggested", False)})
                validated += 1
    if all_new_cards:
        assign_note_ids(all_new_cards)  # unique across the whole request
    db.commit()

    for sid, u in per_section_usage.items():
        if u["i"] or u["o"]:
            sec = sections.get(sid)
            db.add(AIUsageLog(
                operation="card_validation",
                model=body.model,
                input_tokens=u["i"],
                output_tokens=u["o"],
                cost_usd=compute_cost(body.model, u["i"], u["o"]),
                section_id=sid,
                topic_tree_id=sec.topic_tree_id if sec else None,
            ))
    db.commit()

    return {"validated": validated, "fixed": fixed, "split": split_count}


@router.post("/{card_id}/revert-validation")
def revert_validation(card_id: int, version: str = "base", db: Session = Depends(get_db)):
    """Undo an auto-fix for ONE version: restore that version's front (and the
    shared extra) from before the validator changed it, and drop that version's
    change marker, leaving the other versions' markers untouched."""
    card = db.get(Card, card_id)
    if not card:
        raise HTTPException(404)
    vcmap = _vc_map(card.validation_change)
    entry = vcmap.get(version)
    if not entry or entry.get("action") != "fixed":
        raise HTTPException(422, f"Nothing to revert for {version} (only auto-fixed cards can be reverted)")
    _write_front(card, version, entry.get("prev_front_html") or "")
    _write_extra(card, version, entry.get("prev_extra"))
    vcmap.pop(version, None)
    card.validation_change = vcmap or None
    db.commit()
    db.refresh(card)
    return card_to_dict(card, db)


@router.post("/clear-validation-marks")
def clear_validation_marks(body: BulkDeleteRequest, db: Session = Depends(get_db)):
    """Clear the 'changed by validator' marker on cards (after you've reviewed
    them) without reverting anything. Accepts the same scope as bulk ops."""
    q = db.query(Card)
    if body.card_ids:
        q = q.filter(Card.id.in_(body.card_ids))
    elif body.section_id:
        q = q.filter(Card.section_id == body.section_id)
    elif body.section_ids:
        q = q.filter(Card.section_id.in_(body.section_ids))
    else:
        raise HTTPException(400, "Provide a scope")
    n = q.filter(Card.validation_change.isnot(None)).update({Card.validation_change: None}, synchronize_session=False)
    db.commit()
    return {"cleared": n}


class ManualCardInput(BaseModel):
    front_html: str
    extra: Optional[str] = None
    tags: Optional[list[str]] = None


class AddManualCardsRequest(BaseModel):
    section_id: int
    cards: Optional[list[ManualCardInput]] = None  # structured single/multi entry
    raw_text: Optional[str] = None                 # pasted blob
    csv_text: Optional[str] = None                 # contents of an exported cards CSV
    card_version: str = "base"                     # base | v1 | v2 | v3 — where fronts/extra land
    include_supplementals: bool = True             # import vignette + teaching case (shared, not versioned)
    model: str = DEFAULT_MODEL                      # only used to parse raw_text (haiku)
    format: Optional[str] = None                   # 'pipe' → parse with the real card parser; else Haiku


def _truthy(v) -> bool:
    return str(v or "").strip().lower() in ("true", "1", "yes")


def _cards_from_csv(csv_text: str) -> list[dict]:
    """Parse an exported cards CSV (see export.py) back into structured card dicts.

    Exact reproduction — no AI. Recognises the export's column names; a row needs
    at least front_html to be importable. Tags are comma-joined in the export, so
    we split them back. note_id/id are intentionally ignored — imported cards get
    fresh ids to avoid collisions with cards still in the DB.
    """
    reader = csv.DictReader(io.StringIO(csv_text))
    out: list[dict] = []
    for row in reader:
        front_html = (row.get("front_html") or "").strip()
        if not front_html:
            continue
        tags_raw = (row.get("tags") or "").strip()
        # Tags are exported joined with "::" (curriculum tags contain commas).
        # Split on that; fall back to comma only for legacy/hand-edited CSVs.
        tag_sep = "::" if "::" in tags_raw else ","
        out.append({
            "front_html": front_html,
            "front_text": (row.get("front_text") or "").strip() or None,
            "extra": (row.get("extra") or "").strip() or None,
            "tags": [t.strip() for t in tags_raw.split(tag_sep) if t.strip()],
            "source_ref": (row.get("source_ref") or "").strip() or None,
            "vignette": (row.get("vignette") or "").strip() or None,
            "teaching_case": (row.get("teaching_case") or "").strip() or None,
            "needs_review": _truthy(row.get("needs_review")),
        })
    return out


@router.post("/manual")
def add_manual_cards(body: AddManualCardsRequest, db: Session = Depends(get_db)):
    """Add hand-written or pasted cards to a section. Pasted text (raw_text) is
    structured by Haiku verbatim. New cards get unique ids + note_ids and are
    flagged manually_added. No scoring (run Actions → Score Cards if wanted)."""
    section = db.get(Section, body.section_id)
    if not section:
        raise HTTPException(404, "Section not found")

    # Resolve which tag column this section's curriculum version writes to.
    cv = None
    if section.curriculum_topic_id:
        cur = db.get(Curriculum, section.curriculum_topic_id)
        cv = cur.version if cur else None
    section_tags = section.curriculum_topic_path.split(" > ") if section.curriculum_topic_path else []

    # Gather the structured card dicts to create.
    to_create: list[dict] = []
    if body.cards:
        for c in body.cards:
            if not (c.front_html or "").strip():
                continue
            to_create.append({
                "front_html": c.front_html.strip(),
                "extra": (c.extra or "").strip() or None,
                "tags": [t for t in (c.tags or []) if t.strip()],
                "source_ref": None,
            })

    # Exact CSV re-import (no AI) — restore cards from an exported cards CSV.
    if body.csv_text and body.csv_text.strip():
        to_create.extend(_cards_from_csv(body.csv_text))

    parse_usage = None
    if body.raw_text and body.raw_text.strip():
        if body.format == "pipe":
            # The text is already in our number|card|extra output format (e.g. an
            # Inspect debug response) — parse it with the real generation parser.
            parsed_cards, _needs_review = parse_card_output(body.raw_text)
            for pc in parsed_cards:
                to_create.append({
                    "front_html": pc["front_html"],
                    "front_text": pc.get("front_text"),
                    "extra": pc.get("extra"),
                    "tags": [],
                    "source_ref": pc.get("source_ref"),
                    "needs_review": pc.get("needs_review", False),
                })
        else:
            client = anthropic.Anthropic(api_key=ANTHROPIC_API_KEY)
            parsed, parse_usage = parse_pasted_cards(client, body.raw_text, body.model)
            to_create.extend(parsed)

    if not to_create:
        raise HTTPException(422, "No cards to add (provide cards and/or raw_text)")

    start_num = (
        db.query(func.coalesce(func.max(Card.card_number), 0))
        .filter(Card.section_id == section.id)
        .scalar()
    ) or 0

    # Which card version the new cards' front/extra land in (base or v1/v2/v3).
    target_version = body.card_version if body.card_version in ("v1", "v2", "v3") else "base"

    created: list[Card] = []
    for i, cd in enumerate(to_create):
        fh = cd["front_html"]
        kwargs = dict(
            section_id=section.id,
            card_number=start_num + i + 1,
            # front_text always reflects the imported text so search/scoring work,
            # even for version-only cards (base front_html left empty).
            front_text=cd.get("front_text") or strip_card_html(fh),
            source_ref=cd.get("source_ref"),
            needs_review=cd.get("needs_review", False),
            manually_added=True,
            status=CardStatus.active,
        )
        if target_version == "base":
            kwargs["front_html"] = fh
            kwargs["extra"] = cd.get("extra")
        else:
            # Version-only card: base front stays empty, content goes to the
            # selected version's columns (front_html_vN / extra_vN).
            kwargs["front_html"] = None
            kwargs[_front_field(target_version)] = fh
            kwargs[_extra_field(target_version)] = cd.get("extra")
        # Vignette + teaching case are shared (not versioned) — import only when
        # the user opted in, regardless of which version the fronts go to.
        if body.include_supplementals:
            if cd.get("vignette"):
                kwargs["vignette"] = cd["vignette"]
            if cd.get("teaching_case"):
                kwargs["teaching_case"] = cd["teaching_case"]
        # Card-specific tags from the paste win; otherwise inherit the section's.
        tags = cd.get("tags") or section_tags
        if cv == "v1":
            kwargs["tags_mapped"] = tags
            kwargs["tags"] = []
        else:
            kwargs["tags"] = tags
        card = Card(**kwargs)
        db.add(card)
        created.append(card)

    db.flush()
    assign_note_ids(created)
    db.commit()

    if parse_usage:
        db.add(AIUsageLog(
            operation="manual_card_parse",
            model=body.model,
            input_tokens=parse_usage.get("input_tokens", 0),
            output_tokens=parse_usage.get("output_tokens", 0),
            cache_write_tokens=parse_usage.get("cache_creation_input_tokens", 0),
            cache_read_tokens=parse_usage.get("cache_read_input_tokens", 0),
            cost_usd=compute_cost(
                body.model,
                parse_usage.get("input_tokens", 0),
                parse_usage.get("output_tokens", 0),
                parse_usage.get("cache_creation_input_tokens", 0),
                parse_usage.get("cache_read_input_tokens", 0),
            ),
            topic_tree_id=section.topic_tree_id,
            section_id=section.id,
        ))
        db.commit()

    for c in created:
        db.refresh(c)
    return {"created": [card_to_dict(c, db) for c in created]}


@router.delete("/{card_id}", status_code=204)
def delete_card(card_id: int, db: Session = Depends(get_db)):
    card = db.get(Card, card_id)
    if not card:
        raise HTTPException(404)
    db.delete(card)
    db.commit()
