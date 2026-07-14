import logging
import threading
import time
from concurrent.futures import ThreadPoolExecutor, as_completed
from fastapi import APIRouter, Depends, HTTPException, BackgroundTasks
from sqlalchemy import func, or_
from sqlalchemy.orm import Session
from pydantic import BaseModel
from typing import Optional
from backend.db import get_db, SessionLocal
from backend.models import (
    Section, Card, GenerationJob, JobStatus, CardStatus,
    RuleSet, AIUsageLog, TopicTree, Curriculum, utcnow,
)
from backend.services.generator import generate_cards_for_section, build_generation_prompt
from backend.services.ai_utils import response_text, usage_dict
from backend.services.llm import complete_text
from backend.config import resolve_model, effort_kwargs, anthropic_model
from backend.services.scorer import score_cards
from backend.services.cost_estimator import estimate_cost, estimate_supplemental_cost
from backend.services.ai_utils import RETRYABLE_ERRORS
from backend.config import MODELS, DEFAULT_MODEL, ANTHROPIC_API_KEY, compute_cost, model_choices
import anthropic

logger = logging.getLogger(__name__)

router = APIRouter()


class EstimateRequest(BaseModel):
    topic_tree_id: Optional[int] = None
    section_ids: Optional[list[int]] = None
    topic_path: Optional[str] = None  # scope to sections under this curriculum path
    rule_set_id: int
    model: str = DEFAULT_MODEL


class StartRequest(BaseModel):
    topic_tree_id: Optional[int] = None
    section_ids: Optional[list[int]] = None
    topic_path: Optional[str] = None  # scope to sections under this curriculum path
    rule_set_id: int
    model: str = DEFAULT_MODEL
    replace_existing: bool = True
    card_version: str = "base"   # base/v1/v2/v3 — where generated front+extra are written


class SupplementalEstimateRequest(BaseModel):
    card_ids: list[int]
    model: str


class SupplementalStartRequest(BaseModel):
    card_ids: Optional[list[int]] = None
    section_id: Optional[int] = None
    section_ids: Optional[list[int]] = None
    rule_set_id: Optional[int] = None  # omit/None → use the default vignette rule set
    model: str
    replace_existing: bool = False


class DebugPromptRequest(BaseModel):
    rule_set_id: Optional[int] = None  # omit → default generation rule set


class DebugRunRequest(BaseModel):
    model: str = DEFAULT_MODEL
    rule_set_id: Optional[int] = None


def _debug_rules_text(rule_set_id: Optional[int], db: Session) -> str:
    rs = db.get(RuleSet, rule_set_id) if rule_set_id else None
    if not rs or rs.rule_type != "generation":
        rs = db.query(RuleSet).filter_by(rule_type="generation", is_default=True).first()
    return rs.content if rs else "Generate cloze cards. Use {{c1::term}} format."


def _debug_section_data(section: Section) -> dict:
    return {
        "id": section.id,
        "content_text": section.content_text,
        "content_html": section.content_html,
        "content_source": section.content_source,
        "heading": section.heading,
        "heading_tree": section.heading_tree,
        "curriculum_topic_path": section.curriculum_topic_path,
    }


@router.post("/section/{section_id}/debug-prompt")
def debug_prompt(section_id: int, body: DebugPromptRequest, db: Session = Depends(get_db)):
    """Return the EXACT prompt we'd send to Claude for this section — no API
    call, no cost, instant. The prompt is identical across models, so the model
    is only needed for the separate run step."""
    section = db.get(Section, section_id)
    if not section:
        raise HTTPException(404, "Section not found")
    rules_text = _debug_rules_text(body.rule_set_id, db)
    system_text, user_text = build_generation_prompt(_debug_section_data(section), rules_text)
    return {"section_heading": section.heading, "system": system_text, "user": user_text}


@router.post("/section/{section_id}/debug-run")
def debug_run(section_id: int, body: DebugRunRequest, db: Session = Depends(get_db)):
    """Run the generation prompt against ONE model and return the raw response,
    without saving cards. Call once per model to compare outputs. Cost is logged
    so the usage total stays accurate."""
    section = db.get(Section, section_id)
    if not section:
        raise HTTPException(404, "Section not found")
    rules_text = _debug_rules_text(body.rule_set_id, db)
    system_text, user_text = build_generation_prompt(_debug_section_data(section), rules_text)

    # Route through the provider wrapper so Gemini can be compared side-by-side.
    # Unlike generation, the debug tool SHOWS truncated output (it does not raise)
    # so the reviewer can see exactly what each model returned. A couple quick
    # retries ride out brief 503 spikes; if the model is genuinely overloaded we
    # return a readable message (not a 500) so the inspect column shows what
    # happened for that model instead of a generic request failure.
    raw = stop_reason = None
    usage = {"input_tokens": 0, "output_tokens": 0,
             "cache_read_input_tokens": 0, "cache_creation_input_tokens": 0}
    for attempt in range(3):
        try:
            raw, usage, stop_reason = complete_text(
                # 8192 (not 16384) keeps the side-by-side compare responsive —
                # plenty to judge each model's card quality/format.
                body.model, system_text, user_text, temperature=0, max_tokens=8192,
            )
            break
        except RETRYABLE_ERRORS as e:
            if attempt == 2:
                logger.warning("Inspect run for '%s' gave up (overloaded): %s",
                               body.model, str(e)[:200])
                return {
                    "model": body.model,
                    "raw_response": (
                        f"⚠️ {body.model} is overloaded right now (server returned 503 "
                        "— high demand). No output generated; try again in a moment."
                    ),
                    "stop_reason": "overloaded",
                    "usage": usage,
                    "cost_usd": 0.0,
                }
            time.sleep(3)

    cost = compute_cost(
        body.model,
        usage["input_tokens"],
        usage["output_tokens"],
        usage.get("cache_creation_input_tokens", 0),
        usage.get("cache_read_input_tokens", 0),
    )
    db.add(AIUsageLog(
        operation="generate_debug",
        model=body.model,
        input_tokens=usage["input_tokens"],
        output_tokens=usage["output_tokens"],
        cache_write_tokens=usage.get("cache_creation_input_tokens", 0),
        cache_read_tokens=usage.get("cache_read_input_tokens", 0),
        cost_usd=cost,
        topic_tree_id=section.topic_tree_id,
        section_id=section.id,
    ))
    db.commit()

    return {
        "model": body.model,
        "raw_response": raw,
        "stop_reason": stop_reason,
        "usage": usage,
        "cost_usd": cost,
    }


def _get_sections(
    topic_tree_id: Optional[int],
    section_ids: Optional[list[int]],
    db: Session,
    topic_path: Optional[str] = None,
) -> list[Section]:
    if section_ids:
        sections = db.query(Section).filter(Section.id.in_(section_ids)).all()
        if len(sections) != len(section_ids):
            raise HTTPException(422, "Some section_ids not found")
        return sections
    if topic_path:
        # Sections whose curriculum path is at or under this node (matches how the
        # card list scopes by topic) — NOT the whole topic tree.
        # Exact node or true descendants only — bare startswith would also match
        # sibling topics whose names merely extend the prefix.
        sections = db.query(Section).filter(
            or_(
                Section.curriculum_topic_path == topic_path,
                Section.curriculum_topic_path.startswith(topic_path + " > "),
            )
        ).all()
        if not sections:
            raise HTTPException(404, "No sections found for that topic")
        return sections
    if topic_tree_id:
        tt = db.get(TopicTree, topic_tree_id)
        if not tt:
            raise HTTPException(404, "Topic tree not found")
        return db.query(Section).filter_by(topic_tree_id=topic_tree_id).all()
    raise HTTPException(400, "Provide topic_tree_id, section_ids, or topic_path")


@router.get("/models")
def list_models():
    return model_choices()


@router.post("/estimate")
def estimate(body: EstimateRequest, db: Session = Depends(get_db)):
    rs = db.get(RuleSet, body.rule_set_id)
    if not rs:
        raise HTTPException(404, "Rule set not found")
    sections = _get_sections(body.topic_tree_id, body.section_ids, db, body.topic_path)
    return estimate_cost(
        [{"content_text": s.content_text} for s in sections],
        rs.content,
        body.model,
    )


@router.post("/start", status_code=201)
def start_generation(
    body: StartRequest,
    background_tasks: BackgroundTasks,
    db: Session = Depends(get_db),
):
    rs = db.get(RuleSet, body.rule_set_id)
    if not rs:
        raise HTTPException(404, "Rule set not found")
    sections = _get_sections(body.topic_tree_id, body.section_ids, db, body.topic_path)

    cost_est = estimate_cost(
        [{"content_text": s.content_text} for s in sections],
        rs.content,
        body.model,
    )
    job = GenerationJob(
        topic_tree_id=body.topic_tree_id,
        scope="selected" if body.section_ids else "all",
        rule_set_id=body.rule_set_id,
        model=body.model,
        total_sections=len(sections),
        estimated_cost_usd=cost_est["estimated_cost_usd"],
    )
    db.add(job)
    db.commit()
    db.refresh(job)

    background_tasks.add_task(
        _run_generation,
        job.id,
        [s.id for s in sections],
        rs.content,
        body.model,
        body.replace_existing,
        body.card_version,
    )
    return {
        "job_id": job.id,
        "total_sections": job.total_sections,
        "estimated_cost_usd": job.estimated_cost_usd,
    }


@router.post("/supplemental/estimate")
def estimate_supplemental(body: SupplementalEstimateRequest, db: Session = Depends(get_db)):
    """Estimate cost for combined vignette + teaching case generation."""
    cards = db.query(Card).filter(Card.id.in_(body.card_ids)).all()
    groups = {}
    for c in cards:
        leaf = ((c.tags or c.tags_mapped) or [])[-1] if (c.tags or c.tags_mapped) else "Unassigned"
        groups.setdefault(leaf, []).append(c)
    rs = db.query(RuleSet).filter_by(rule_type='vignette', is_default=True).first()
    rules_text = rs.content if rs else ""
    est = estimate_supplemental_cost(groups, rules_text, body.model)
    est["card_count"] = len(cards)
    return est


@router.post("/supplemental/start")
def start_supplemental(body: SupplementalStartRequest, bg: BackgroundTasks, db: Session = Depends(get_db)):
    """Start combined vignette + teaching case generation, grouped by condition."""
    # Supplemental generation MUST use a vignette-type rule set. The frontend
    # sends the card-generation rule set id, which describes cloze cards, not
    # vignettes — using it produces generic output. Only honor the passed id if
    # it actually points to a vignette rule set; otherwise use the default one.
    rs = db.get(RuleSet, body.rule_set_id) if body.rule_set_id else None
    if not rs or rs.rule_type != "vignette":
        rs = db.query(RuleSet).filter_by(rule_type="vignette", is_default=True).first()
    if not rs:
        raise HTTPException(404, "No vignette rule set found — set one as default")
    if body.card_ids:
        cards = db.query(Card).filter(Card.id.in_(body.card_ids)).all()
    elif body.section_ids:
        cards = db.query(Card).filter(Card.section_id.in_(body.section_ids)).all()
    elif body.section_id:
        cards = db.query(Card).filter(Card.section_id == body.section_id).all()
    else:
        cards = []
    if not cards:
        raise HTTPException(400, "No cards found")

    # Mirror the runner's skip logic (_run_supplemental): when not replacing,
    # cards that already have both vignette + teaching case are skipped — count
    # groups/estimate over the same subset so totals match the actual work.
    if not body.replace_existing:
        cards = [c for c in cards if not (c.vignette and c.teaching_case)]
        if not cards:
            raise HTTPException(400, "All cards already have vignettes and teaching cases")

    groups = {}
    for c in cards:
        leaf = ((c.tags or c.tags_mapped) or [])[-1] if (c.tags or c.tags_mapped) else "Unassigned"
        groups.setdefault(leaf, []).append(c)

    est_cost = estimate_supplemental_cost(groups, rs.content, body.model)["estimated_cost_usd"]

    # Determine topic_tree_id from the first card's section
    first_card = cards[0]
    section = db.get(Section, first_card.section_id)
    tt_id = section.topic_tree_id if section else None

    job = GenerationJob(
        topic_tree_id=tt_id,
        job_type="supplemental",
        scope="selected",
        rule_set_id=rs.id,  # the resolved vignette rule actually used (valid FK)
        model=body.model,
        status=JobStatus.pending,
        total_sections=len(groups),
        processed_sections=0,
        total_cards=0,
        estimated_cost_usd=est_cost,
    )
    db.add(job)
    db.commit()
    db.refresh(job)

    bg.add_task(
        _run_supplemental,
        job.id,
        [c.id for c in cards],
        rs.content,
        body.model,
        body.replace_existing,
    )
    return {"job_id": job.id, "total_cards": len(cards), "condition_groups": len(groups), "estimated_cost_usd": est_cost}


@router.get("/jobs/active")
def get_active_jobs(db: Session = Depends(get_db)):
    """Return any running or pending jobs."""
    jobs = db.query(GenerationJob).filter(
        GenerationJob.status.in_([JobStatus.pending, JobStatus.running])
    ).all()
    return [
        {
            "id": job.id,
            "job_type": job.job_type,
            "topic_tree_id": job.topic_tree_id,
            "status": job.status,
            "total_sections": job.total_sections,
            "processed_sections": job.processed_sections,
            "total_cards": job.total_cards,
            "pipeline_step": job.pipeline_step,
        }
        for job in jobs
    ]


@router.get("/jobs/{job_id}")
def get_job(job_id: int, db: Session = Depends(get_db)):
    job = db.get(GenerationJob, job_id)
    if not job:
        raise HTTPException(404)
    return {
        "id": job.id,
        "job_type": job.job_type,
        "topic_tree_id": job.topic_tree_id,
        "status": job.status,
        "total_sections": job.total_sections,
        "processed_sections": job.processed_sections,
        "total_cards": job.total_cards,
        "estimated_cost_usd": job.estimated_cost_usd,
        "actual_input_tokens": job.actual_input_tokens,
        "actual_output_tokens": job.actual_output_tokens,
        "pipeline_step": job.pipeline_step,
        "error_message": job.error_message,
        "started_at": job.started_at.isoformat() if job.started_at else None,
        "finished_at": job.finished_at.isoformat() if job.finished_at else None,
    }


@router.post("/jobs/{job_id}/cancel")
def cancel_job(job_id: int, db: Session = Depends(get_db)):
    """Cancel a running or pending job by marking it as failed."""
    job = db.get(GenerationJob, job_id)
    if not job:
        raise HTTPException(404)
    if job.status not in (JobStatus.pending, JobStatus.running):
        return {"ok": True, "status": job.status}
    job.status = JobStatus.failed
    job.error_message = "Cancelled by user"
    job.finished_at = utcnow()
    db.commit()
    return {"ok": True, "status": "failed"}


def _fail_job(db, job_id: int, message: str):
    try:
        db.rollback()  # clear any aborted transaction state first
        job = db.get(GenerationJob, job_id)
        if job and job.status != JobStatus.failed:  # don't overwrite a user cancel
            job.status = JobStatus.failed
            job.error_message = message
            job.finished_at = utcnow()
            db.commit()
    except Exception:
        logger.exception("Failed to write error status for job %d", job_id)


def _job_cancelled(db, job_id: int) -> bool:
    """Check current job status straight from the DB (cancel comes from another session)."""
    status = db.query(GenerationJob.status).filter(GenerationJob.id == job_id).scalar()
    return status == JobStatus.failed


def _run_generation(
    job_id: int,
    section_ids: list[int],
    rules_text: str,
    model: str,
    replace_existing: bool = True,
    card_version: str = "base",
):
    """Background task: generate cards for each section, update job progress."""
    db = SessionLocal()
    try:
        job = db.get(GenerationJob, job_id)
        db.refresh(job)
        if job.status == JobStatus.failed:  # cancelled while pending
            return
        job.status = JobStatus.running
        job.started_at = utcnow()
        db.commit()

        client = anthropic.Anthropic(api_key=ANTHROPIC_API_KEY)
        total_cards = 0
        total_input_tokens = 0
        total_output_tokens = 0
        total_cache_write = 0
        total_cache_read = 0

        # Pre-load all sections in one query, curriculum versions in another
        sections = db.query(Section).filter(Section.id.in_(section_ids)).all()
        cur_ids = {s.curriculum_topic_id for s in sections if s.curriculum_topic_id}
        cur_versions = {}
        if cur_ids:
            for c in db.query(Curriculum).filter(Curriculum.id.in_(cur_ids)).all():
                cur_versions[c.id] = c.version

        sections_by_id = {}
        for section in sections:
            sections_by_id[section.id] = {
                "id": section.id,
                "content_text": section.content_text,
                "content_html": section.content_html,
                "content_source": section.content_source,
                "heading": section.heading,
                "heading_tree": section.heading_tree,
                "curriculum_topic_path": section.curriculum_topic_path,
                "topic_tree_id": section.topic_tree_id,
                "curriculum_version": (
                    cur_versions.get(section.curriculum_topic_id)
                    if section.curriculum_topic_path and section.curriculum_topic_id
                    else None
                ),
            }

        # Seed past any existing note_id so two minters started in the same ms
        # (or a clock that ran ahead) can't collide with already-stored ids.
        note_id_base = max(
            int(time.time() * 1000),
            (db.query(func.max(Card.note_id)).scalar() or 0) + 1,
        )
        note_id_counter = {"value": 0}
        note_id_lock = threading.Lock()

        def next_note_id():
            with note_id_lock:
                nid = note_id_base + note_id_counter["value"]
                note_id_counter["value"] += 1
                return nid

        # For base version with replace_existing: old cards are deleted per-section
        # only AFTER that section's generation succeeded (see the base success path
        # below) — a failed section keeps its previous cards.
        # For v1/v2/v3: never delete cards — only update the version column on existing ones

        # Pre-load existing base cards per section (ordered) so v1/v2/v3 runs can
        # attach onto them by position — they are alternate phrasings, 1:1 with base.
        existing_cards_by_section: dict[int, list[Card]] = {}
        if card_version != "base":
            for section_id in sections_by_id:
                existing_cards_by_section[section_id] = (
                    db.query(Card).filter(Card.section_id == section_id).order_by(Card.card_number).all()
                )

        # Map version string to its column names
        version_field = {
            "v1": "front_html_v1",
            "v2": "front_html_v2",
            "v3": "front_html_v3",
        }.get(card_version)
        extra_field = {
            "v1": "extra_v1",
            "v2": "extra_v2",
            "v3": "extra_v3",
        }.get(card_version)
        version_score_fields = {
            "v1": ("accuracy_score_v1", "accuracy_note_v1", "eor_yield_v1"),
            "v2": ("accuracy_score_v2", "accuracy_note_v2", "eor_yield_v2"),
            "v3": ("accuracy_score_v3", "accuracy_note_v3", "eor_yield_v3"),
        }.get(card_version)

        def process_section(section_data):
            for attempt in range(4):
                try:
                    cards_data, needs_review, usage = generate_cards_for_section(
                        section_data,
                        rules_text,
                        model,
                    )
                    return section_data, cards_data, needs_review, usage
                except RETRYABLE_ERRORS as e:
                    heading = section_data.get("heading", f"id {section_data['id']}")
                    detail = str(e) or type(e).__name__
                    overloaded = (
                        "503" in detail
                        or "high demand" in detail.lower()
                        or "overloaded" in detail.lower()
                    )
                    what = "model overloaded (503, server busy)" if overloaded else type(e).__name__
                    if attempt == 3:
                        logger.error(
                            "❌ Section '%s' FAILED after 4 attempts — %s on model '%s'. Detail: %s",
                            heading, what, model, detail[:300],
                        )
                        raise
                    # Short backoff (5/10/20s). The Gemini SDK's own internal
                    # retry is disabled (see llm._google_client), so each attempt
                    # fails fast and these waits are the only delay — an overloaded
                    # model surfaces in ~35s with clear logs instead of hanging.
                    wait = 5 * (2 ** attempt)
                    logger.warning(
                        "⏳ Section '%s' — %s on model '%s'. Retrying in %ds (attempt %d/4)…",
                        heading, what, model, wait, attempt + 1,
                    )
                    time.sleep(wait)

        failed_sections: list[str] = []
        version_warnings: list[str] = []
        scoring_failures = 0
        cancelled = False

        # Per-section token tally so cost can be attributed to each section.
        per_section_usage: dict[int, dict] = {}
        # Scoring always runs on the Anthropic model — accumulate it separately so
        # it's logged at Anthropic rates, not the raw generation model's (Gemini).
        scoring_usage = {"input": 0, "output": 0, "cw": 0, "cr": 0}

        def _acc_scoring(u):
            scoring_usage["input"] += u.get("input_tokens", 0)
            scoring_usage["output"] += u.get("output_tokens", 0)
            scoring_usage["cw"] += u.get("cache_creation_input_tokens", 0)
            scoring_usage["cr"] += u.get("cache_read_input_tokens", 0)

        def _acc_section(sid, u):
            d = per_section_usage.setdefault(sid, {"input": 0, "output": 0, "cw": 0, "cr": 0})
            d["input"] += u.get("input_tokens", 0)
            d["output"] += u.get("output_tokens", 0)
            d["cw"] += u.get("cache_creation_input_tokens", 0)
            d["cr"] += u.get("cache_read_input_tokens", 0)

        with ThreadPoolExecutor(max_workers=3) as executor:
            futures = {executor.submit(process_section, s): s for s in sections_by_id.values()}
            for future in as_completed(futures):
                submitted_section = futures[future]

                if _job_cancelled(db, job_id):
                    logger.info("Job %d cancelled by user — stopping remaining sections", job_id)
                    executor.shutdown(wait=False, cancel_futures=True)
                    cancelled = True
                    break

                try:
                    section_data, cards_data, needs_review, usage = future.result()
                except (anthropic.AuthenticationError, anthropic.PermissionDeniedError):
                    # Fatal for every section — stop the whole job with a friendly message
                    executor.shutdown(wait=False, cancel_futures=True)
                    raise
                except Exception as e:
                    heading = submitted_section.get("heading", f"id {submitted_section['id']}")
                    detail = str(e) or type(e).__name__
                    if "503" in detail or "high demand" in detail.lower() or "overloaded" in detail.lower():
                        reason = "model overloaded (503) — Google returned high-demand on every retry"
                    else:
                        reason = f"{type(e).__name__}: {detail[:120]}"
                    logger.exception("❌ Section '%s' failed — %s", heading, reason)
                    failed_sections.append(f"{heading} — {reason}")
                    job.processed_sections += 1
                    db.commit()
                    continue

                tags = section_data["curriculum_topic_path"].split(" > ") if section_data.get("curriculum_topic_path") else []
                cv = section_data.get("curriculum_version")
                created_cards: list[Card] = []
                version_cards: list[tuple] = []  # (base card, version front_text) for v1/v2/v3 scoring

                if card_version == "base":
                    if replace_existing:
                        # Generation for this section succeeded — now it's safe to
                        # replace its old cards (same transaction as the inserts).
                        db.query(Card).filter(Card.section_id == section_data["id"]).delete(
                            synchronize_session=False
                        )
                    # Create new card rows
                    for card_data in cards_data:
                        card_kwargs = dict(
                            section_id=section_data["id"],
                            card_number=card_data["card_number"],
                            front_html=card_data["front_html"],
                            front_text=card_data["front_text"],
                            extra=card_data.get("extra"),
                            source_ref=card_data.get("source_ref"),
                            needs_review=needs_review or card_data.get("needs_review", False),
                            note_id=next_note_id(),
                        )
                        if cv == "v1":
                            card_kwargs["tags_mapped"] = tags
                            card_kwargs["tags"] = []
                        else:
                            card_kwargs["tags"] = tags
                        card = Card(**card_kwargs)
                        db.add(card)
                        created_cards.append(card)
                    total_cards += len(cards_data)
                else:
                    # Attach this run's output onto the existing base cards BY ORDER
                    # (v1/v2/v3 are alternate phrasings of the base set, 1:1). We fill the
                    # version's front + extra columns; nothing is created or deleted.
                    existing_list = existing_cards_by_section.get(section_data["id"], [])
                    if not existing_list:
                        failed_sections.append(
                            f"{section_data.get('heading', '?')} — no base cards to attach {card_version} to; generate base first"
                        )
                    else:
                        n = min(len(existing_list), len(cards_data))
                        for i in range(n):
                            matched = existing_list[i]
                            card_data = cards_data[i]
                            if version_field:
                                setattr(matched, version_field, card_data["front_html"])
                            if extra_field:
                                setattr(matched, extra_field, card_data.get("extra"))
                            version_cards.append((matched, card_data["front_text"]))
                        total_cards += n
                        # Overflow: AI produced more cards than base has — create new rows
                        # with only the version column filled (no base/other versions).
                        overflow_data = cards_data[n:]
                        if overflow_data:
                            max_num = max((c.card_number for c in existing_list), default=0)
                            for j, card_data in enumerate(overflow_data):
                                overflow_kwargs = dict(
                                    section_id=section_data["id"],
                                    card_number=max_num + j + 1,
                                    front_html="",  # base empty (NOT NULL) — version-only card
                                    front_text=card_data.get("front_text", ""),
                                    status=CardStatus.active,
                                    needs_review=True,
                                    note_id=next_note_id(),
                                )
                                # Route tags by curriculum version, like the base path.
                                if cv == "v1":
                                    overflow_kwargs["tags_mapped"] = tags
                                    overflow_kwargs["tags"] = []
                                else:
                                    overflow_kwargs["tags"] = tags
                                new_card = Card(**overflow_kwargs)
                                if version_field:
                                    setattr(new_card, version_field, card_data["front_html"])
                                if extra_field:
                                    setattr(new_card, extra_field, card_data.get("extra"))
                                db.add(new_card)
                                db.flush()
                                version_cards.append((new_card, card_data.get("front_text", "")))
                            total_cards += len(overflow_data)
                        # Only warn when version produced FEWER cards (some base cards left uncovered)
                        if len(cards_data) < len(existing_list):
                            version_warnings.append(
                                f"{section_data.get('heading', '?')}: {card_version} produced {len(cards_data)} card(s) "
                                f"but base has {len(existing_list)} — {len(existing_list) - len(cards_data)} base card(s) have no {card_version}"
                            )

                total_input_tokens += usage["input_tokens"]
                total_output_tokens += usage["output_tokens"]
                total_cache_write += usage.get("cache_creation_input_tokens", 0)
                total_cache_read += usage.get("cache_read_input_tokens", 0)
                _acc_section(section_data["id"], usage)
                db.commit()

                # Score the cards created in this run (base generation only —
                # v1/v2/v3 runs don't change the base content the score is based on)
                if created_cards:
                    try:
                        cards_for_scoring = [
                            {"id": c.id, "front_text": c.front_text, "extra": c.extra}
                            for c in created_cards
                        ]
                        scores, score_usage = score_cards(
                            client,
                            cards_for_scoring,
                            section_data.get("curriculum_topic_path", ""),
                            anthropic_model(model),
                        )
                        cards_by_id = {c.id: c for c in created_cards}
                        for score in scores:
                            card = cards_by_id.get(score.get("card_id"))
                            if card:
                                card.accuracy_score = score.get("accuracy")
                                card.accuracy_note = score.get("accuracy_note")
                                card.eor_yield = score.get("eor_yield")
                        total_input_tokens += score_usage.get("input_tokens", 0)
                        total_output_tokens += score_usage.get("output_tokens", 0)
                        total_cache_write += score_usage.get("cache_creation_input_tokens", 0)
                        total_cache_read += score_usage.get("cache_read_input_tokens", 0)
                        _acc_scoring(score_usage)
                        db.commit()
                    except Exception:
                        logger.exception("Error scoring cards for section %d", section_data["id"])
                        scoring_failures += 1

                # Score the version cards we just filled, into that version's score columns
                if version_cards and version_score_fields:
                    try:
                        fa, fn, fe = version_score_fields
                        cards_for_scoring = [
                            {"id": c.id, "front_text": ft, "extra": getattr(c, extra_field, None) if extra_field else None}
                            for (c, ft) in version_cards
                        ]
                        scores, score_usage = score_cards(
                            client,
                            cards_for_scoring,
                            section_data.get("curriculum_topic_path", ""),
                            anthropic_model(model),
                        )
                        cards_by_id = {c.id: c for (c, _) in version_cards}
                        for score in scores:
                            card = cards_by_id.get(score.get("card_id"))
                            if card:
                                setattr(card, fa, score.get("accuracy"))
                                setattr(card, fn, score.get("accuracy_note"))
                                setattr(card, fe, score.get("eor_yield"))
                        total_input_tokens += score_usage.get("input_tokens", 0)
                        total_output_tokens += score_usage.get("output_tokens", 0)
                        total_cache_write += score_usage.get("cache_creation_input_tokens", 0)
                        total_cache_read += score_usage.get("cache_read_input_tokens", 0)
                        _acc_scoring(score_usage)
                        db.commit()
                    except Exception:
                        logger.exception("Error scoring %s cards for section %d", card_version, section_data["id"])
                        scoring_failures += 1

                job.processed_sections += 1
                db.commit()

        topic_tree_id = next(iter(sections_by_id.values()), {}).get("topic_tree_id")
        # One usage row per section (generation + its scoring) so cost is attributable per section.
        for sid, u in per_section_usage.items():
            if u["input"] or u["output"]:
                db.add(AIUsageLog(
                    operation="card_generation",
                    model=model,
                    input_tokens=u["input"],
                    output_tokens=u["output"],
                    cache_write_tokens=u["cw"],
                    cache_read_tokens=u["cr"],
                    cost_usd=compute_cost(model, u["input"], u["output"], u["cw"], u["cr"]),
                    topic_tree_id=topic_tree_id,
                    section_id=sid,
                    job_id=job_id,
                ))
        # One row for all scoring in this job, at the scoring model's (Anthropic)
        # rates — scoring tokens must not be priced as the raw generation model.
        if scoring_usage["input"] or scoring_usage["output"]:
            score_model = anthropic_model(model)
            db.add(AIUsageLog(
                operation="card_scoring",
                model=score_model,
                input_tokens=scoring_usage["input"],
                output_tokens=scoring_usage["output"],
                cache_write_tokens=scoring_usage["cw"],
                cache_read_tokens=scoring_usage["cr"],
                cost_usd=compute_cost(
                    score_model, scoring_usage["input"], scoring_usage["output"],
                    scoring_usage["cw"], scoring_usage["cr"],
                ),
                topic_tree_id=topic_tree_id,
                job_id=job_id,
            ))
        if cancelled:
            db.commit()  # keep the usage log; status stays cancelled
            return

        # Surface partial failures; fail outright only if nothing succeeded
        warnings = []
        if failed_sections:
            warnings.append(f"{len(failed_sections)} section(s) failed: {', '.join(failed_sections[:5])}")
        if version_warnings:
            warnings.append("; ".join(version_warnings[:5]))
        if scoring_failures:
            warnings.append(f"scoring failed for {scoring_failures} section(s)")

        if _job_cancelled(db, job_id):
            db.commit()  # keep the usage log; leave status as cancelled/failed
            return
        if failed_sections and len(failed_sections) == len(sections_by_id):
            job.status = JobStatus.failed
            job.error_message = warnings[0]
        else:
            job.status = JobStatus.done
            job.error_message = "; ".join(warnings) if warnings else None
        job.total_cards = total_cards
        job.actual_input_tokens = total_input_tokens
        job.actual_output_tokens = total_output_tokens
        job.finished_at = utcnow()
        db.commit()

    except anthropic.AuthenticationError:
        _fail_job(db, job_id, "Anthropic API key is invalid or missing. Check your ANTHROPIC_API_KEY.")
    except anthropic.PermissionDeniedError as e:
        msg = str(e).lower()
        if "credit" in msg or "billing" in msg or "balance" in msg or "quota" in msg:
            _fail_job(db, job_id, "Your Anthropic account is out of credits. Please top up your balance and try again.")
        else:
            _fail_job(db, job_id, f"Anthropic permission error: {e}")
    except anthropic.RateLimitError:
        _fail_job(db, job_id, "Anthropic rate limit reached. Please wait a moment and try again.")
    except anthropic.APIStatusError as e:
        msg = str(e).lower()
        if "credit" in msg or "billing" in msg or "balance" in msg:
            _fail_job(db, job_id, "Your Anthropic account is out of credits. Please top up your balance and try again.")
        else:
            _fail_job(db, job_id, f"Anthropic API error ({e.status_code}): {e.message}")
    except Exception as e:
        logger.exception("_run_generation failed")
        _fail_job(db, job_id, str(e))
    finally:
        db.close()


def _run_supplemental(
    job_id: int,
    card_ids: list[int],
    rules_text: str,
    model: str,
    replace_existing: bool,
):
    """Background task: generate vignette + teaching case per condition group."""
    from backend.services.supplemental_generator import generate_supplemental_for_group

    db = SessionLocal()
    try:
        job = db.get(GenerationJob, job_id)
        db.refresh(job)
        if job.status == JobStatus.failed:  # cancelled while pending
            return
        job.status = JobStatus.running
        job.started_at = utcnow()
        db.commit()

        client = anthropic.Anthropic(api_key=ANTHROPIC_API_KEY)
        cards = db.query(Card).filter(Card.id.in_(card_ids)).all()

        condition_groups = {}
        group_paths = {}  # leaf -> full tag path ("Neurology > Headache Disorders > Headaches")
        for c in cards:
            if not replace_existing and c.vignette and c.teaching_case:
                continue
            path = (c.tags or c.tags_mapped) or []
            leaf = path[-1] if path else "Unassigned"
            condition_groups.setdefault(leaf, []).append({
                "id": c.id,
                "card_number": c.card_number,
                "front_text": c.front_text,
            })
            if leaf not in group_paths:
                group_paths[leaf] = " > ".join(path) if path else "Unassigned"

        card_section = {c.id: c.section_id for c in cards}  # attribute cost per section
        per_section_usage: dict[int, dict] = {}

        def _acc_section(sid, u):
            d = per_section_usage.setdefault(sid, {"input": 0, "output": 0, "cw": 0, "cr": 0})
            d["input"] += u.get("input_tokens", 0)
            d["output"] += u.get("output_tokens", 0)
            d["cw"] += u.get("cache_creation_input_tokens", 0)
            d["cr"] += u.get("cache_read_input_tokens", 0)

        total_input = 0
        total_output = 0
        total_cache_write = 0
        total_cache_read = 0
        processed_groups = 0
        total_cards_updated = 0

        def generate_with_retry(condition, group_cards):
            topic_path = group_paths.get(condition, condition)
            for attempt in range(4):
                try:
                    return generate_supplemental_for_group(
                        client, topic_path, group_cards, rules_text, anthropic_model(model)
                    )
                except RETRYABLE_ERRORS as e:
                    if attempt == 3:
                        raise
                    wait = 20 * (2 ** attempt)
                    logger.warning("Retryable API error on supplemental '%s' (%s), retrying in %ds", condition, type(e).__name__, wait)
                    time.sleep(wait)

        failed_groups: list[str] = []
        cancelled = False

        with ThreadPoolExecutor(max_workers=3) as executor:
            futures = {
                executor.submit(generate_with_retry, condition, group_cards): (condition, group_cards)
                for condition, group_cards in condition_groups.items()
            }
            for future in as_completed(futures):
                condition, group_cards = futures[future]

                if _job_cancelled(db, job_id):
                    logger.info("Supplemental job %d cancelled by user", job_id)
                    executor.shutdown(wait=False, cancel_futures=True)
                    cancelled = True
                    break

                try:
                    condition_results, usage = future.result()
                except (anthropic.AuthenticationError, anthropic.PermissionDeniedError):
                    executor.shutdown(wait=False, cancel_futures=True)
                    raise
                except Exception:
                    logger.exception("Error generating supplemental for condition '%s'", condition)
                    failed_groups.append(condition)
                    processed_groups += 1
                    job.processed_sections = processed_groups
                    db.commit()
                    continue

                # Update each condition's cards with their specific vignette/teaching case
                # (card_ids already validated against the sent group by the generator)
                for cr in condition_results:
                    cr_ids = cr.get("card_ids", [])
                    if cr_ids:
                        total_cards_updated += db.query(Card).filter(Card.id.in_(cr_ids)).update(
                            {"vignette": cr.get("vignette", ""), "teaching_case": cr.get("teaching_case", "")},
                            synchronize_session="fetch",
                        )
                total_input += usage.get("input_tokens", 0)
                total_output += usage.get("output_tokens", 0)
                total_cache_write += usage.get("cache_creation_input_tokens", 0)
                total_cache_read += usage.get("cache_read_input_tokens", 0)
                sid = card_section.get(group_cards[0]["id"]) if group_cards else None
                if sid:
                    _acc_section(sid, usage)
                processed_groups += 1
                job.processed_sections = processed_groups
                db.commit()

        for sid, u in per_section_usage.items():
            if u["input"] or u["output"]:
                db.add(AIUsageLog(
                    operation="supplemental_generation",
                    model=anthropic_model(model),
                    input_tokens=u["input"],
                    output_tokens=u["output"],
                    cache_write_tokens=u["cw"],
                    cache_read_tokens=u["cr"],
                    cost_usd=compute_cost(anthropic_model(model), u["input"], u["output"], u["cw"], u["cr"]),
                    section_id=sid,
                    job_id=job_id,
                ))
        if cancelled:
            db.commit()
            return

        if _job_cancelled(db, job_id):
            db.commit()
            return
        if failed_groups and len(failed_groups) == len(condition_groups):
            job.status = JobStatus.failed
            job.error_message = f"All {len(failed_groups)} condition group(s) failed"
        else:
            job.status = JobStatus.done
            job.error_message = (
                f"{len(failed_groups)} of {len(condition_groups)} condition group(s) failed: "
                f"{', '.join(failed_groups[:5])}"
            ) if failed_groups else None
        job.actual_input_tokens = total_input
        job.actual_output_tokens = total_output
        job.total_cards = total_cards_updated
        job.finished_at = utcnow()
        db.commit()

    except anthropic.AuthenticationError:
        _fail_job(db, job_id, "Anthropic API key is invalid or missing.")
    except anthropic.PermissionDeniedError as e:
        msg = str(e).lower()
        if "credit" in msg or "billing" in msg or "balance" in msg or "quota" in msg:
            _fail_job(db, job_id, "Your Anthropic account is out of credits.")
        else:
            _fail_job(db, job_id, f"Anthropic permission error: {e}")
    except anthropic.RateLimitError:
        _fail_job(db, job_id, "Anthropic rate limit reached.")
    except anthropic.APIStatusError as e:
        msg = str(e).lower()
        if "credit" in msg or "billing" in msg or "balance" in msg:
            _fail_job(db, job_id, "Your Anthropic account is out of credits.")
        else:
            _fail_job(db, job_id, f"Anthropic API error ({e.status_code}): {e.message}")
    except Exception as e:
        logger.exception("_run_supplemental failed")
        _fail_job(db, job_id, str(e))
    finally:
        db.close()
