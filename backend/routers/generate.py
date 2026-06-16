import logging
import threading
import time
from concurrent.futures import ThreadPoolExecutor, as_completed
from fastapi import APIRouter, Depends, HTTPException, BackgroundTasks
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
from backend.config import resolve_model, effort_kwargs
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
    rule_set_id: int
    model: str = DEFAULT_MODEL


class StartRequest(BaseModel):
    topic_tree_id: Optional[int] = None
    section_ids: Optional[list[int]] = None
    rule_set_id: int
    model: str = DEFAULT_MODEL
    replace_existing: bool = True


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

    client = anthropic.Anthropic(api_key=ANTHROPIC_API_KEY)
    response = client.messages.create(
        model=resolve_model(body.model)[0],
        **effort_kwargs(body.model),
        max_tokens=16384,
        temperature=0,
        system=[{"type": "text", "text": system_text, "cache_control": {"type": "ephemeral"}}],
        messages=[{"role": "user", "content": user_text}],
    )
    raw = response_text(response)
    usage = usage_dict(response)
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
        "stop_reason": response.stop_reason,
        "usage": usage,
        "cost_usd": cost,
    }


def _get_sections(topic_tree_id: Optional[int], section_ids: Optional[list[int]], db: Session) -> list[Section]:
    if section_ids:
        sections = db.query(Section).filter(Section.id.in_(section_ids)).all()
        if len(sections) != len(section_ids):
            raise HTTPException(422, "Some section_ids not found")
        return sections
    if topic_tree_id:
        tt = db.get(TopicTree, topic_tree_id)
        if not tt:
            raise HTTPException(404, "Topic tree not found")
        return db.query(Section).filter_by(topic_tree_id=topic_tree_id).all()
    raise HTTPException(400, "Provide topic_tree_id or section_ids")


@router.get("/models")
def list_models():
    return model_choices()


@router.post("/estimate")
def estimate(body: EstimateRequest, db: Session = Depends(get_db)):
    rs = db.get(RuleSet, body.rule_set_id)
    if not rs:
        raise HTTPException(404, "Rule set not found")
    sections = _get_sections(body.topic_tree_id, body.section_ids, db)
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
    sections = _get_sections(body.topic_tree_id, body.section_ids, db)

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
        rs.card_version,
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

        note_id_base = int(time.time() * 1000)
        note_id_counter = {"value": 0}
        note_id_lock = threading.Lock()

        def next_note_id():
            with note_id_lock:
                nid = note_id_base + note_id_counter["value"]
                note_id_counter["value"] += 1
                return nid

        # For base version: optionally delete and recreate cards
        # For v1/v2/v3: never delete cards — only update the version column on existing ones
        if card_version == "base" and replace_existing:
            for section_id in sections_by_id:
                db.query(Card).filter(Card.section_id == section_id).delete()
            db.commit()

        # Pre-load existing cards by section for version matching (v1/v2/v3)
        existing_cards_by_section: dict[int, dict[int, Card]] = {}
        if card_version != "base":
            for section_id in sections_by_id:
                cards_in_section = db.query(Card).filter(Card.section_id == section_id).order_by(Card.card_number).all()
                existing_cards_by_section[section_id] = {c.card_number: c for c in cards_in_section}

        # Map version string to column name
        version_field = {
            "v1": "front_html_v1",
            "v2": "front_html_v2",
            "v3": "front_html_v3",
        }.get(card_version)

        def process_section(section_data):
            for attempt in range(4):
                try:
                    cards_data, needs_review, usage = generate_cards_for_section(
                        client,
                        section_data,
                        rules_text,
                        model,
                    )
                    return section_data, cards_data, needs_review, usage
                except RETRYABLE_ERRORS as e:
                    if attempt == 3:
                        raise
                    wait = 20 * (2 ** attempt)
                    logger.warning(
                        "Retryable API error on section %d (%s), retrying in %ds (attempt %d/4)",
                        section_data["id"], type(e).__name__, wait, attempt + 1,
                    )
                    time.sleep(wait)

        failed_sections: list[str] = []
        scoring_failures = 0
        cancelled = False

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
                except Exception:
                    logger.exception("Section '%s' failed", submitted_section.get("heading", "?"))
                    failed_sections.append(submitted_section.get("heading", f"id {submitted_section['id']}"))
                    job.processed_sections += 1
                    db.commit()
                    continue

                tags = section_data["curriculum_topic_path"].split(" > ") if section_data.get("curriculum_topic_path") else []
                cv = section_data.get("curriculum_version")
                created_cards: list[Card] = []

                if card_version == "base":
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
                    # Update version column on existing cards matched by card_number
                    existing = existing_cards_by_section.get(section_data["id"], {})
                    updated = 0
                    for card_data in cards_data:
                        matched = existing.get(card_data["card_number"])
                        if matched and version_field:
                            setattr(matched, version_field, card_data["front_html"])
                            updated += 1
                    total_cards += updated

                total_input_tokens += usage["input_tokens"]
                total_output_tokens += usage["output_tokens"]
                total_cache_write += usage.get("cache_creation_input_tokens", 0)
                total_cache_read += usage.get("cache_read_input_tokens", 0)
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
                            model,
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
                        db.commit()
                    except Exception:
                        logger.exception("Error scoring cards for section %d", section_data["id"])
                        scoring_failures += 1

                job.processed_sections += 1
                db.commit()

        topic_tree_id = next(iter(sections_by_id.values()), {}).get("topic_tree_id")
        if total_input_tokens or total_output_tokens:
            db.add(AIUsageLog(
                operation="card_generation",
                model=model,
                input_tokens=total_input_tokens,
                output_tokens=total_output_tokens,
                cache_write_tokens=total_cache_write,
                cache_read_tokens=total_cache_read,
                cost_usd=compute_cost(model, total_input_tokens, total_output_tokens, total_cache_write, total_cache_read),
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
                    return generate_supplemental_for_group(client, topic_path, group_cards, rules_text, model)
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
                processed_groups += 1
                job.processed_sections = processed_groups
                db.commit()

        if total_input or total_output:
            db.add(AIUsageLog(
                operation="supplemental_generation",
                model=model,
                input_tokens=total_input,
                output_tokens=total_output,
                cache_write_tokens=total_cache_write,
                cache_read_tokens=total_cache_read,
                cost_usd=compute_cost(model, total_input, total_output, total_cache_write, total_cache_read),
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
