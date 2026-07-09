"""Generate & Verify router — own flow, own job table (verify_jobs). Produces
normal Card rows in the chosen version, plus a downloadable report of every
stage. Isolated from /api/generate and /api/sbs."""
import logging

from fastapi import APIRouter, Depends, HTTPException, BackgroundTasks
from pydantic import BaseModel
from typing import Optional
from sqlalchemy.orm import Session

from backend.db import get_db, SessionLocal
from backend.models import VerifyJob, Section, Curriculum, RuleSet, utcnow
from backend.config import DEFAULT_MODEL
from backend.services.verify_generator import generate_and_verify, build_verify_report_md
from backend.routers.sbs import _persist_cards  # reuse the same card persistence

logger = logging.getLogger(__name__)
router = APIRouter()


class StartReq(BaseModel):
    section_id: int
    rule_set_id: Optional[int] = None  # generation rule set; default = the default one
    card_version: str = "base"
    model: str = DEFAULT_MODEL


def _job_dict(j: VerifyJob) -> dict:
    return {
        "id": j.id, "section_id": j.section_id, "status": j.status, "phase": j.phase,
        "total_cards": j.total_cards, "error_message": j.error_message,
        "card_version": j.card_version, "trace": j.trace,
    }


@router.post("/start")
def start(body: StartReq, background_tasks: BackgroundTasks, db: Session = Depends(get_db)):
    section = db.get(Section, body.section_id)
    if not section:
        raise HTTPException(404, "Section not found")
    job = VerifyJob(
        section_id=body.section_id, rule_set_id=body.rule_set_id,
        card_version=body.card_version, model=body.model, status="pending", phase="generate",
    )
    db.add(job); db.commit(); db.refresh(job)
    background_tasks.add_task(_run_verify_job, job.id)
    return _job_dict(job)


@router.get("/jobs/{job_id}")
def get_job(job_id: int, db: Session = Depends(get_db)):
    j = db.get(VerifyJob, job_id)
    if not j:
        raise HTTPException(404)
    return _job_dict(j)


@router.get("/jobs/{job_id}/report")
def download_report(job_id: int, db: Session = Depends(get_db)):
    from fastapi.responses import Response
    import re as _re
    j = db.get(VerifyJob, job_id)
    if not j:
        raise HTTPException(404)
    if not j.trace:
        raise HTTPException(400, "No trace yet — the job hasn't finished.")
    section = db.get(Section, j.section_id)
    heading = section.heading if section else f"section-{j.section_id}"
    final = (j.trace[-1].get("final_cards") if j.trace and isinstance(j.trace[-1], dict) else None) or []
    md = build_verify_report_md(heading, j.model, [t for t in j.trace if t.get("stage") != "_final"], final)
    safe = _re.sub(r"[^\w\- ]", "_", heading).strip()[:80] or "section"
    return Response(content=md, media_type="text/markdown",
                    headers={"Content-Disposition": f'attachment; filename="{safe} Verify.md"'})


def _run_verify_job(job_id: int):
    db = SessionLocal()
    try:
        job = db.get(VerifyJob, job_id)
        if not job:
            return
        job.status = "running"; db.commit()
        section = db.get(Section, job.section_id)
        if not section:
            job.status = "failed"; job.error_message = "Section missing"; db.commit(); return

        # Resolve the generation rule set (explicit, else the default one).
        rs = None
        if job.rule_set_id:
            rs = db.get(RuleSet, job.rule_set_id)
        if rs is None:
            rs = (db.query(RuleSet).filter_by(rule_type="generation", is_default=True).first()
                  or db.query(RuleSet).filter_by(rule_type="generation").first())
        if rs is None:
            job.status = "failed"; job.error_message = "No generation rule set found"; db.commit(); return

        cur_version = None
        if section.curriculum_topic_id:
            c = db.get(Curriculum, section.curriculum_topic_id)
            cur_version = c.version if c else None

        section_data = {
            "id": section.id, "heading": section.heading,
            "content_source": section.content_source, "content_html": section.content_html,
            "content_text": section.content_text, "heading_tree": section.heading_tree,
            "curriculum_topic_path": section.curriculum_topic_path,
            "curriculum_version": cur_version,
        }

        final, trace = generate_and_verify(section_data, rs.content, job.model)

        # Stash final cards in the trace so the report endpoint can render them.
        trace.append({"stage": "_final", "final_cards": final})
        job.trace = trace; job.phase = "persist"; db.commit()

        _persist_cards(db, section, final, job.card_version, cur_version)

        job.total_cards = len(final)
        job.status = "done"; job.phase = "done"; job.finished_at = utcnow()
        db.commit()
    except Exception as e:
        logger.exception("Verify job %d failed", job_id)
        try:
            job = db.get(VerifyJob, job_id)
            if job:
                job.status = "failed"
                job.error_message = f"{type(e).__name__}: {e}"[:500]
                db.commit()
        except Exception:
            pass
    finally:
        db.close()
