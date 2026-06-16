from __future__ import annotations
import json
import logging
import anthropic
from fastapi import APIRouter, Depends, HTTPException, Query
from sqlalchemy import cast, String, func
from sqlalchemy.orm import Session, joinedload
from pydantic import BaseModel
from typing import Optional
from backend.db import get_db
from backend.models import Card, CardStatus, Section, SectionImage, RuleSet, AIUsageLog, Curriculum
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


class CardPatch(BaseModel):
    front_html: Optional[str] = None
    front_html_v1: Optional[str] = None
    front_html_v2: Optional[str] = None
    front_html_v3: Optional[str] = None
    tags: Optional[list[str]] = None
    tags_mapped: Optional[list[str]] = None
    extra: Optional[str] = None
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
        "correctness_score": getattr(card, "correctness_score", None),
        "correctness": getattr(card, "correctness", None),
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
        existing_card_html=card.front_html,
        rules_text=rules,
        extra_prompt=body.prompt or None,
        model=body.model,
    )
    if cards_data:
        card.front_html = cards_data[0]["front_html"]
        card.front_text = cards_data[0]["front_text"]
        if cards_data[0].get("extra") is not None:
            card.extra = cards_data[0]["extra"]
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
        existing_card_html=card.front_html,
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


@router.post("/bulk-score")
def bulk_score_cards(body: BulkScoreRequest, db: Session = Depends(get_db)):
    """Score cards for accuracy and EOR yield."""
    if not body.card_ids:
        raise HTTPException(400, "No card_ids provided")
    model_name = body.model

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
    total_input = 0
    total_output = 0
    failed_groups = 0

    for section_id, group_cards in section_groups.items():
        section = sections.get(section_id)
        path = section.curriculum_topic_path if section else ""
        cards_by_id = {c.id: c for c in group_cards}
        cards_for_scoring = [
            {"id": c.id, "front_text": c.front_text, "extra": c.extra}
            for c in group_cards
        ]

        try:
            scores, usage = score_cards(client, cards_for_scoring, path or "", model_name)
            for score in scores:
                card = cards_by_id.get(score.get("card_id"))
                if card:
                    card.accuracy_score = score.get("accuracy")
                    card.accuracy_note = score.get("accuracy_note")
                    card.eor_yield = score.get("eor_yield")
                    total_scored += 1
            total_input += usage.get("input_tokens", 0)
            total_output += usage.get("output_tokens", 0)
        except Exception:
            logger.exception("Error scoring cards for section %d", section_id)
            failed_groups += 1

    db.commit()

    if total_input or total_output:
        db.add(AIUsageLog(
            operation="card_scoring",
            model=model_name,
            input_tokens=total_input,
            output_tokens=total_output,
            cost_usd=compute_cost(model_name, total_input, total_output),
        ))
        db.commit()

    return {"scored": total_scored, "failed_groups": failed_groups}


class ValidateRequest(BaseModel):
    card_ids: list[int]
    model: str = DEFAULT_MODEL
    auto_fix: bool = True


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
    from backend.services.correctness_validator import judge_cards, summarize, fix_guidance, split_card, RULE_KEYS
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

    # 1) Batch-judge every card in each section (one call per section).
    initial: dict[int, dict] = {}
    for sid, group in section_groups.items():
        payload = [{"id": c.id, "front_html": c.front_html, "extra": c.extra} for c in group]
        try:
            results, usage = judge_cards(client, payload, body.model)
            total_input += usage.get("input_tokens", 0)
            total_output += usage.get("output_tokens", 0)
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
        state_by_card[cid] = {"front_html": c.front_html, "extra": c.extra}

    def _fixable(result: dict) -> list:
        # Everything failing except single-concept when a split is suggested
        # (that's handled by the split path / capped to avoid re-splitting).
        return [
            r for r in result["rules"]
            if not r["pass"] and not (r["key"] == "single_concept" and result.get("split_suggested"))
        ]

    def regen_fix_loop(front_html, extra, section_data, temp_id, initial_result, u):
        """Judge (if needed) then regenerate up to 3x. Never splits. Mutates u."""
        result = initial_result
        if result is None:
            try:
                rj, ju = judge_cards(client, [{"id": temp_id, "front_html": front_html, "extra": extra}], body.model)
                u["input_tokens"] += ju.get("input_tokens", 0)
                u["output_tokens"] += ju.get("output_tokens", 0)
                result = rj[0] if rj else None
            except Exception:
                logger.exception("Initial judge failed for temp %s", temp_id)
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
                    front_html = cards_data[0]["front_html"]
                    extra = cards_data[0].get("extra")
                rj, ju = judge_cards(client, [{"id": temp_id, "front_html": front_html, "extra": extra}], body.model)
                u["input_tokens"] += ju.get("input_tokens", 0)
                u["output_tokens"] += ju.get("output_tokens", 0)
                if rj:
                    result = rj[0]
            except Exception:
                logger.exception("Fix loop failed for temp %s", temp_id)
                break
        return front_html, extra, result

    def worker(cid: int) -> dict:
        result = initial[cid]
        front_html = state_by_card[cid]["front_html"]
        extra = state_by_card[cid]["extra"]
        section_data = section_data_by_card[cid]
        u = {"input_tokens": 0, "output_tokens": 0}

        if not body.auto_fix:
            return {"card_id": cid, "action": "fix", "front_html": front_html, "extra": extra, "result": result, "usage": u}

        # Split path: card flagged as needing sibling cards.
        needs_split = result.get("split_suggested") and any(
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
                        fh, ex, sres = regen_fix_loop(sib["front_html"], sib.get("extra"), section_data, i + 1, None, u)
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
    with ThreadPoolExecutor(max_workers=3) as ex:
        futures = [ex.submit(worker, cid) for cid in initial]
        for fut in as_completed(futures):
            out = fut.result()
            total_input += out["usage"]["input_tokens"]
            total_output += out["usage"]["output_tokens"]
            card = cards_by_id[out["card_id"]]

            if out["action"] == "split":
                sid = card.section_id
                inh_tags, inh_mapped = card.tags, card.tags_mapped
                vig, tc = card.vignette, card.teaching_case
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
                    )
                    db.add(nc)
                    new_cards.append(nc)
                db.flush()
                assign_note_ids(new_cards)
                split_count += 1
                validated += len(new_cards)
            else:
                res = out["result"]
                if out["front_html"] != card.front_html:
                    card.front_html = out["front_html"]
                    card.front_text = strip_card_html(out["front_html"])
                    card.extra = out["extra"]
                    fixed += 1
                if res:
                    passed, total = summarize(res["rules"])
                    card.correctness_score = passed
                    card.correctness = {"total": total, "rules": res["rules"], "split_suggested": res.get("split_suggested", False)}
                validated += 1
    db.commit()

    if total_input or total_output:
        db.add(AIUsageLog(
            operation="card_validation",
            model=body.model,
            input_tokens=total_input,
            output_tokens=total_output,
            cost_usd=compute_cost(body.model, total_input, total_output),
        ))
        db.commit()

    return {"validated": validated, "fixed": fixed, "split": split_count}


class ManualCardInput(BaseModel):
    front_html: str
    extra: Optional[str] = None
    tags: Optional[list[str]] = None


class AddManualCardsRequest(BaseModel):
    section_id: int
    cards: Optional[list[ManualCardInput]] = None  # structured single/multi entry
    raw_text: Optional[str] = None                 # pasted blob
    model: str = DEFAULT_MODEL                      # only used to parse raw_text (haiku)
    format: Optional[str] = None                   # 'pipe' → parse with the real card parser; else Haiku


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

    created: list[Card] = []
    for i, cd in enumerate(to_create):
        kwargs = dict(
            section_id=section.id,
            card_number=start_num + i + 1,
            front_html=cd["front_html"],
            front_text=cd.get("front_text") or strip_card_html(cd["front_html"]),
            extra=cd.get("extra"),
            source_ref=cd.get("source_ref"),
            needs_review=cd.get("needs_review", False),
            manually_added=True,
            status=CardStatus.active,
        )
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
