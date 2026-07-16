"""Step-by-Step card generation router — fully isolated from /api/generate and
/api/rules. Own rule sets (sbs_rule_sets), own jobs (sbs_jobs). Produces normal
Card rows in the chosen version so the output lands in the same card table."""
import time
import logging
import threading

from fastapi import APIRouter, Depends, HTTPException, BackgroundTasks
from pydantic import BaseModel
from typing import Optional, Any
from sqlalchemy import func

from backend.db import get_db, SessionLocal
from backend.models import SbsRuleSet, SbsJob, Section, Card, Curriculum, utcnow
from backend.config import DEFAULT_MODEL
from backend.services.sbs_generator import (
    generate_sbs, build_phase_system, split_prompt_into_sections,
)
from sqlalchemy.orm import Session

logger = logging.getLogger(__name__)
router = APIRouter()


# ── Rule sets ─────────────────────────────────────────────────────────────────
class SbsRuleUpdate(BaseModel):
    name: Optional[str] = None
    sections: Optional[Any] = None
    is_default: Optional[bool] = None


class SbsRuleCreate(BaseModel):
    name: str
    sections: Any = []


def _rule_dict(r: SbsRuleSet) -> dict:
    return {"id": r.id, "name": r.name, "sections": r.sections or [], "is_default": r.is_default}


@router.get("/rules")
def list_rules(db: Session = Depends(get_db)):
    return [_rule_dict(r) for r in db.query(SbsRuleSet).order_by(SbsRuleSet.created_at).all()]


@router.post("/rules")
def create_rule(body: SbsRuleCreate, db: Session = Depends(get_db)):
    r = SbsRuleSet(name=body.name, sections=body.sections or [])
    db.add(r); db.commit(); db.refresh(r)
    return _rule_dict(r)


@router.patch("/rules/{rule_id}")
def update_rule(rule_id: int, body: SbsRuleUpdate, db: Session = Depends(get_db)):
    r = db.get(SbsRuleSet, rule_id)
    if not r:
        raise HTTPException(404)
    if body.name is not None:
        r.name = body.name
    if body.sections is not None:
        r.sections = body.sections
    if body.is_default is not None and body.is_default:
        for other in db.query(SbsRuleSet).filter(SbsRuleSet.id != rule_id).all():
            other.is_default = False
        r.is_default = True
    db.commit(); db.refresh(r)
    return _rule_dict(r)


@router.delete("/rules/{rule_id}", status_code=204)
def delete_rule(rule_id: int, db: Session = Depends(get_db)):
    r = db.get(SbsRuleSet, rule_id)
    if r:
        db.delete(r); db.commit()


# ── Preview (what each phase will send) ───────────────────────────────────────
class PreviewReq(BaseModel):
    section_id: int
    sbs_rule_set_id: int


@router.post("/preview")
def preview(body: PreviewReq, db: Session = Depends(get_db)):
    section = db.get(Section, body.section_id)
    if not section:
        raise HTTPException(404, "Section not found")
    rule = db.get(SbsRuleSet, body.sbs_rule_set_id)
    if not rule:
        raise HTTPException(404, "SBS rule set not found")
    from backend.services.generator import _render_source_text
    sections = rule.sections or []
    section_data = {
        "id": section.id, "heading": section.heading,
        "content_source": section.content_source, "content_html": section.content_html,
        "content_text": section.content_text,
        "curriculum_topic_path": section.curriculum_topic_path,
    }
    return {
        "section_heading": section.heading,
        "source": _render_source_text(section_data),
        "phases": [
            {"phase": "segment", "system": build_phase_system(sections, "segment")},
            {"phase": "author", "system": build_phase_system(sections, "author")},
        ],
        "sections": sections,
    }


# ── Start / poll ──────────────────────────────────────────────────────────────
class StartReq(BaseModel):
    section_id: int
    sbs_rule_set_id: int
    card_version: str = "base"
    model: str = DEFAULT_MODEL


def _job_dict(j: SbsJob) -> dict:
    return {
        "id": j.id, "section_id": j.section_id, "status": j.status, "phase": j.phase,
        "total_cards": j.total_cards, "error_message": j.error_message,
        "card_version": j.card_version, "plan": j.plan,
    }


@router.post("/start")
def start(body: StartReq, background_tasks: BackgroundTasks, db: Session = Depends(get_db)):
    section = db.get(Section, body.section_id)
    if not section:
        raise HTTPException(404, "Section not found")
    if not db.get(SbsRuleSet, body.sbs_rule_set_id):
        raise HTTPException(404, "SBS rule set not found")
    job = SbsJob(
        section_id=body.section_id, sbs_rule_set_id=body.sbs_rule_set_id,
        card_version=body.card_version, model=body.model, status="pending", phase="segment",
    )
    db.add(job); db.commit(); db.refresh(job)
    background_tasks.add_task(_run_sbs_job, job.id)
    return _job_dict(job)


@router.get("/jobs/{job_id}")
def get_job(job_id: int, db: Session = Depends(get_db)):
    j = db.get(SbsJob, job_id)
    if not j:
        raise HTTPException(404)
    return _job_dict(j)


@router.get("/jobs/{job_id}/report")
def download_report(job_id: int, db: Session = Depends(get_db)):
    """Download a self-contained Markdown audit of the run (prompt/input/output per
    step) named '<section> SBS.md' — plug it into an AI to review the work."""
    from fastapi.responses import Response
    from backend.services.sbs_generator import build_report_md
    import re as _re

    j = db.get(SbsJob, job_id)
    if not j:
        raise HTTPException(404)
    if not j.trace:
        raise HTTPException(400, "No trace yet — the job hasn't finished the AI steps.")
    section = db.get(Section, j.section_id)
    heading = section.heading if section else f"section-{j.section_id}"
    final_cards = (j.trace[-1].get("output") if j.trace else []) or []
    md = build_report_md(heading, j.model, j.trace, final_cards)
    safe = _re.sub(r"[^\w\- ]", "_", heading).strip()[:80] or "section"
    return Response(
        content=md,
        media_type="text/markdown",
        headers={"Content-Disposition": f'attachment; filename="{safe} SBS.md"'},
    )


def _run_sbs_job(job_id: int):
    db = SessionLocal()
    try:
        job = db.get(SbsJob, job_id)
        if not job:
            return
        job.status = "running"; db.commit()
        section = db.get(Section, job.section_id)
        rule = db.get(SbsRuleSet, job.sbs_rule_set_id)
        if not section or not rule:
            job.status = "failed"; job.error_message = "Section or rule set missing"; db.commit(); return

        cur_version = None
        if section.curriculum_topic_id:
            c = db.get(Curriculum, section.curriculum_topic_id)
            cur_version = c.version if c else None

        section_data = {
            "id": section.id, "heading": section.heading,
            "content_source": section.content_source, "content_html": section.content_html,
            "content_text": section.content_text,
            "curriculum_topic_path": section.curriculum_topic_path,
            "curriculum_version": cur_version,
        }

        cards, plan, _usage, traces = generate_sbs(section_data, rule.sections or [], job.model)
        job.plan = plan; job.trace = traces; job.phase = "assemble"; db.commit()

        _persist_cards(db, section, cards, job.card_version, cur_version)

        job.total_cards = len(cards)
        job.status = "done"; job.phase = "done"; job.finished_at = utcnow()
        db.commit()
    except Exception as e:
        logger.exception("SBS job %d failed", job_id)
        try:
            job = db.get(SbsJob, job_id)
            if job:
                job.status = "failed"
                job.error_message = f"{type(e).__name__}: {e}"[:500]
                db.commit()
        except Exception:
            pass
    finally:
        db.close()


def _persist_cards(db: Session, section: Section, cards: list[dict], card_version: str, cur_version):
    """Write the assembled cards into the chosen version, mirroring the single-shot
    flow's tag routing and note_id seeding. Base creates rows; v1/v2/v3 fill the
    version columns on existing base cards by order."""
    tags = section.curriculum_topic_path.split(" > ") if section.curriculum_topic_path else []
    note_id_base = max(int(time.time() * 1000), (db.query(func.max(Card.note_id)).scalar() or 0) + 1)

    if card_version == "base":
        created: list[Card] = []
        for i, c in enumerate(cards):
            kwargs = dict(
                section_id=section.id, card_number=c["card_number"],
                front_html=c["front_html"], front_text=c["front_text"],
                extra=c.get("extra"), source_ref=c.get("source_ref"),
                needs_review=c.get("needs_review", False), note_id=note_id_base + i,
            )
            if cur_version == "v1":
                kwargs["tags_mapped"] = tags; kwargs["tags"] = []
            else:
                kwargs["tags"] = tags
            new = Card(**kwargs)
            db.add(new)
            created.append(new)
        db.commit()
        # Silent capture (best-effort, never raises). Shared by SBS + Verify.
        try:
            from backend.services import capture
            capture.record_generation(db, section.id, None, None, card_version, created)
        except Exception:
            logger.exception("capture.record_generation hook failed (swallowed)")
        return

    # v1/v2/v3 — attach onto existing base cards by order.
    fh = {"v1": "front_html_v1", "v2": "front_html_v2", "v3": "front_html_v3"}[card_version]
    ex = {"v1": "extra_v1", "v2": "extra_v2", "v3": "extra_v3"}[card_version]
    base = db.query(Card).filter(Card.section_id == section.id).order_by(Card.card_number).all()
    for i, c in enumerate(cards):
        if i < len(base):
            setattr(base[i], fh, c["front_html"])
            setattr(base[i], ex, c.get("extra"))
    db.commit()
